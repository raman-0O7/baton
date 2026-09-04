import { gzipSync } from 'node:zlib';

import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import { InMemoryIngestionStore } from '@baton/database';
import {
  ApiProblemSchema,
  ConsentRecordSchema,
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  DeviceAuthorizationResponseSchema,
  IngestionAcknowledgementSchema,
  IngestionCheckpointSchema,
  maxIngestionCompressedBytes,
  maxIngestionDecompressedBytes,
  ProjectSchema,
  TokenResponseSchema,
  type CollectionPolicy,
  type IngestionBatch,
  type SourceEvent,
  type TokenResponse,
} from '@baton/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'ingestion-test-pepper-longer-than-thirty-two-characters';
const cookieSecret =
  'ingestion-test-cookie-secret-longer-than-thirty-two-characters';
const installationId = '018f0f90-1000-7000-8000-000000000001';
const sourceSessionId = '018f0f90-2000-7000-8000-000000000001';
const policy: CollectionPolicy = {
  policyVersion: '2026-08-02',
  allowedCategories: [
    'conversation_text',
    'plans_and_tasks',
    'command_arguments',
    'tool_results',
    'file_paths',
    'diffs',
    'session_metadata',
  ],
  excludedPathPatterns: ['**/.env', '**/credentials/**'],
  maxToolResultBytes: 65_536,
  maxDiffBytes: 262_144,
};

class FakeIdentityProvider implements WebIdentityProvider {
  authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
  }): URL {
    const url = new URL('https://identity.example.com/authorize');
    url.searchParams.set('state', input.state);
    return url;
  }

  async exchange(input: { code: string }): Promise<{
    issuer: string;
    subject: string;
    email: string;
    displayName: string;
  }> {
    return {
      issuer: 'https://identity.example.com',
      subject: input.code,
      email: `${input.code}@example.com`,
      displayName: input.code,
    };
  }
}

