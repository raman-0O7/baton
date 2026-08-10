import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import {
  InMemoryIngestionStore,
  InMemoryLifecycleStore,
  InMemoryMemoryStore,
  InMemoryRetrievalStore,
  InMemoryWorkThreadStore,
} from '@baton/database';
import {
  ApiProblemSchema,
  ConsentRecordSchema,
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  DeletionReceiptSchema,
  DeviceAuthorizationResponseSchema,
  ExportArchiveSchema,
  ProjectSchema,
  TokenResponseSchema,
  WorkThreadSchema,
  type CollectionPolicy,
  type IngestionBatch,
  type SourceEvent,
  type SourceEventPayload,
  type TokenResponse,
} from '@baton/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'lifecycle-e2e-pepper-longer-than-thirty-two-characters-xyz';
const cookieSecret =
  'lifecycle-e2e-cookie-secret-longer-than-thirty-two-characters-x';
const policy: CollectionPolicy = {
  policyVersion: '2026-08-06-lc',
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

describe('Phase 7 export and deletion gate', () => {
  const ingestion = new InMemoryIngestionStore();
  const workThreads = new InMemoryWorkThreadStore(ingestion);
  const retrieval = new InMemoryRetrievalStore(ingestion);
  const memory = new InMemoryMemoryStore();
  const lifecycle = new InMemoryLifecycleStore(
    ingestion,
    workThreads,
    retrieval,
    memory,
  );
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
    retrievalStore: retrieval,
    memoryStore: memory,
    lifecycleStore: lifecycle,
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('exports the account, deletes a project, and proves the content is gone', async () => {
    const app = await appPromise;
    const cookie = await webLogin('devon');
    const device = await registerDevice(cookie, 'laptop');
    const projectId = await createProject(device, 'Greeting');
    const session = '018f0f90-2000-7000-8000-0000000000a1';
    await seedSource(device, projectId, {
      installationId: '018f0f90-1000-7000-8000-0000000000a1',
      sourceSessionId: session,
      payloads: [
        { kind: 'message', role: 'assistant', text: 'Renamed Greet to Hello.' },
        { kind: 'decision', summary: 'Use Hello', rationale: 'clarity' },
      ],
    });
    const thread = WorkThreadSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work-threads',
          headers: bearer(device.token.accessToken),
          payload: { projectId, title: 'Rename greeting', goal: null },
        })
      ).json(),
    );
    await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(device.token.accessToken),
      payload: { sourceSessionId: session, assignment: 'confirmed' },
    });

    // Export the whole account.
    const exportResponse = await app.inject({
      method: 'GET',
      url: '/v1/account/export',
      headers: { cookie },
    });
    expect(exportResponse.statusCode).toBe(200);
    const archive = ExportArchiveSchema.parse(exportResponse.json());
    expect(archive.projects.map((p) => p.projectId)).toContain(projectId);
    expect(archive.workThreads).toHaveLength(1);
    expect(archive.events).toHaveLength(2);

    // Account deletion is refused for a device token.
    const deviceDelete = await app.inject({
      method: 'POST',
      url: '/v1/account/delete',
      headers: bearer(device.token.accessToken),
    });
    expect(deviceDelete.statusCode).toBe(403);
    expect(ApiProblemSchema.parse(deviceDelete.json()).code).toBe(
      'access_denied',
    );

    // Delete the project and verify it is gone from every read path.
    const deleteResponse = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/delete`,
      headers: bearer(device.token.accessToken),
    });
    expect(deleteResponse.statusCode).toBe(200);
    const receipt = DeletionReceiptSchema.parse(deleteResponse.json());
    expect(receipt.complete).toBe(true);
    expect(receipt.deletedCounts.events).toBe(2);

    const projects = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: bearer(device.token.accessToken),
    });
    expect((projects.json() as { projects: unknown[] }).projects).toHaveLength(
      0,
    );
    const threadsAfter = await app.inject({
      method: 'GET',
      url: `/v1/work-threads?projectId=${projectId}`,
      headers: bearer(device.token.accessToken),
    });
    expect(threadsAfter.statusCode).toBe(404);
  });

  it('deletes an entire account from the dashboard session', async () => {
    const app = await appPromise;
    const cookie = await webLogin('rae');
    const device = await registerDevice(cookie, 'workstation');
    const projectId = await createProject(device, 'Second');
    await seedSource(device, projectId, {
      installationId: '018f0f90-1000-7000-8000-0000000000b2',
      sourceSessionId: '018f0f90-2000-7000-8000-0000000000b2',
      payloads: [{ kind: 'message', role: 'user', text: 'hello' }],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/account/delete',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const receipt = DeletionReceiptSchema.parse(response.json());
    expect(receipt.scope).toBe('account');
    expect(receipt.deletedCounts.projects).toBe(1);
    const projects = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: bearer(device.token.accessToken),
    });
    expect((projects.json() as { projects: unknown[] }).projects).toHaveLength(
      0,
    );
  });

  async function createProject(
    device: { token: TokenResponse },
    name: string,
  ): Promise<string> {
    const app = await appPromise;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: bearer(device.token.accessToken),
      payload: { displayName: name, collectionPolicy: policy },
    });
    return ProjectSchema.parse(response.json()).projectId;
  }

  async function seedSource(
    device: { token: TokenResponse },
    projectId: string,
    options: {
      installationId: string;
      sourceSessionId: string;
      payloads: SourceEventPayload[];
    },
  ): Promise<void> {
    const app = await appPromise;
    const consent = ConsentRecordSchema.parse(
      (
        await app.inject({
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
        })
      ).json(),
    );
    const base = Date.parse('2026-08-06T10:00:00Z');
    const events: SourceEvent[] = options.payloads.map((payload, index) =>
      createSourceEvent({
        sourceSessionId: options.sourceSessionId,
        workThreadId: null,
        sourceAgent: 'claudecode',
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
        agent: 'claudecode',
        nativeSessionHash: 'a'.repeat(64),
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
  ): Promise<{ token: TokenResponse }> {
    const app = await appPromise;
    const grant = DeviceAuthorizationResponseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/oauth/device/authorize',
          payload: {
            clientId: 'baton-cli',
            clientName,
            clientVersion: '0.7.0',
            platform: 'test',
            requestedScopes: [
              'account:read',
              'projects:read',
              'projects:write',
              'ingest:write',
              'work:read',
            ],
          },
        })
      ).json(),
    );
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
