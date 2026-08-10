import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { IdentityService, type AuthPrincipal } from '@baton/auth';
import {
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type CollectionPolicy,
} from '@baton/protocol';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/client.js';
import type { IngestionRequestContext } from '../src/ingestion-store.js';
import { PostgresIdentityStore } from '../src/postgres-identity-store.js';
import { PostgresIngestionStore } from '../src/postgres-ingestion-store.js';
import { PostgresLifecycleStore } from '../src/postgres-lifecycle-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const policy: CollectionPolicy = {
  policyVersion: 'lifecycle-integration-v1',
  allowedCategories: ['conversation_text', 'session_metadata'],
  excludedPathPatterns: [],
  maxToolResultBytes: 4096,
  maxDiffBytes: 4096,
};

integration('Postgres Phase 7 lifecycle', () => {
  let database: DatabaseClient;
  let identity: IdentityService;
  let ingestion: PostgresIngestionStore;
  let lifecycle: PostgresLifecycleStore;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../migrations', import.meta.url),
      ),
    });
    identity = new IdentityService(new PostgresIdentityStore(database.db), {
      tokenPepper: 'lifecycle-integration-pepper-longer-than-thirty-two-chars!',
      verificationUri: 'https://app.example.test/activate',
      devicePollingIntervalSeconds: 1,
    });
    ingestion = new PostgresIngestionStore(database.db);
    lifecycle = new PostgresLifecycleStore(database.db);
  });

  afterAll(async () => database?.close());

  it('deletes a project across every table and isolates tenants', async () => {
    const device = await registerDevice('owner');
    const project = await ingestion.createProject(device.context, {
      displayName: 'Greeting',
      collectionPolicy: policy,
    });
    const installationId = randomUUID();
    const consent = await ingestion.recordConsent(
      device.context,
      project.projectId,
      {
        projectInstallationId: installationId,
        disclosureVersion: currentCollectionDisclosureVersion,
        disclosureDigest: currentCollectionDisclosureDigest,
        collectionPolicy: policy,
        cloudProcessingAcknowledged: true,
        modelProcessingAcknowledged: true,
        captureSurface: 'cli',
        historicalImport: false,
      },
    );
    const sessionId = randomUUID();
    const event = createSourceEvent({
      sourceSessionId: sessionId,
      workThreadId: null,
      sourceAgent: 'codex',
      sourceDeviceId: device.deviceId,
      nativeSequence: 1,
      parentEventId: null,
      occurredAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      schemaVersion: 1,
      payload: { kind: 'message', role: 'user', text: 'Delete me.' },
    });
    await ingestion.ingestBatch(device.context, {
      schemaVersion: 1,
      batchId: randomUUID(),
      deviceId: device.deviceId,
      projectId: project.projectId,
      projectInstallationId: installationId,
      consentRecordId: consent.consentRecordId,
      policyVersion: policy.policyVersion,
      disclosureVersion: currentCollectionDisclosureVersion,
      source: {
        sourceSessionId: sessionId,
        agent: 'codex',
        nativeSessionHash: 'd'.repeat(64),
        parserVersion: 'integration-v1',
      },
      expectedHeadEventId: null,
      previousCursor: null,
      proposedCursor: 'cursor:1',
      events: [event],
    });

    const receipt = await lifecycle.deleteProject(
      device.context,
      project.projectId,
    );
    expect(receipt.complete).toBe(true);
    expect(receipt.deletedCounts.source_events).toBe(1);
    expect(receipt.deletedCounts.projects).toBe(1);
    expect(
      (await ingestion.listProjects(device.context)).projects,
    ).toHaveLength(0);
  });

  async function registerDevice(label: string): Promise<{
    context: IngestionRequestContext;
    deviceId: string;
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
    const principal: AuthPrincipal = await identity.authenticateAccessToken(
      token.accessToken,
    );
    if (principal.deviceId === null)
      throw new Error('Expected device principal');
    return {
      context: { principal, requestId: randomUUID() },
      deviceId: principal.deviceId,
    };
  }
});
