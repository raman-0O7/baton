import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import {
  InMemoryIngestionStore,
  InMemoryRetrievalStore,
  InMemoryWorkThreadStore,
} from '@baton/database';
import {
  ApiProblemSchema,
  ConsentRecordSchema,
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  DeviceAuthorizationResponseSchema,
  ProjectReindexResultSchema,
  ProjectSchema,
  RetrievalResultSchema,
  ThreadContextSchema,
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

const pepper = 'retrieval-test-pepper-longer-than-thirty-two-characters-x';
const cookieSecret =
  'retrieval-test-cookie-secret-longer-than-thirty-two-characters';
const policy: CollectionPolicy = {
  policyVersion: '2026-08-05-ret',
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

describe('Phase 4 retrieval and context gate', () => {
  const ingestion = new InMemoryIngestionStore();
  const workThreads = new InMemoryWorkThreadStore(ingestion);
  const retrieval = new InMemoryRetrievalStore(ingestion);
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
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('reindexes, searches, and compiles cited thread context with much less than the transcript', async () => {
    const app = await appPromise;
    const cookie = await webLogin('devon');
    const device = await registerDevice(cookie, 'laptop');
    const projectId = await createProject(device, 'Greeting');
    const session = '018f0f90-2000-7000-8000-0000000000a1';
    await seedSource(device, projectId, {
      installationId: '018f0f90-1000-7000-8000-0000000000a1',
      sourceSessionId: session,
      payloads: [
        {
          kind: 'message',
          role: 'assistant',
          text: 'Renamed the Greet function to Hello for API clarity.',
        },
        {
          kind: 'file_change',
          path: 'greet.go',
          operation: 'edit',
          summary: 'rename Greet to Hello',
        },
        { kind: 'task', text: 'Add unit tests', status: 'pending' },
        {
          kind: 'decision',
          summary: 'Rename to Hello',
          rationale: 'clearer API',
        },
      ],
    });

    const reindex = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/reindex`,
      headers: bearer(device.token.accessToken),
    });
    expect(reindex.statusCode).toBe(200);
    expect(ProjectReindexResultSchema.parse(reindex.json()).indexedChunks).toBe(
      4,
    );

    const search = await app.inject({
      method: 'GET',
      url: `/v1/retrieval/search?projectId=${projectId}&query=${encodeURIComponent('What happened to the Greet function name?')}`,
      headers: bearer(device.token.accessToken),
    });
    expect(search.statusCode).toBe(200);
    const result = RetrievalResultSchema.parse(search.json());
    expect(result.lexicalFallback).toBe(true);
    expect(result.chunks.some((chunk) => chunk.text.includes('Hello'))).toBe(
      true,
    );

    // Build a thread from the session and compile continuation context.
    const thread = WorkThreadSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work-threads',
          headers: bearer(device.token.accessToken),
          payload: { projectId, title: 'Rename greeting API', goal: null },
        })
      ).json(),
    );
    await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(device.token.accessToken),
      payload: { sourceSessionId: session, assignment: 'confirmed' },
    });

    const contextResponse = await app.inject({
      method: 'GET',
      url: `/v1/work-threads/${thread.workThreadId}/context?query=${encodeURIComponent('Greet rename')}&tokenBudget=400`,
      headers: bearer(device.token.accessToken),
    });
    expect(contextResponse.statusCode).toBe(200);
    const context = ThreadContextSchema.parse(contextResponse.json());
    // Bootstrap carries thread identity + MCP instruction.
    expect(context.bootstrap.text).toContain('Rename greeting API');
    expect(context.bootstrap.text).toContain('Baton MCP');
    // Evidence is cited and within budget.
    expect(context.evidence.tokenEstimate).toBeLessThanOrEqual(400);
    expect(context.evidence.citations.length).toBeGreaterThan(0);
    expect(context.evidence.text).toContain('Hello');
    for (const citation of context.evidence.citations) {
      expect(context.evidence.text).toContain(`[${citation.marker}]`);
      expect(citation.sourceEventIds.length).toBeGreaterThan(0);
    }

    // A second tenant cannot search the project.
    const otherCookie = await webLogin('mallory');
    const otherDevice = await registerDevice(otherCookie, 'intruder');
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/retrieval/search?projectId=${projectId}&query=greet`,
      headers: bearer(otherDevice.token.accessToken),
    });
    expect(denied.statusCode).toBe(404);
    expect(ApiProblemSchema.parse(denied.json()).code).toBe('not_found');
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
    const base = Date.parse('2026-08-05T10:00:00Z');
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
            clientVersion: '0.4.0',
            platform: 'test',
            requestedScopes: [
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
