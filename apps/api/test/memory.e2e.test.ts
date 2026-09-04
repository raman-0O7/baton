import { randomUUID } from 'node:crypto';

import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import { BatonCloudClient } from '@baton/cloud-client';
import { InMemoryMemoryStore } from '@baton/database';
import { createBatonMcpServer } from '@baton/mcp';
import {
  ApiProblemSchema,
  MemoryCandidateSchema,
  MemoryListSchema,
  MemorySchema,
  SoulDocumentSchema,
  type TokenResponse,
} from '@baton/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'memory-e2e-pepper-longer-than-thirty-two-characters-abcdef';
const cookieSecret =
  'memory-e2e-cookie-secret-longer-than-thirty-two-characters-abc';

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

describe('Phase 6 memory approval gate', () => {
  const store = new InMemoryMemoryStore();
  const identity = new IdentityService(new InMemoryIdentityStore(), {
    tokenPepper: pepper,
    verificationUri: 'http://dashboard.example.test/activate',
    devicePollingIntervalSeconds: 1,
  });
  const appPromise = buildApi({
    identity,
    identityProvider: new FakeIdentityProvider(),
    memoryStore: store,
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('only approved memories reach an agent; prohibited and unapproved never do', async () => {
    const app = await appPromise;
    const cookie = await webLogin('devon');

    // A prohibited health inference is recorded as rejected, never approvable.
    const prohibited = MemoryCandidateSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/memory/candidates',
          headers: { cookie },
          payload: {
            category: 'communication_preference',
            claim: 'The user has diabetes.',
            scope: { type: 'global', id: null },
            evidence: [
              {
                eventId: randomUUID(),
                projectId: 'project-c',
                workThreadId: null,
                text: 'Schedule around my insulin appointment.',
              },
            ],
          },
        })
      ).json(),
    );
    expect(prohibited.status).toBe('rejected');
    expect(prohibited.reasonCode).toBe('sensitive_health_inference_prohibited');
    const approveProhibited = await app.inject({
      method: 'POST',
      url: `/v1/memory/candidates/${prohibited.candidateId}/approve`,
      headers: { cookie },
      payload: {},
    });
    expect(approveProhibited.statusCode).toBe(409);

    // An acceptable repeated cross-project preference is proposed, then approved.
    const candidate = MemoryCandidateSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/memory/candidates',
          headers: { cookie },
          payload: {
            category: 'communication_preference',
            claim: 'Prefers concise answers by default.',
            scope: { type: 'global', id: null },
            evidence: [
              {
                eventId: randomUUID(),
                projectId: 'project-a',
                workThreadId: null,
                text: 'Keep answers concise.',
              },
              {
                eventId: randomUUID(),
                projectId: 'project-b',
                workThreadId: null,
                text: 'Concise please.',
              },
            ],
          },
        })
      ).json(),
    );
    expect(candidate.status).toBe('proposed');

    // Before approval, an agent (memory:read) sees nothing.
    const reader = await registerDevice(cookie, 'reader');
    const beforeApproval = await app.inject({
      method: 'GET',
      url: '/v1/memory/memories',
      headers: bearer(reader.token.accessToken),
    });
    expect(MemoryListSchema.parse(beforeApproval.json()).memories).toHaveLength(
      0,
    );

    const memory = MemorySchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/memory/candidates/${candidate.candidateId}/approve`,
          headers: { cookie },
          payload: {},
        })
      ).json(),
    );
    expect(memory.status).toBe('approved');
    expect(memory.evidenceEventIds.length).toBe(2);

    // SOUL renders the approved claim with evidence.
    const soul = SoulDocumentSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/memory/soul',
          headers: bearer(reader.token.accessToken),
        })
      ).json(),
    );
    expect(soul.text).toContain('Prefers concise answers');

    // Through MCP, a fresh agent sees the approved memory but never the
    // rejected health inference.
    const cloud = new BatonCloudClient({
      baseUrl: 'http://api.example.test',
      fetcher: injectFetcher(app),
    });
    const server = createBatonMcpServer(cloud, reader.token.accessToken);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const agent = new Client({ name: 'agent', version: '1.0.0' });
    await agent.connect(clientTransport);
    const memories = (await agent.callTool({
      name: 'baton_get_approved_memories',
      arguments: {},
    })) as { content: Array<{ text: string }> };
    const body = memories.content.map((item) => item.text).join('\n');
    expect(body).toContain('Prefers concise answers');
    expect(body).not.toContain('diabetes');
    await agent.close();
    await server.close();

    // A second tenant sees none of it.
    const otherCookie = await webLogin('mallory');
    const otherReader = await registerDevice(otherCookie, 'other');
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/memory/memories',
      headers: bearer(otherReader.token.accessToken),
    });
    expect(MemoryListSchema.parse(denied.json()).memories).toHaveLength(0);
  });

  it('marks contradictory evidence for review rather than accepting it', async () => {
    const app = await appPromise;
    const cookie = await webLogin('rae');
    const candidate = MemoryCandidateSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/memory/candidates',
          headers: { cookie },
          payload: {
            category: 'communication_preference',
            claim: 'Always wants terse answers.',
            scope: { type: 'global', id: null },
            evidence: [
              {
                eventId: randomUUID(),
                projectId: 'project-a',
                workThreadId: null,
                text: 'Give me just the commands.',
              },
              {
                eventId: randomUUID(),
                projectId: 'project-a',
                workThreadId: null,
                text: 'This is unfamiliar; explain every step in detail.',
              },
            ],
          },
        })
      ).json(),
    );
    expect(candidate.status).toBe('needs_review');
    expect(candidate.reasonCode).toBe('contradictory_contextual_evidence');
  });

  it('rejects a proposal without the memory:write scope', async () => {
    const app = await appPromise;
    const cookie = await webLogin('sam');
    const device = await registerDevice(cookie, 'read-only'); // memory:read only
    const response = await app.inject({
      method: 'POST',
      url: '/v1/memory/candidates',
      headers: bearer(device.token.accessToken),
      payload: {
        category: 'communication_preference',
        claim: 'Prefers concise answers.',
        scope: { type: 'global', id: null },
        evidence: [
          {
            eventId: randomUUID(),
            projectId: 'project-a',
            workThreadId: null,
            text: 'Concise please.',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(ApiProblemSchema.parse(response.json()).code).toBe(
      'insufficient_scope',
    );
  });

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
    const grant = (
      await app.inject({
        method: 'POST',
        url: '/oauth/device/authorize',
        payload: {
          clientId: 'baton-cli',
          clientName,
          clientVersion: '0.6.0',
          platform: 'test',
          requestedScopes: ['account:read', 'memory:read'],
        },
      })
    ).json() as { userCode: string; deviceCode: string };
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
    return { token: token.json() as TokenResponse };
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
