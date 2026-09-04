import { BatonCloudClient } from '@baton/cloud-client';
import type { SourceEventInput } from '@baton/protocol';
import {
  COLLECTION_DISCLOSURE_DIGEST,
  COLLECTION_DISCLOSURE_VERSION,
  DEFAULT_COLLECTION_POLICY,
  InstallationMap,
  MemoryInstallationStore,
  type EventSource,
  type ProjectBinding,
  type ProjectCanonicalizer,
  type ProjectIdentity,
  type SourceReadLimit,
  type SourceReadResult,
  type SourceSessionRef,
} from '@baton/sync';
import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../src/cli.js';
import { MemoryCredentialStore } from '../src/credentials.js';

const userId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const accessToken = `bat_at_${'a'.repeat(40)}`;
const refreshToken = `bat_rt_${'r'.repeat(40)}`;
const projectId = '55555555-5555-4555-8555-555555555555';
const consentRecordId = '88888888-8888-4888-8888-888888888888';
const projectIdentity = `project:v1:${'b'.repeat(64)}` as ProjectIdentity;

describe('cloud CLI', () => {
  it('completes the device flow and never prints credentials', async () => {
    const store = new MemoryCredentialStore();
    const output: string[] = [];
    let polls = 0;
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/oauth/device/authorize') {
        return Response.json({
          deviceCode: 'd'.repeat(40),
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://app.example.com/activate',
          verificationUriComplete:
            'https://app.example.com/activate?user_code=ABCD-EFGH',
          expiresIn: 900,
          interval: 1,
        });
      }
      polls += 1;
      if (polls === 1) {
        return Response.json(
          {
            type: 'https://baton.dev/problems/authorization-pending',
            title: 'Authorization pending',
            status: 400,
            code: 'authorization_pending',
            requestId: 'request-1',
            retryAfterSeconds: 1,
          },
          { status: 400 },
        );
      }
      return Response.json(tokenPayload());
    };
    const result = await runCli(['login', '--device-name', 'Test laptop'], {
      apiUrl: 'https://api.example.com',
      store,
      io: collectingIo(output),
      createClient: (baseUrl) => new BatonCloudClient({ baseUrl, fetcher }),
      sleep: async () => {},
      now: () => 1_000,
    });
    expect(result).toBe(0);
    expect((await store.load())?.deviceId).toBe(deviceId);
    expect(output.join('\n')).toContain('ABCD-EFGH');
    expect(output.join('\n')).not.toContain(accessToken);
    expect(output.join('\n')).not.toContain(refreshToken);
  });

  it('rotates an expired access token before whoami', async () => {
    const store = new MemoryCredentialStore();
    await store.save({
      apiBaseUrl: 'https://api.example.com',
      accessToken: `bat_at_${'x'.repeat(40)}`,
      refreshToken,
      expiresAt: 1,
      userId,
      tenantId,
      deviceId,
    });
    const output: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/oauth/token') return Response.json(tokenPayload());
      if (path === '/v1/account') {
        return Response.json({
          userId,
          tenantId,
          email: 'ada@example.com',
          displayName: 'Ada Lovelace',
          currentDeviceId: deviceId,
        });
      }
      return new Response(null, { status: 404 });
    };
    const result = await runCli(['whoami'], {
      apiUrl: 'https://api.example.com',
      store,
      io: collectingIo(output),
      createClient: (baseUrl) => new BatonCloudClient({ baseUrl, fetcher }),
      now: () => 10_000,
    });
    expect(result).toBe(0);
    expect(output).toContain('Ada Lovelace <ada@example.com>');
    expect((await store.load())?.accessToken).toBe(accessToken);
  });

  it('reports offline and unauthenticated state from doctor', async () => {
    const output: string[] = [];
    const result = await runCli(['doctor'], {
      apiUrl: 'https://api.example.com',
      store: new MemoryCredentialStore(),
      io: collectingIo(output),
      createClient: (baseUrl) =>
        new BatonCloudClient({
          baseUrl,
          fetcher: async () => {
            throw new Error('offline');
          },
        }),
    });
    expect(result).toBe(2);
    expect(output).toContain('Cloud reachability: failed');
    expect(output).toContain('Authentication: not logged in');
  });

  it('requires affirmative project consent and baselines with zero upload', async () => {
    const store = await loggedInStore();
    const output: string[] = [];
    let projectInstallationId = '';
    let ingestionRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health/ready') return Response.json({ ok: true });
      if (url.pathname === '/v1/projects') {
        return Response.json({
          projectId,
          displayName: 'Baton',
          state: 'enabled',
          collectionPolicy: collectionPolicy(),
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        });
      }
      if (url.pathname === `/v1/projects/${projectId}/consents`) {
        const body = JSON.parse(String(init?.body)) as {
          projectInstallationId: string;
        };
        projectInstallationId = body.projectInstallationId;
        return Response.json({
          ...body,
          consentRecordId,
          projectId,
          deviceId,
          historicalImport: false,
          capturedAt: '2026-08-02T00:00:00.000Z',
          effectiveAt: '2026-08-02T00:00:00.000Z',
          revokedAt: null,
        });
      }
      if (url.pathname === '/v1/ingestion/batches') ingestionRequests += 1;
      return new Response(null, { status: 404 });
    };
    const runtime = testSyncRuntime();
    const result = await runCli(['enable', '/work/project', '--yes'], {
      apiUrl: 'https://api.example.com',
      store,
      io: collectingIo(output),
      syncRuntime: runtime,
      createClient: (baseUrl) => new BatonCloudClient({ baseUrl, fetcher }),
    });

    expect(result).toBe(0);
    expect(ingestionRequests).toBe(0);
    expect(projectInstallationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await runtime.installations.get(projectIdentity)).toMatchObject({
      baselineState: 'complete',
      state: 'enabled',
      projectInstallationId,
      consent: { consentRecordId },
    });
    expect(output.join('\n')).toContain('Existing conversations were skipped');
  });

  it('does not create cloud state when enablement is declined', async () => {
    const output: string[] = [];
    let requests = 0;
    const result = await runCli(['enable', '/work/project'], {
      apiUrl: 'https://api.example.com',
      store: await loggedInStore(),
      io: collectingIo(output),
      syncRuntime: testSyncRuntime(),
      confirmEnable: async () => false,
      createClient: (baseUrl) =>
        new BatonCloudClient({
          baseUrl,
          fetcher: async () => {
            requests += 1;
            return new Response(null, { status: 500 });
          },
        }),
    });
    expect(result).toBe(1);
    expect(requests).toBe(0);
    expect(output.join('\n')).toContain('nothing was collected');
  });

  it('previews a cloud migration as a read-only dry run', async () => {
    const output: string[] = [];
    const result = await runCli(['migrate', 'cloud', '--dry-run'], {
      apiUrl: 'https://api.example.com',
      store: new MemoryCredentialStore(),
      io: collectingIo(output),
    });
    expect(result).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain('Nothing is uploaded, moved, or deleted');
  });

  it('refuses a non-dry-run migration', async () => {
    const output: string[] = [];
    const result = await runCli(['migrate', 'cloud'], {
      apiUrl: 'https://api.example.com',
      store: new MemoryCredentialStore(),
      io: collectingIo(output),
    });
    expect(result).toBe(2);
    expect(output.join('\n')).toContain('--dry-run');
  });

  it('disables locally before an offline cloud revocation attempt', async () => {
    const runtime = testSyncRuntime();
    await runtime.installations.enable({
      localPath: '/work/project',
      projectInstallationId: '66666666-6666-4666-8666-666666666666',
      cloudProjectId: projectId,
      deviceId,
      displayName: 'Baton',
      detectedAgents: ['codex'],
      consentRecordId,
      collectionPolicy: structuredClone(DEFAULT_COLLECTION_POLICY),
      disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
      disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      affirmativeEnable: true,
    });
    const output: string[] = [];
    const result = await runCli(['disable', '/work/project'], {
      apiUrl: 'https://api.example.com',
      store: new MemoryCredentialStore(),
      io: collectingIo(output),
      syncRuntime: runtime,
    });

    expect(result).toBe(1);
    expect(await runtime.installations.get(projectIdentity)).toMatchObject({
      state: 'disabled',
      baselineState: 'pending',
      consent: { revokedAt: expect.any(String) },
    });
    expect(output.join('\n')).toContain('disabled locally');
  });

  it('ranks continuable work threads and recommends the top suggestion', async () => {
    const runtime = await enabledRuntime();
    const output: string[] = [];
    const threadA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const threadB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/work-threads') {
        return Response.json({
          workThreads: [
            workThread(threadA, 'Older thread', '2026-08-01T00:00:00.000Z'),
            workThread(
              threadB,
              'Hosted authentication',
              '2026-08-05T09:00:00.000Z',
            ),
          ],
        });
      }
      if (url.pathname.endsWith('/thread-suggestions')) {
        return Response.json({
          sourceSessionId: null,
          suggestions: [
            {
              workThread: workThread(
                threadB,
                'Hosted authentication',
                '2026-08-05T09:00:00.000Z',
              ),
              score: 0.25,
              reasons: ['recent_activity'],
              sharedFilePaths: [],
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    };
    const result = await runCli(['continue', '/work/project'], {
      apiUrl: 'https://api.example.com',
      store: await loggedInStore(),
      io: collectingIo(output),
      syncRuntime: runtime,
      createClient: (baseUrl) => new BatonCloudClient({ baseUrl, fetcher }),
    });
    expect(result).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('Continue work in Baton?');
    expect(text).toContain('1. Hosted authentication');
    expect(text).toContain('[recommended]');
    expect(text).toContain(`baton continue --thread ${threadB}`);
  });

  it('prints a compact bootstrap for an explicitly selected thread', async () => {
    const runtime = await enabledRuntime();
    const output: string[] = [];
    const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/work-threads') {
        return Response.json({
          workThreads: [
            workThread(
              threadId,
              'Hosted authentication',
              '2026-08-05T09:00:00.000Z',
            ),
          ],
        });
      }
      if (url.pathname.endsWith(`/work-threads/${threadId}/overview`)) {
        return Response.json({
          workThread: workThread(
            threadId,
            'Hosted authentication',
            '2026-08-05T09:00:00.000Z',
          ),
          sessions: [],
          tasks: [
            {
              text: 'Finish token exchange',
              status: 'in_progress',
              eventId: '99999999-9999-4999-8999-999999999999',
              occurredAt: '2026-08-05T09:00:00.000Z',
            },
          ],
          decisions: [
            {
              summary: 'Use device authorization grant',
              rationale: null,
              eventId: '99999999-9999-4999-8999-999999999998',
              occurredAt: '2026-08-05T09:00:00.000Z',
            },
          ],
          fileActivities: [],
          errors: [],
          eventCount: 2,
          lastActivityAt: '2026-08-05T09:00:00.000Z',
        });
      }
      return new Response(null, { status: 404 });
    };
    const result = await runCli(
      ['continue', '/work/project', '--thread', threadId],
      {
        apiUrl: 'https://api.example.com',
        store: await loggedInStore(),
        io: collectingIo(output),
        syncRuntime: runtime,
        createClient: (baseUrl) => new BatonCloudClient({ baseUrl, fetcher }),
      },
    );
    expect(result).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('Work thread: Hosted authentication');
    expect(text).toContain('Use device authorization grant');
    expect(text).toContain('Finish token exchange');
  });
});

