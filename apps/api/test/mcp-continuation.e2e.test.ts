import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import { BatonCloudClient } from '@baton/cloud-client';
import {
  InMemoryIngestionStore,
  InMemoryRetrievalStore,
  InMemoryWorkThreadStore,
} from '@baton/database';
import { createBatonMcpServer } from '@baton/mcp';
import {
  ConsentRecordSchema,
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  DeviceAuthorizationResponseSchema,
  ProjectSchema,
  TokenResponseSchema,
  WorkThreadSchema,
  type CollectionPolicy,
  type IngestionBatch,
  type SourceEvent,
  type SourceEventPayload,
  type TokenResponse,
} from '@baton/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'mcp-continuation-pepper-longer-than-thirty-two-characters';
const cookieSecret =
  'mcp-continuation-cookie-secret-longer-than-thirty-two-characters';
const policy: CollectionPolicy = {
  policyVersion: '2026-08-05-mcp',
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

/** Route a web `fetch` through Fastify's in-process injector. */
function injectFetcher(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers,
      ...(init?.body == null ? {} : { payload: init.body as string }),
    });
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') responseHeaders[key] = value;
    }
    const body =
      response.statusCode === 204 || response.rawPayload.length === 0
        ? null
        : response.rawPayload;
    return new Response(body, {
      status: response.statusCode,
      headers: responseHeaders,
    });
  }) as typeof fetch;
}

describe('Phase 5 MCP cross-agent continuation gate', () => {
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

  it('lets a fresh agent resume a thread through MCP with cited context and no cross-project access', async () => {
    const app = await appPromise;
    const cloud = new BatonCloudClient({
      baseUrl: 'http://api.example.test',
      fetcher: injectFetcher(app),
    });

    // Device A (Claude) captures work and opens a thread.
    const cookie = await webLogin('devon');
    const deviceA = await registerDevice(cookie, 'laptop');
    const projectId = await createProject(deviceA, 'Greeting');
    const session = '018f0f90-2000-7000-8000-0000000000a1';
    await seedSource(deviceA, projectId, {
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
        {
          kind: 'decision',
          summary: 'Rename to Hello',
          rationale: 'clearer API',
        },
        { kind: 'task', text: 'Add unit tests', status: 'pending' },
      ],
    });
    const thread = WorkThreadSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work-threads',
          headers: bearer(deviceA.token.accessToken),
          payload: {
            projectId,
            title: 'Rename greeting API',
            goal: 'Hello over Greet',
          },
        })
      ).json(),
    );
    await app.inject({
      method: 'POST',
      url: `/v1/work-threads/${thread.workThreadId}/sessions`,
      headers: bearer(deviceA.token.accessToken),
      payload: { sourceSessionId: session, assignment: 'confirmed' },
    });

    // A different agent/device connects to the Baton MCP server with the
    // account's read credentials and resumes the thread.
    const server = createBatonMcpServer(cloud, deviceA.token.accessToken);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const agent = new Client({ name: 'codex-agent', version: '1.0.0' });
    await agent.connect(clientTransport);

    const context = (await agent.callTool({
      name: 'baton_get_thread_context',
      arguments: { workThreadId: thread.workThreadId, tokenBudget: 400 },
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(context.isError).toBeFalsy();
    const contextText = context.content.map((item) => item.text).join('\n');
    expect(contextText).toContain('Rename greeting API'); // bootstrap identity
    expect(contextText).toContain('Hello'); // cited evidence retrieved
    expect(contextText).toContain('[#1]'); // citation markers present
    expect(contextText).not.toContain(deviceA.token.accessToken);

    const search = (await agent.callTool({
      name: 'baton_search_context',
      arguments: {
        projectId,
        workThreadId: thread.workThreadId,
        query: 'Greet rename',
      },
    })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(search.isError).toBeFalsy();
    expect(search.content[0]!.text).toContain('Hello');

    await agent.close();
    await server.close();

    // A second tenant's agent cannot reach device A's project through MCP.
    const otherCookie = await webLogin('mallory');
    const otherDevice = await registerDevice(otherCookie, 'intruder');
    const intruderServer = createBatonMcpServer(
      cloud,
      otherDevice.token.accessToken,
    );
    const [intruderClientT, intruderServerT] =
      InMemoryTransport.createLinkedPair();
    await intruderServer.connect(intruderServerT);
    const intruder = new Client({ name: 'intruder', version: '1.0.0' });
    await intruder.connect(intruderClientT);
    const denied = (await intruder.callTool({
      name: 'baton_list_threads',
      arguments: { projectId },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).not.toContain('Rename greeting API');
    await intruder.close();
    await intruderServer.close();
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
            clientVersion: '0.5.0',
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
