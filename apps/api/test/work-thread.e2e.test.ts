import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import {
  InMemoryIngestionStore,
  InMemoryWorkThreadStore,
} from '@baton/database';
import {
  ApiProblemSchema,
  ConsentRecordSchema,
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  DeviceAuthorizationResponseSchema,
  EventReadbackSchema,
  ProjectSchema,
  ThreadSuggestionListSchema,
  TokenResponseSchema,
  WorkThreadOverviewSchema,
  WorkThreadSchema,
  WorkThreadSessionListSchema,
  WorkThreadSessionSchema,
  type AgentName,
  type CollectionPolicy,
  type IngestionBatch,
  type SourceEvent,
  type SourceEventPayload,
  type TokenResponse,
} from '@baton/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'work-thread-test-pepper-longer-than-thirty-two-characters';
const cookieSecret =
  'work-thread-test-cookie-secret-longer-than-thirty-two-characters';
const policy: CollectionPolicy = {
  policyVersion: '2026-08-05',
  allowedCategories: [
    'conversation_text',
    'plans_and_tasks',
    'command_arguments',
    'tool_results',
    'file_paths',
    'diffs',
    'session_metadata',
  ],
  excludedPathPatterns: ['**/.env'],
  maxToolResultBytes: 65_536,
  maxDiffBytes: 262_144,
};

class FakeIdentityProvider implements WebIdentityProvider {
  authorizationUrl(input: { state: string }): URL {
    const url = new URL('https://identity.example.com/authorize');
    url.searchParams.set('state', input.state);
    return url;
  }

  async exchange(input: { code: string }) {
    return {
      issuer: 'https://identity.example.com',
      subject: input.code,
      email: `${input.code}@example.com`,
      displayName: input.code,
    };
  }
}

interface Device {
  token: TokenResponse;
}