const canonicalizer: ProjectCanonicalizer = {
  canonicalize: async () => ({
    canonicalLocalPath: '/work/project',
    projectIdentity,
  }),
};

function testSyncRuntime() {
  return {
    installations: new InstallationMap(
      new MemoryInstallationStore(),
      canonicalizer,
      () => new Date('2026-08-02T00:00:00.000Z'),
    ),
    eventSources: [new BaselineEventSource()],
    detectedAgents: ['codex' as const],
  };
}

async function enabledRuntime() {
  const runtime = testSyncRuntime();
  await runtime.installations.enable({
    localPath: '/work/project',
    projectInstallationId: '66666666-6666-4666-8666-666666666666',
    cloudProjectId: projectId,
    deviceId,
    displayName: 'Baton',
    detectedAgents: ['codex'],
    consentRecordId,
    collectionPolicy: structuredClone(DEFAULT_COLLECTION_POLICY),
    disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
    disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
    cloudProcessingAcknowledged: true,
    modelProcessingAcknowledged: true,
    captureSurface: 'cli',
    affirmativeEnable: true,
  });
  return runtime;
}

function workThread(workThreadId: string, title: string, updatedAt: string) {
  return {
    workThreadId,
    projectId,
    title,
    goal: null,
    state: 'active' as const,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt,
  };
}

