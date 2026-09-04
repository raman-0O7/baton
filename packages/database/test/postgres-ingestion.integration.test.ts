import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { IdentityService, type AuthPrincipal } from '@baton/auth';
import {
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type CollectionPolicy,
  type IngestionBatch,
} from '@baton/protocol';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/client.js';
import { PostgresIdentityStore } from '../src/postgres-identity-store.js';
import { PostgresIngestionStore } from '../src/postgres-ingestion-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const policy: CollectionPolicy = {
  policyVersion: 'postgres-integration-v1',
  allowedCategories: ['conversation_text', 'session_metadata'],
  excludedPathPatterns: ['**/.env'],
  maxToolResultBytes: 4096,
  maxDiffBytes: 4096,
};

integration('Postgres Phase 2 ingestion transaction', () => {
  let database: DatabaseClient;
  let identity: IdentityService;
  let store: PostgresIngestionStore;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../migrations', import.meta.url),
      ),
    });
    identity = new IdentityService(new PostgresIdentityStore(database.db), {
      tokenPepper:
        'postgres-integration-pepper-longer-than-thirty-two-characters',
      verificationUri: 'https://app.example.test/activate',
      devicePollingIntervalSeconds: 1,
    });
    store = new PostgresIngestionStore(database.db);
  });

  afterAll(async () => database?.close());

  it('commits consent, events, receipt, and checkpoint atomically across retries and tenants', async () => {
    const first = await fixture('first');
    const sharedBatchId = randomUUID();
    const sessionId = randomUUID();
    const event = createSourceEvent({
      sourceSessionId: sessionId,
      workThreadId: null,
      sourceAgent: 'codex',
      sourceDeviceId: first.principal.deviceId!,
      nativeSequence: 1,
      parentEventId: null,
      occurredAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      schemaVersion: 1,
      payload: { kind: 'message', role: 'user', text: 'Postgres event one.' },
    });
    const batch = makeBatch(first, sharedBatchId, sessionId, event);
    const accepted = await store.ingestBatch(first.context, batch);
    expect(accepted.acceptedEventIds).toEqual([event.eventId]);
    expect(await store.ingestBatch(first.context, batch)).toEqual(accepted);
    expect(
      await store.getCheckpoint(first.context, {
        projectId: first.projectId,
        projectInstallationId: first.installationId,
        sourceSessionId: sessionId,
      }),
    ).toMatchObject({
      acknowledgedCursor: 'cursor:1',
      headEventId: event.eventId,
    });

    await store.revokeConsent(
      first.context,
      first.projectId,
      first.consentRecordId,
    );
    const nextEvent = createSourceEvent({
      sourceSessionId: sessionId,
      workThreadId: null,
      sourceAgent: 'codex',
      sourceDeviceId: first.principal.deviceId,
      nativeSequence: 2,
      parentEventId: event.eventId,
      occurredAt: new Date(Date.now() + 1000).toISOString(),
      observedAt: new Date(Date.now() + 1000).toISOString(),
      schemaVersion: 1,
      payload: { kind: 'message', role: 'assistant', text: 'Rejected event.' },
    });
    await expect(
      store.ingestBatch(first.context, {
        ...batch,
        batchId: randomUUID(),
        previousCursor: 'cursor:1',
        proposedCursor: 'cursor:2',
        expectedHeadEventId: event.eventId,
        events: [nextEvent],
      }),
    ).rejects.toMatchObject({
      code: 'consent_required',
    });
    expect(
      await store.getCheckpoint(first.context, {
        projectId: first.projectId,
        projectInstallationId: first.installationId,
        sourceSessionId: sessionId,
      }),
    ).toMatchObject({
      acknowledgedCursor: 'cursor:1',
      headEventId: event.eventId,
    });

    const second = await fixture('second');
    const secondEvent = createSourceEvent({
      sourceSessionId: sessionId,
      workThreadId: null,
      sourceAgent: 'codex',
      sourceDeviceId: second.principal.deviceId!,
      nativeSequence: 1,
      parentEventId: null,
      occurredAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      schemaVersion: 1,
      payload: { kind: 'message', role: 'user', text: 'Tenant two event.' },
    });
    const secondAccepted = await store.ingestBatch(
      second.context,
      makeBatch(second, sharedBatchId, sessionId, secondEvent),
    );
    expect(secondAccepted.acceptedEventIds).toEqual([secondEvent.eventId]);
  });

  async function fixture(label: string): Promise<{
    principal: AuthPrincipal & { deviceId: string };
    context: { principal: AuthPrincipal; requestId: string };
    projectId: string;
    installationId: string;
    consentRecordId: string;
  }> {
    const subject = `${label}-${randomUUID()}`;
    const session = await identity.establishBrowserSession(
      {
        issuer: 'https://integration.example.test',
        subject,
        email: `${subject}@example.test`,
        displayName: label,
      },
      { requestId: randomUUID() },
    );
    const browser = await identity.authenticateBrowserSession(
      session.sessionToken,
    );
    const grant = await identity.beginDeviceAuthorization({
      clientId: 'baton-cli',
      clientName: `${label} device`,
      clientVersion: 'integration',
      platform: 'test',
      requestedScopes: ['projects:read', 'projects:write', 'ingest:write'],
    });
    await identity.approveDevice(grant.userCode, browser, {
      requestId: randomUUID(),
    });
    const token = await identity.exchangeToken(
      {
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        clientId: 'baton-cli',
        deviceCode: grant.deviceCode,
      },
      { requestId: randomUUID() },
    );
    const principal = await identity.authenticateAccessToken(token.accessToken);
    if (principal.deviceId === null)
      throw new Error('Expected device principal');
    const context = { principal, requestId: randomUUID() };
    const project = await store.createProject(context, {
      displayName: `${label} project`,
      collectionPolicy: policy,
    });
    const installationId = randomUUID();
    const consent = await store.recordConsent(context, project.projectId, {
      projectInstallationId: installationId,
      disclosureVersion: currentCollectionDisclosureVersion,
      disclosureDigest: currentCollectionDisclosureDigest,
      collectionPolicy: policy,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      historicalImport: false,
    });
    return {
      principal: principal as AuthPrincipal & { deviceId: string },
      context,
      projectId: project.projectId,
      installationId,
      consentRecordId: consent.consentRecordId,
    };
  }
});

function makeBatch(
  fixture: {
    principal: AuthPrincipal & { deviceId: string };
    projectId: string;
    installationId: string;
    consentRecordId: string;
  },
  batchId: string,
  sourceSessionId: string,
  event: ReturnType<typeof createSourceEvent>,
): IngestionBatch {
  return {
    schemaVersion: 1,
    batchId,
    deviceId: fixture.principal.deviceId,
    projectId: fixture.projectId,
    projectInstallationId: fixture.installationId,
    consentRecordId: fixture.consentRecordId,
    policyVersion: policy.policyVersion,
    disclosureVersion: currentCollectionDisclosureVersion,
    source: {
      sourceSessionId,
      agent: 'codex',
      nativeSessionHash: 'd'.repeat(64),
      parserVersion: 'integration-v1',
    },
    expectedHeadEventId: null,
    previousCursor: null,
    proposedCursor: 'cursor:1',
    events: [event],
  };
}