describe('Phase 3 cross-agent work-thread gate', () => {
  const ingestion = new InMemoryIngestionStore();
  const workThreads = new InMemoryWorkThreadStore(ingestion);
  const identity = new IdentityService(new InMemoryIdentityStore(), {
    tokenPepper: pepper,
    verificationUri: 'http://dashboard.example.test/activate',
    devicePollingIntervalSeconds: 1,
  });
  const appPromise = buildApi({
    identity,
    identityProvider: new FakeIdentityProvider(),
    ingestionStore: ingestion,
    workThreadStore: workThreads,
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('continues a Claude thread in Codex on a second device as one confirmed thread', async () => {
    const cookie = await webLogin('devon');
    const deviceA = await registerDevice(cookie, 'laptop');
    const deviceB = await registerDevice(cookie, 'desktop');

    const projectId = await createProject(deviceA, 'Hosted auth');
    const claudeSession = '018f0f90-2000-7000-8000-0000000000a1';
    const codexSession = '018f0f90-2000-7000-8000-0000000000b2';

    await seedSource(deviceA, projectId, {
      installationId: '018f0f90-1000-7000-8000-0000000000a1',
      sourceSessionId: claudeSession,
      agent: 'claudecode',
      nativeSessionHash: 'a'.repeat(64),
      payloads: [
        {
          kind: 'session_metadata',
          title: 'Auth in Claude',
          gitBranch: 'feat/auth',
        },
        { kind: 'message', role: 'user', text: 'Add OAuth device login.' },
        {
          kind: 'file_change',
          path: 'src/auth.ts',
          operation: 'create',
          summary: 'new',
        },
        {
          kind: 'decision',
          summary: 'Use device authorization grant',
          rationale: 'CLI',
        },
      ],
    });
    await seedSource(deviceB, projectId, {
      installationId: '018f0f90-1000-7000-8000-0000000000b2',
      sourceSessionId: codexSession,
      agent: 'codex',
      nativeSessionHash: 'b'.repeat(64),
      payloads: [
        {
          kind: 'session_metadata',
          title: 'Auth in Codex',
          gitBranch: 'feat/auth',
        },
        { kind: 'file_change', path: 'src/auth.ts', operation: 'edit' },
        {
          kind: 'task',
          nativeTaskId: 't1',
          text: 'Finish token exchange',
          status: 'in_progress',
        },
      ],
    });

    const app = await appPromise;

    // Create the thread and confirm the Claude session belongs to it.
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/work-threads',
      headers: bearer(deviceA.token.accessToken),
      payload: {
        projectId,
        title: 'Implement hosted authentication',
        goal: null,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const thread = WorkThreadSchema.parse(createResponse.json());

    const assignClaude = await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(deviceA.token.accessToken),
      payload: { sourceSessionId: claudeSession, assignment: 'confirmed' },
    });
    expect(assignClaude.statusCode).toBe(201);
    WorkThreadSessionSchema.parse(assignClaude.json());

    // The second device's Codex session is suggested for the same thread.
    const suggestResponse = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/thread-suggestions?sourceSessionId=${codexSession}`,
      headers: bearer(deviceA.token.accessToken),
    });
    expect(suggestResponse.statusCode).toBe(200);
    const suggestions = ThreadSuggestionListSchema.parse(
      suggestResponse.json(),
    );
    expect(suggestions.suggestions[0]?.workThread.workThreadId).toBe(
      thread.workThreadId,
    );
    expect(suggestions.suggestions[0]?.reasons).toEqual(
      expect.arrayContaining(['shared_files', 'same_branch']),
    );

    // The user confirms the suggested join.
    await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(deviceA.token.accessToken),
      payload: { sourceSessionId: codexSession, assignment: 'suggested' },
    });
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(deviceA.token.accessToken),
      payload: { sourceSessionId: codexSession, assignment: 'confirmed' },
    });
    expect(WorkThreadSessionSchema.parse(confirm.json()).assignment).toBe(
      'confirmed',
    );

    // One thread, both source histories retained.
    const sessionsResponse = await app.inject({
      method: 'GET',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(deviceA.token.accessToken),
    });
    const sessions = WorkThreadSessionListSchema.parse(sessionsResponse.json());
    expect(
      sessions.sessions.map((s) => s.sourceSession.sourceAgent).sort(),
    ).toEqual(['claudecode', 'codex']);

    const eventsResponse = await app.inject({
      method: 'GET',
      url: `/v1/work-threads/${thread.workThreadId}/events?limit=500`,
      headers: bearer(deviceA.token.accessToken),
    });
    const readback = EventReadbackSchema.parse(eventsResponse.json());
    expect(new Set(readback.events.map((e) => e.sourceAgent))).toEqual(
      new Set(['claudecode', 'codex']),
    );
    expect(readback.events).toHaveLength(7);
    expect(readback.page.hasMore).toBe(false);

    // Materialized state cites evidence from both agents.
    const overviewResponse = await app.inject({
      method: 'GET',
      url: `/v1/work-threads/${thread.workThreadId}/overview`,
      headers: bearer(deviceA.token.accessToken),
    });
    const overview = WorkThreadOverviewSchema.parse(overviewResponse.json());
    expect(overview.decisions.map((d) => d.summary)).toContain(
      'Use device authorization grant',
    );
    expect(overview.tasks.map((t) => t.text)).toContain(
      'Finish token exchange',
    );

    // The dashboard cookie session can read the thread too (work:read).
    const cookieList = await app.inject({
      method: 'GET',
      url: `/v1/work-threads?projectId=${projectId}`,
      headers: { cookie },
    });
    expect(cookieList.statusCode).toBe(200);

    // A different tenant cannot see the thread.
    const otherCookie = await webLogin('mallory');
    const otherDevice = await registerDevice(otherCookie, 'intruder');
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/work-threads/${thread.workThreadId}/events`,
      headers: bearer(otherDevice.token.accessToken),
    });
    expect(denied.statusCode).toBe(404);
    expect(ApiProblemSchema.parse(denied.json()).code).toBe('not_found');
  });

  it('rejects assigning one source session to two threads', async () => {
    const cookie = await webLogin('rae');
    const device = await registerDevice(cookie, 'workstation');
    const projectId = await createProject(device, 'Second project');
    const session = '018f0f90-2000-7000-8000-0000000000c3';
    await seedSource(device, projectId, {
      installationId: '018f0f90-1000-7000-8000-0000000000c3',
      sourceSessionId: session,
      agent: 'claudecode',
      nativeSessionHash: 'c'.repeat(64),
      payloads: [{ kind: 'message', role: 'user', text: 'hello' }],
    });
    const app = await appPromise;
    const first = WorkThreadSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work-threads',
          headers: bearer(device.token.accessToken),
          payload: { projectId, title: 'One', goal: null },
        })
      ).json(),
    );
    const second = WorkThreadSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work-threads',
          headers: bearer(device.token.accessToken),
          payload: { projectId, title: 'Two', goal: null },
        })
      ).json(),
    );
    await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${first.workThreadId}/sessions`,
      headers: bearer(device.token.accessToken),
      payload: { sourceSessionId: session, assignment: 'confirmed' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${second.workThreadId}/sessions`,
      headers: bearer(device.token.accessToken),
      payload: { sourceSessionId: session, assignment: 'confirmed' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(ApiProblemSchema.parse(conflict.json()).code).toBe('conflict');
  });

  async function createProject(device: Device, name: string): Promise<string> {
    const app = await appPromise;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: bearer(device.token.accessToken),
      payload: { displayName: name, collectionPolicy: policy },
    });
    expect(response.statusCode).toBe(201);
    return ProjectSchema.parse(response.json()).projectId;
  }

  async function seedSource(
    device: Device,
    projectId: string,
    options: {
      installationId: string;
      sourceSessionId: string;
      agent: AgentName;
      nativeSessionHash: string;
      payloads: SourceEventPayload[];
    },
  ): Promise<void> {
    const app = await appPromise;
    const consentResponse = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/consents`,
      headers: bearer(device.token.accessToken),
      payload: {
        projectInstallationId: options.installationId,
        disclosureVersion: currentCollectionDisclosureVersion,
        disclosureDigest: currentCollectionDisclosureDigest,
        collectionPolicy: policy,
        cloudProcessingAcknowledged: true,
        modelProcessingAcknowledged: true,
        captureSurface: 'cli',
        historicalImport: false,
      },
    });
    expect(consentResponse.statusCode).toBe(201);
    const consent = ConsentRecordSchema.parse(consentResponse.json());
    const base = Date.parse('2026-08-05T10:00:00Z');
    const events: SourceEvent[] = options.payloads.map((payload, index) =>
      createSourceEvent({
        sourceSessionId: options.sourceSessionId,
        workThreadId: null,
        sourceAgent: options.agent,
        sourceDeviceId: device.token.deviceId,
        nativeSequence: index,
        parentEventId: null,
        occurredAt: new Date(base + index * 1000).toISOString(),
        observedAt: new Date(base + index * 1000).toISOString(),
        schemaVersion: 1,
        payload,
      }),
    );
    const batch: IngestionBatch = {
      schemaVersion: 1,
      batchId: randomUUID(),
      deviceId: device.token.deviceId,
      projectId,
      projectInstallationId: options.installationId,
      consentRecordId: consent.consentRecordId,
      policyVersion: policy.policyVersion,
      disclosureVersion: currentCollectionDisclosureVersion,
      source: {
        sourceSessionId: options.sourceSessionId,
        agent: options.agent,
        nativeSessionHash: options.nativeSessionHash,
        parserVersion: 'test-v1',
      },
      expectedHeadEventId: null,
      previousCursor: null,
      proposedCursor: 'cursor:1',
      events,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingestion/batches',
      headers: {
        ...bearer(device.token.accessToken),
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(Buffer.from(JSON.stringify(batch))),
    });
    expect(response.statusCode).toBe(202);
  }

  async function webLogin(code: string): Promise<string> {
    const app = await appPromise;
    const login = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login',
    });
    const stateCookie = cookieNamed(
      login.headers['set-cookie'],
      'baton_login_state',
    );
    const state = new URL(required(login.headers.location)).searchParams.get(
      'state',
    );
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/web/callback?code=${code}&state=${encodeURIComponent(required(state))}`,
      headers: { cookie: stateCookie },
    });
    return cookieNamed(callback.headers['set-cookie'], 'baton_session');
  }

  async function registerDevice(
    browserCookie: string,
    clientName: string,
  ): Promise<Device> {
    const app = await appPromise;
    const authorization = await app.inject({
      method: 'POST',
      url: '/oauth/device/authorize',
      payload: {
        clientId: 'baton-cli',
        clientName,
        clientVersion: '0.3.0',
        platform: 'test',
        requestedScopes: [
          'account:read',
          'projects:read',
          'projects:write',
          'ingest:write',
          'work:read',
        ],
      },
    });
    const grant = DeviceAuthorizationResponseSchema.parse(authorization.json());
    await app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: { cookie: browserCookie },
      payload: { userCode: grant.userCode },
    });
    const token = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        clientId: 'baton-cli',
        deviceCode: grant.deviceCode,
      },
    });
    return { token: TokenResponseSchema.parse(token.json()) };
  }
});

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function cookieNamed(
  header: string | string[] | undefined,
  name: string,
): string {
  const cookies = Array.isArray(header)
    ? header
    : header === undefined
      ? []
      : [header];
  for (const entry of cookies) {
    const [pair] = entry.split(';');
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  throw new Error(`missing cookie ${name}`);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}