class BaselineEventSource implements EventSource {
  readonly name = 'codex' as const;

  async discover(_binding: ProjectBinding): Promise<SourceSessionRef[]> {
    return [
      {
        key: 'source-1',
        sourceSessionId: '99999999-9999-4999-8999-999999999999',
        nativeSessionHash: 'a'.repeat(64),
        parserVersion: 'test-v1',
      },
    ];
  }

  async readSince(
    _binding: ProjectBinding,
    _ref: SourceSessionRef,
    cursor: string | null,
    _limit: SourceReadLimit,
  ): Promise<SourceReadResult> {
    const events: SourceEventInput[] = [];
    return {
      events,
      previousCursor: cursor,
      proposedCursor: 'baseline-cursor',
      hasMore: false,
    };
  }

  async currentCursor(): Promise<string> {
    return 'baseline-cursor';
  }

  async fingerprint(): Promise<string> {
    return `sha256:1:${'a'.repeat(64)}`;
  }
}

function collectionPolicy() {
  return {
    policyVersion: 'hosted-default-v1',
    allowedCategories: [
      'conversation_text',
      'plans_and_tasks',
      'command_arguments',
      'tool_results',
      'file_paths',
      'diffs',
      'session_metadata',
    ],
    excludedPathPatterns: [
      '.env',
      '.env.*',
      '**/.env',
      '**/.env.*',
      '**/*credential*',
      '**/*secret*',
      '**/*.pem',
      '**/*.key',
    ],
    maxToolResultBytes: 65_536,
    maxDiffBytes: 131_072,
  };
}

async function loggedInStore(): Promise<MemoryCredentialStore> {
  const store = new MemoryCredentialStore();
  await store.save({
    apiBaseUrl: 'https://api.example.com',
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 60_000,
    userId,
    tenantId,
    deviceId,
  });
  return store;
}

function collectingIo(output: string[]): CliIo {
  return {
    out: (message) => output.push(message),
    error: (message) => output.push(message),
  };
}

function tokenPayload() {
  return {
    tokenType: 'Bearer' as const,
    accessToken,
    expiresIn: 900,
    refreshToken,
    scopes: ['account:read', 'devices:read', 'devices:write', 'ingest:write'],
    userId,
    tenantId,
    deviceId,
  };
}
