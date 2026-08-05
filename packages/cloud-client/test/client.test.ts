import { gunzipSync } from 'node:zlib';

import { scrubIngestionBatchDraft } from '@baton/scrubber';
import { describe, expect, it } from 'vitest';

import { BatonCloudClient, CloudApiError } from '../src/index.js';

describe('BatonCloudClient', () => {
  it('sends bearer credentials and validates account responses', async () => {
    let authorization = '';
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com/',
      fetcher: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json({
          userId: '11111111-1111-4111-8111-111111111111',
          tenantId: '22222222-2222-4222-8222-222222222222',
          email: 'ada@example.com',
          displayName: 'Ada',
          currentDeviceId: null,
        });
      },
    });
    expect((await client.account('secret')).email).toBe('ada@example.com');
    expect(authorization).toBe('Bearer secret');
  });

  it('turns canonical problems into typed errors', async () => {
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com',
      fetcher: async () =>
        Response.json(
          {
            type: 'https://baton.dev/problems/authorization-pending',
            title: 'Authorization pending',
            status: 400,
            code: 'authorization_pending',
            requestId: 'request-1',
            retryAfterSeconds: 5,
          },
          { status: 400 },
        ),
    });
    await expect(
      client.exchangeToken({
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        clientId: 'baton-cli',
        deviceCode: 'x'.repeat(32),
      }),
    ).rejects.toMatchObject({
      problem: { code: 'authorization_pending' },
    });
  });

  it('lists and revokes the exact installation consent record', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const projectId = '55555555-5555-4555-8555-555555555555';
    const consentRecordId = '88888888-8888-4888-8888-888888888888';
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com',
      fetcher: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        requests.push({ method, path });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json({
          consents: [
            {
              consentRecordId,
              projectId,
              projectInstallationId: '66666666-6666-4666-8666-666666666666',
              deviceId: '44444444-4444-4444-8444-444444444444',
              disclosureVersion: 'hosted-project-enable-v1',
              disclosureDigest: 'a'.repeat(64),
              collectionPolicy: {
                policyVersion: 'hosted-default-v1',
                allowedCategories: ['conversation_text'],
                excludedPathPatterns: ['.env'],
                maxToolResultBytes: 65536,
                maxDiffBytes: 131072,
              },
              cloudProcessingAcknowledged: true,
              modelProcessingAcknowledged: true,
              captureSurface: 'cli',
              historicalImport: false,
              capturedAt: '2026-08-02T00:00:00.000Z',
              effectiveAt: '2026-08-02T00:00:00.000Z',
              revokedAt: null,
            },
          ],
        });
      },
    });

    expect(await client.consents(projectId, 'access-token')).toHaveLength(1);
    await client.revokeConsent(projectId, consentRecordId, 'access-token');
    expect(requests).toEqual([
      { method: 'GET', path: `/v1/projects/${projectId}/consents` },
      {
        method: 'DELETE',
        path: `/v1/projects/${projectId}/consents/${consentRecordId}`,
      },
    ]);
  });

  it('represents a missing cloud checkpoint as null', async () => {
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com',
      fetcher: async () => new Response(null, { status: 204 }),
    });
    await expect(
      client.checkpoint(
        {
          projectId: '55555555-5555-4555-8555-555555555555',
          projectInstallationId: '66666666-6666-4666-8666-666666666666',
          sourceSessionId: '99999999-9999-4999-8999-999999999999',
        },
        'access-token',
      ),
    ).resolves.toBeNull();
  });

  it('uploads only branded scrubbed batches with bounded gzip encoding', async () => {
    let uploaded: unknown;
    let encoding = '';
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com',
      fetcher: async (_input, init) => {
        encoding = new Headers(init?.headers).get('content-encoding') ?? '';
        if (!Buffer.isBuffer(init?.body))
          throw new Error('expected gzip buffer');
        uploaded = JSON.parse(
          gunzipSync(init.body).toString('utf8'),
        ) as unknown;
        return Response.json({
          batchId: '33333333-3333-4333-8333-333333333333',
          acceptedEventIds: ['77777777-7777-8777-8777-777777777777'],
          duplicateEventIds: [],
          headEventId: '77777777-7777-8777-8777-777777777777',
          acknowledgedCursor: 'line:1',
          branchCreated: false,
        });
      },
    });
    const scrubbed = scrubIngestionBatchDraft({
      schemaVersion: 1,
      batchId: '33333333-3333-4333-8333-333333333333',
      deviceId: '44444444-4444-4444-8444-444444444444',
      projectId: '55555555-5555-4555-8555-555555555555',
      projectInstallationId: '66666666-6666-4666-8666-666666666666',
      consentRecordId: '88888888-8888-4888-8888-888888888888',
      policyVersion: 'hosted-default-v1',
      disclosureVersion: 'hosted-project-enable-v1',
      source: {
        sourceSessionId: '99999999-9999-4999-8999-999999999999',
        agent: 'codex',
        nativeSessionHash: 'a'.repeat(64),
        parserVersion: '2026-07-rollout',
      },
      expectedHeadEventId: null,
      previousCursor: null,
      proposedCursor: 'line:1',
      events: [
        {
          sourceSessionId: '99999999-9999-4999-8999-999999999999',
          workThreadId: null,
          sourceAgent: 'codex',
          sourceDeviceId: '44444444-4444-4444-8444-444444444444',
          nativeSequence: 1,
          parentEventId: null,
          occurredAt: '2026-08-02T00:00:00.000Z',
          observedAt: '2026-08-02T00:00:01.000Z',
          schemaVersion: 1,
          payload: { kind: 'message', role: 'user', text: 'Safe event' },
        },
      ],
    });

    await client.ingestBatch(scrubbed, 'access-token');
    expect(encoding).toBe('gzip');
    expect(uploaded).toMatchObject({
      projectInstallationId: '66666666-6666-4666-8666-666666666666',
      consentRecordId: '88888888-8888-4888-8888-888888888888',
    });
  });

  it('creates and assigns work threads over the typed contract', async () => {
    const projectId = '55555555-5555-4555-8555-555555555555';
    const workThreadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sourceSessionId = '99999999-9999-4999-8999-999999999999';
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          path: url.pathname + url.search,
          body:
            init?.body === undefined
              ? undefined
              : JSON.parse(String(init.body)),
        });
        const thread = {
          workThreadId,
          projectId,
          title: 'Implement hosted authentication',
          goal: null,
          state: 'active',
          createdAt: '2026-08-05T00:00:00.000Z',
          updatedAt: '2026-08-05T00:00:00.000Z',
        };
        if (method === 'POST' && url.pathname.endsWith('/sessions')) {
          return Response.json({
            workThreadId,
            sourceSession: {
              sourceSessionId,
              projectId,
              sourceAgent: 'codex',
              nativeSessionHash: 'b'.repeat(64),
              title: null,
              startedAt: null,
              lastEventAt: null,
            },
            position: 0,
            assignment: 'confirmed',
            assignedAt: '2026-08-05T00:00:00.000Z',
          });
        }
        return Response.json(thread);
      },
    });

    const created = await client.createWorkThread(
      { projectId, title: 'Implement hosted authentication', goal: null },
      'access-token',
    );
    expect(created.workThreadId).toBe(workThreadId);
    const assigned = await client.assignThreadSession(
      workThreadId,
      { sourceSessionId, assignment: 'confirmed' },
      'access-token',
    );
    expect(assigned.assignment).toBe('confirmed');
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/work-threads',
        body: {
          projectId,
          title: 'Implement hosted authentication',
          goal: null,
        },
      },
      {
        method: 'POST',
        path: `/v1/work-threads/${workThreadId}/sessions`,
        body: { sourceSessionId, assignment: 'confirmed' },
      },
    ]);
  });

  it('builds cursor, limit, and suggestion query parameters', async () => {
    const projectId = '55555555-5555-4555-8555-555555555555';
    const workThreadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sourceSessionId = '99999999-9999-4999-8999-999999999999';
    const paths: string[] = [];
    const client = new BatonCloudClient({
      baseUrl: 'https://api.example.com',
      fetcher: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname + url.search);
        if (url.pathname.endsWith('/events')) {
          return Response.json({
            workThread: {
              workThreadId,
              projectId,
              title: 'Thread',
              goal: null,
              state: 'active',
              createdAt: '2026-08-05T00:00:00.000Z',
              updatedAt: '2026-08-05T00:00:00.000Z',
            },
            sourceSessions: [],
            events: [],
            page: { nextCursor: null, hasMore: false },
          });
        }
        return Response.json({ sourceSessionId, suggestions: [] });
      },
    });

    await client.workThreadEvents(
      workThreadId,
      { cursor: 'abc', limit: 50 },
      'access-token',
    );
    await client.suggestThreads(projectId, sourceSessionId, 'access-token');
    expect(paths[0]).toBe(
      `/v1/work-threads/${workThreadId}/events?cursor=abc&limit=50`,
    );
    expect(paths[1]).toBe(
      `/v1/projects/${projectId}/thread-suggestions?sourceSessionId=${sourceSessionId}`,
    );
  });
});