describe('Phase 2 cloud ingestion gate', () => {
  const store = new InMemoryIngestionStore();
  const identity = new IdentityService(new InMemoryIdentityStore(), {
    tokenPepper: pepper,
    verificationUri: 'http://dashboard.example.test/activate',
    devicePollingIntervalSeconds: 1,
  });
  const appPromise = buildApi({
    identity,
    identityProvider: new FakeIdentityProvider(),
    ingestionStore: store,
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('converges compressed retry, duplicate, and out-of-order deliveries', async () => {
    const ada = await provision('ada', 'Ada capture');
    const event = messageEvent(
      ada.token.deviceId,
      sourceSessionId,
      1,
      null,
      'Start incremental capture.',
    );
    const first = batchFor(ada, {
      batchId: '018f0f90-3000-7000-8000-000000000001',
      sourceSessionId,
      previousCursor: null,
      proposedCursor: 'line:1',
      expectedHeadEventId: null,
      events: [event],
    });
    const accepted = await sendBatch(first, ada.token, 'gzip');
    expect(accepted.statusCode).toBe(202);
    const acknowledgement = IngestionAcknowledgementSchema.parse(
      accepted.json(),
    );
    expect(acknowledgement.acceptedEventIds).toEqual([event.eventId]);

    const retry = await sendBatch(first, ada.token, 'gzip');
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(acknowledgement);
    expect(store.eventCount(ada.token.tenantId)).toBe(1);

    const duplicate = batchFor(ada, {
      batchId: '018f0f90-3000-7000-8000-000000000002',
      sourceSessionId,
      previousCursor: 'line:1',
      proposedCursor: 'line:1:reconciled',
      expectedHeadEventId: event.eventId,
      events: [event],
    });
    const duplicateResponse = await sendBatch(duplicate, ada.token, 'identity');
    expect(duplicateResponse.statusCode).toBe(202);
    expect(
      IngestionAcknowledgementSchema.parse(duplicateResponse.json())
        .duplicateEventIds,
    ).toEqual([event.eventId]);

    const outOfOrderSession = '018f0f90-2000-7000-8000-000000000002';
    const parent = messageEvent(
      ada.token.deviceId,
      outOfOrderSession,
      1,
      null,
      'Add authentication.',
    );
    const child = messageEvent(
      ada.token.deviceId,
      outOfOrderSession,
      2,
      parent.eventId,
      'I will add device authentication.',
      'assistant',
    );
    const childResponse = await sendBatch(
      batchFor(ada, {
        batchId: '018f0f90-3000-7000-8000-000000000003',
        sourceSessionId: outOfOrderSession,
        previousCursor: null,
        proposedCursor: 'native:2',
        expectedHeadEventId: null,
        events: [child],
      }),
      ada.token,
      'gzip',
    );
    expect(childResponse.statusCode).toBe(202);
    const parentResponse = await sendBatch(
      batchFor(ada, {
        batchId: '018f0f90-3000-7000-8000-000000000004',
        sourceSessionId: outOfOrderSession,
        previousCursor: 'native:2',
        proposedCursor: 'native:2:reconciled',
        expectedHeadEventId: child.eventId,
        events: [parent],
      }),
      ada.token,
      'gzip',
    );
    expect(parentResponse.statusCode).toBe(202);
    expect(
      IngestionAcknowledgementSchema.parse(parentResponse.json()).headEventId,
    ).toBe(child.eventId);
    expect(store.eventCount(ada.token.tenantId)).toBe(3);
  });

  it('rejects divergence and preserves the existing checkpoint', async () => {
    const user = await provision('divergence', 'Divergence capture');
    const event = messageEvent(
      user.token.deviceId,
      '018f0f90-2000-7000-8000-000000000003',
      1,
      null,
      'First event.',
    );
    const first = batchFor(user, {
      batchId: '018f0f90-3000-7000-8000-000000000005',
      sourceSessionId: event.sourceSessionId,
      previousCursor: null,
      proposedCursor: 'line:1',
      expectedHeadEventId: null,
      events: [event],
    });
    expect((await sendBatch(first, user.token, 'gzip')).statusCode).toBe(202);
    const stale = {
      ...first,
      batchId: '018f0f90-3000-7000-8000-000000000006',
      previousCursor: null,
    } satisfies IngestionBatch;
    const conflict = await sendBatch(stale, user.token, 'gzip');
    expect(conflict.statusCode).toBe(409);
    expect(ApiProblemSchema.parse(conflict.json()).code).toBe(
      'checkpoint_diverged',
    );
    const checkpoint = await readCheckpoint(user, event.sourceSessionId);
    expect(checkpoint.acknowledgedCursor).toBe('line:1');
    expect(store.eventCount(user.token.tenantId)).toBe(1);
  });

  it('revokes one installation idempotently without advancing its checkpoint', async () => {
    const user = await provision('revocation', 'Revoked capture');
    const event = messageEvent(
      user.token.deviceId,
      '018f0f90-2000-7000-8000-000000000004',
      1,
      null,
      'Accepted before revocation.',
    );
    const first = batchFor(user, {
      batchId: '018f0f90-3000-7000-8000-000000000007',
      sourceSessionId: event.sourceSessionId,
      previousCursor: null,
      proposedCursor: 'line:1',
      expectedHeadEventId: null,
      events: [event],
    });
    expect((await sendBatch(first, user.token, 'gzip')).statusCode).toBe(202);
    const app = await appPromise;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revoke = await app.inject({
        method: 'DELETE',
        url: `/v1/projects/${user.projectId}/consents/${user.consentRecordId}`,
        headers: bearer(user.token.accessToken),
      });
      expect(revoke.statusCode).toBe(204);
    }
    expect(
      store
        .auditMetadata(user.token.tenantId)
        .filter((event) => event.action === 'project.consent.revoked'),
    ).toHaveLength(1);
    const next = messageEvent(
      user.token.deviceId,
      event.sourceSessionId,
      2,
      event.eventId,
      'Must not be stored.',
    );
    const rejected = await sendBatch(
      batchFor(user, {
        batchId: '018f0f90-3000-7000-8000-000000000008',
        sourceSessionId: event.sourceSessionId,
        previousCursor: 'line:1',
        proposedCursor: 'line:2',
        expectedHeadEventId: event.eventId,
        events: [next],
      }),
      user.token,
      'gzip',
    );
    expect(rejected.statusCode).toBe(403);
    expect(ApiProblemSchema.parse(rejected.json()).code).toBe(
      'consent_required',
    );
    expect(
      (await readCheckpoint(user, event.sourceSessionId)).acknowledgedCursor,
    ).toBe('line:1');
    expect(store.eventCount(user.token.tenantId)).toBe(1);
  });

  it('isolates identical batch IDs across tenants and hides foreign projects', async () => {
    const first = await provision('tenant-one', 'Tenant one capture');
    const second = await provision('tenant-two', 'Tenant two capture');
    const sharedBatchId = '018f0f90-3000-7000-8000-000000000009';
    const firstEvent = messageEvent(
      first.token.deviceId,
      '018f0f90-2000-7000-8000-000000000005',
      1,
      null,
      'Tenant one event.',
    );
    const secondEvent = messageEvent(
      second.token.deviceId,
      '018f0f90-2000-7000-8000-000000000005',
      1,
      null,
      'Tenant two event.',
    );
    expect(
      (
        await sendBatch(
          batchFor(first, {
            batchId: sharedBatchId,
            sourceSessionId: firstEvent.sourceSessionId,
            previousCursor: null,
            proposedCursor: 'line:1',
            expectedHeadEventId: null,
            events: [firstEvent],
          }),
          first.token,
          'gzip',
        )
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await sendBatch(
          batchFor(second, {
            batchId: sharedBatchId,
            sourceSessionId: secondEvent.sourceSessionId,
            previousCursor: null,
            proposedCursor: 'line:1',
            expectedHeadEventId: null,
            events: [secondEvent],
          }),
          second.token,
          'gzip',
        )
      ).statusCode,
    ).toBe(202);
    expect(store.eventCount(first.token.tenantId)).toBe(1);
    expect(store.eventCount(second.token.tenantId)).toBe(1);

    const app = await appPromise;
    const crossTenantConsentRevoke = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${first.projectId}/consents/${first.consentRecordId}`,
      headers: bearer(second.token.accessToken),
    });
    expect(crossTenantConsentRevoke.statusCode).toBe(404);
    const firstContinuation = messageEvent(
      first.token.deviceId,
      firstEvent.sourceSessionId,
      2,
      firstEvent.eventId,
      'Tenant one consent remains active.',
    );
    expect(
      (
        await sendBatch(
          batchFor(first, {
            batchId: '018f0f90-3000-7000-8000-000000000013',
            sourceSessionId: firstEvent.sourceSessionId,
            previousCursor: 'line:1',
            proposedCursor: 'line:2',
            expectedHeadEventId: firstEvent.eventId,
            events: [firstContinuation],
          }),
          first.token,
          'gzip',
        )
      ).statusCode,
    ).toBe(202);
    expect(store.eventCount(first.token.tenantId)).toBe(2);

    const foreign = batchFor(second, {
      batchId: '018f0f90-3000-7000-8000-000000000010',
      sourceSessionId: secondEvent.sourceSessionId,
      previousCursor: null,
      proposedCursor: 'foreign',
      expectedHeadEventId: null,
      events: [secondEvent],
    });
    foreign.projectId = first.projectId;
    const hidden = await sendBatch(foreign, second.token, 'gzip');
    expect(hidden.statusCode).toBe(404);
    expect(ApiProblemSchema.parse(hidden.json()).code).toBe('not_found');
  });

  it('rejects stale or fabricated disclosure proof before recording consent', async () => {
    const user = await provision('stale-disclosure', 'Disclosure capture');
    const app = await appPromise;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${user.projectId}/consents`,
      headers: bearer(user.token.accessToken),
      payload: {
        projectInstallationId: '018f0f90-1000-7000-8000-000000000099',
        disclosureVersion: 'obsolete-disclosure',
        disclosureDigest: 'f'.repeat(64),
        collectionPolicy: policy,
        cloudProcessingAcknowledged: true,
        modelProcessingAcknowledged: true,
        captureSurface: 'cli',
        historicalImport: false,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(ApiProblemSchema.parse(response.json()).code).toBe('conflict');
  });

  it('bounds compression, rejects unsupported encodings, and keeps audits content-free', async () => {
    const user = await provision('encoding', 'Encoding capture');
    const event = messageEvent(
      user.token.deviceId,
      '018f0f90-2000-7000-8000-000000000006',
      1,
      null,
      'This sentence must not enter audit metadata.',
    );
    const batch = batchFor(user, {
      batchId: '018f0f90-3000-7000-8000-000000000011',
      sourceSessionId: event.sourceSessionId,
      previousCursor: null,
      proposedCursor: 'line:1',
      expectedHeadEventId: null,
      events: [event],
    });
    const unsupported = await sendBatch(batch, user.token, 'br');
    expect(unsupported.statusCode).toBe(415);

    const app = await appPromise;
    const compressedOverflow = await app.inject({
      method: 'POST',
      url: '/v1/ingestion/batches',
      headers: {
        ...bearer(user.token.accessToken),
        'content-type': 'application/json',
      },
      payload: Buffer.alloc(maxIngestionCompressedBytes + 1, 0x20),
    });
    expect(compressedOverflow.statusCode).toBe(413);

    const decompressedOverflow = await app.inject({
      method: 'POST',
      url: '/v1/ingestion/batches',
      headers: {
        ...bearer(user.token.accessToken),
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(
        Buffer.from(
          `{"padding":"${'x'.repeat(maxIngestionDecompressedBytes)}"}`,
        ),
      ),
    });
    expect(decompressedOverflow.statusCode).toBe(413);

    expect((await sendBatch(batch, user.token, 'gzip')).statusCode).toBe(202);
    const auditJson = JSON.stringify(store.auditMetadata(user.token.tenantId));
    expect(auditJson).not.toContain(
      'This sentence must not enter audit metadata.',
    );
    expect(auditJson).not.toContain(event.contentHash);
  });

  it('rejects an obvious remaining credential before storage or checkpointing', async () => {
    const user = await provision('secret-policy', 'Secret policy capture');
    const event = messageEvent(
      user.token.deviceId,
      '018f0f90-2000-7000-8000-000000000007',
      1,
      null,
      'access_token=should-never-reach-cloud-storage',
    );
    const rejected = await sendBatch(
      batchFor(user, {
        batchId: '018f0f90-3000-7000-8000-000000000012',
        sourceSessionId: event.sourceSessionId,
        previousCursor: null,
        proposedCursor: 'line:1',
        expectedHeadEventId: null,
        events: [event],
      }),
      user.token,
      'gzip',
    );
    expect(rejected.statusCode).toBe(400);
    expect(ApiProblemSchema.parse(rejected.json()).code).toBe(
      'invalid_request',
    );
    expect(store.eventCount(user.token.tenantId)).toBe(0);
    const app = await appPromise;
    const checkpoint = await app.inject({
      method: 'GET',
      url:
        `/v1/ingestion/checkpoint?projectId=${user.projectId}` +
        `&projectInstallationId=${user.projectInstallationId}` +
        `&sourceSessionId=${event.sourceSessionId}`,
      headers: bearer(user.token.accessToken),
    });
    expect(checkpoint.statusCode).toBe(204);
  });

  async function provision(
    subject: string,
    deviceName: string,
  ): Promise<{
    token: TokenResponse;
    projectId: string;
    projectInstallationId: string;
    consentRecordId: string;
  }> {
    const app = await appPromise;
    const cookie = await webLogin(subject);
    const token = await registerDevice(cookie, deviceName);
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: bearer(token.accessToken),
      payload: { displayName: `${subject} project`, collectionPolicy: policy },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = ProjectSchema.parse(projectResponse.json());
    const projectInstallationId = installationFor(subject);
    const consentResponse = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.projectId}/consents`,
      headers: bearer(token.accessToken),
      payload: {
        projectInstallationId,
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
    return {
      token,
      projectId: project.projectId,
      projectInstallationId,
      consentRecordId: consent.consentRecordId,
    };
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
  ): Promise<TokenResponse> {
    const app = await appPromise;
    const authorization = await app.inject({
      method: 'POST',
      url: '/oauth/device/authorize',
      payload: {
        clientId: 'baton-cli',
        clientName,
        clientVersion: '0.2.0',
        platform: 'test',
        requestedScopes: [
          'account:read',
          'projects:read',
          'projects:write',
          'ingest:write',
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
    return TokenResponseSchema.parse(token.json());
  }

  async function sendBatch(
    batch: IngestionBatch,
    token: TokenResponse,
    encoding: 'gzip' | 'identity' | 'br',
  ) {
    const app = await appPromise;
    const json = Buffer.from(JSON.stringify(batch));
    const payload = encoding === 'gzip' ? gzipSync(json) : json;
    return app.inject({
      method: 'POST',
      url: '/v1/ingestion/batches',
      headers: {
        ...bearer(token.accessToken),
        'content-type': 'application/json',
        ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }),
      },
      payload,
    });
  }

  async function readCheckpoint(
    user: {
      token: TokenResponse;
      projectId: string;
      projectInstallationId: string;
    },
    sessionId: string,
  ) {
    const app = await appPromise;
    const response = await app.inject({
      method: 'GET',
      url:
        `/v1/ingestion/checkpoint?projectId=${user.projectId}` +
        `&projectInstallationId=${user.projectInstallationId}` +
        `&sourceSessionId=${sessionId}`,
      headers: bearer(user.token.accessToken),
    });
    expect(response.statusCode).toBe(200);
    return IngestionCheckpointSchema.parse(response.json());
  }
});

function messageEvent(
  deviceId: string,
  sessionId: string,
  sequence: number,
  parentEventId: string | null,
  text: string,
  role: 'user' | 'assistant' = 'user',
): SourceEvent {
  return createSourceEvent({
    sourceSessionId: sessionId,
    workThreadId: null,
    sourceAgent: 'codex',
    sourceDeviceId: deviceId,
    nativeSequence: sequence,
    parentEventId,
    occurredAt: new Date(Date.UTC(2026, 7, 2, 10, 0, sequence)).toISOString(),
    observedAt: new Date(Date.UTC(2026, 7, 2, 10, 1, sequence)).toISOString(),
    schemaVersion: 1,
    payload: { kind: 'message', role, text },
  });
}

function batchFor(
  user: {
    token: TokenResponse;
    projectId: string;
    projectInstallationId: string;
    consentRecordId: string;
  },
  input: {
    batchId: string;
    sourceSessionId: string;
    previousCursor: string | null;
    proposedCursor: string;
    expectedHeadEventId: string | null;
    events: SourceEvent[];
  },
): IngestionBatch {
  return {
    schemaVersion: 1,
    batchId: input.batchId,
    deviceId: user.token.deviceId,
    projectId: user.projectId,
    projectInstallationId: user.projectInstallationId,
    consentRecordId: user.consentRecordId,
    policyVersion: policy.policyVersion,
    disclosureVersion: currentCollectionDisclosureVersion,
    source: {
      sourceSessionId: input.sourceSessionId,
      agent: 'codex',
      nativeSessionHash: 'b'.repeat(64),
      parserVersion: 'test-v1',
    },
    expectedHeadEventId: input.expectedHeadEventId,
    previousCursor: input.previousCursor,
    proposedCursor: input.proposedCursor,
    events: input.events,
  };
}

function installationFor(subject: string): string {
  const hex = Buffer.from(subject).toString('hex').slice(0, 12).padEnd(12, '0');
  return `018f0f90-1000-7000-8000-${hex}`;
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function cookieNamed(
  header: string | string[] | undefined,
  name: string,
): string {
  const values = Array.isArray(header)
    ? header
    : header === undefined
      ? []
      : [header];
  const value = values.find((candidate) => candidate.startsWith(`${name}=`));
  if (value === undefined) throw new Error(`Missing ${name} cookie`);
  return value.split(';', 1)[0]!;
}

function required(value: string | null | undefined): string {
  if (value === null || value === undefined) throw new Error('Missing value');
  return value;
}
