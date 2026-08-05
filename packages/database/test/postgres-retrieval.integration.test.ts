import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { IdentityService, type AuthPrincipal } from '@baton/auth';
import {
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type CollectionPolicy,
  type SourceEventInput,
} from '@baton/protocol';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/client.js';
import { PostgresIdentityStore } from '../src/postgres-identity-store.js';
import { PostgresIngestionStore } from '../src/postgres-ingestion-store.js';
import { PostgresRetrievalStore } from '../src/postgres-retrieval-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const policy: CollectionPolicy = {
  policyVersion: 'retrieval-integration-v1',
  allowedCategories: [
    'conversation_text',
    'plans_and_tasks',
    'command_arguments',
    'tool_results',
    'file_paths',
    'diffs',
    'session_metadata',
  ],
  excludedPathPatterns: [],
  maxToolResultBytes: 8192,
  maxDiffBytes: 8192,
};

integration('Postgres Phase 4 retrieval', () => {
  let database: DatabaseClient;
  let identity: IdentityService;
  let ingestion: PostgresIngestionStore;
  let retrieval: PostgresRetrievalStore;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../migrations', import.meta.url),
      ),
    });
    identity = new IdentityService(new PostgresIdentityStore(database.db), {
      tokenPepper:
        'retrieval-integration-pepper-longer-than-thirty-two-characters',
      verificationUri: 'https://app.example.test/activate',
      devicePollingIntervalSeconds: 1,
    });
    ingestion = new PostgresIngestionStore(database.db);
    retrieval = new PostgresRetrievalStore(database.db);
  });

  afterAll(async () => database?.close());

  it('materializes chunks, retrieves by full-text search, and isolates tenants', async () => {
    const device = await registerDevice('ret');
    const project = await ingestion.createProject(device.context, {
      displayName: 'Greeting',
      collectionPolicy: policy,
    });
    const session = randomUUID();
    await seed(device, project.projectId, session, [
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
    ]);

    const indexed = await retrieval.reindexProject(
      device.context,
      project.projectId,
    );
    expect(indexed).toBe(3);

    const result = await retrieval.search(device.context, {
      projectId: project.projectId,
      query: 'What happened to the Greet function name?',
    });
    expect(result.lexicalFallback).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.some((chunk) => chunk.text.includes('Hello'))).toBe(
      true,
    );

    // A second tenant cannot search another tenant's project.
    const intruder = await registerDevice('intruder');
    await expect(
      retrieval.search(intruder.context, {
        projectId: project.projectId,
        query: 'greet',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  interface Device {
    context: { principal: AuthPrincipal; requestId: string };
    deviceId: string;
  }

  async function registerDevice(label: string): Promise<Device> {
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
    return {
      context: { principal, requestId: randomUUID() },
      deviceId: principal.deviceId,
    };
  }

  async function seed(
    device: Device,
    projectId: string,
    sourceSessionId: string,
    payloads: SourceEventInput['payload'][],
  ): Promise<void> {
    const installationId = randomUUID();
    const consent = await ingestion.recordConsent(device.context, projectId, {
      projectInstallationId: installationId,
      disclosureVersion: currentCollectionDisclosureVersion,
      disclosureDigest: currentCollectionDisclosureDigest,
      collectionPolicy: policy,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      historicalImport: false,
    });
    const base = Date.parse('2026-07-01T10:00:00Z');
    const events = payloads.map((payload, index) =>
      createSourceEvent({
        sourceSessionId,
        workThreadId: null,
        sourceAgent: 'claudecode',
        sourceDeviceId: device.deviceId,
        nativeSequence: index,
        parentEventId: null,
        occurredAt: new Date(base + index * 1000).toISOString(),
        observedAt: new Date(base + index * 1000).toISOString(),
        schemaVersion: 1,
        payload,
      }),
    );
    await ingestion.ingestBatch(device.context, {
      schemaVersion: 1,
      batchId: randomUUID(),
      deviceId: device.deviceId,
      projectId,
      projectInstallationId: installationId,
      consentRecordId: consent.consentRecordId,
      policyVersion: policy.policyVersion,
      disclosureVersion: currentCollectionDisclosureVersion,
      source: {
        sourceSessionId,
        agent: 'claudecode',
        nativeSessionHash: 'a'.repeat(64),
        parserVersion: 'integration-v1',
      },
      expectedHeadEventId: null,
      previousCursor: null,
      proposedCursor: 'cursor:1',
      events,
    });
  }
});
