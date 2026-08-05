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
import { PostgresWorkThreadStore } from '../src/postgres-work-thread-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const policy: CollectionPolicy = {
  policyVersion: 'work-thread-integration-v1',
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

integration('Postgres Phase 3 work threads', () => {
  let database: DatabaseClient;
  let identity: IdentityService;
  let ingestion: PostgresIngestionStore;
  let threads: PostgresWorkThreadStore;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../migrations', import.meta.url),
      ),
    });
    identity = new IdentityService(new PostgresIdentityStore(database.db), {
      tokenPepper:
        'work-thread-integration-pepper-longer-than-thirty-two-characters',
      verificationUri: 'https://app.example.test/activate',
      devicePollingIntervalSeconds: 1,
    });
    ingestion = new PostgresIngestionStore(database.db);
    threads = new PostgresWorkThreadStore(database.db);
  });

  afterAll(async () => database?.close());

  it('merges Claude (device A) and Codex (device B) into one confirmed thread', async () => {
    const account = await establishAccount();
    const deviceA = await registerDevice(account, 'device-a');
    const deviceB = await registerDevice(account, 'device-b');

    const project = await ingestion.createProject(deviceA.context, {
      displayName: 'Hosted authentication',
      collectionPolicy: policy,
    });

    const claudeSession = randomUUID();
    await seedSession(deviceA, project.projectId, {
      agent: 'claudecode',
      sourceSessionId: claudeSession,
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
          rationale: 'CLI-safe',
        },
      ],
    });

    const codexSession = randomUUID();
    await seedSession(deviceB, project.projectId, {
      agent: 'codex',
      sourceSessionId: codexSession,
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

    const thread = await threads.createWorkThread(deviceA.context, {
      projectId: project.projectId,
      title: 'Implement hosted authentication',
      goal: 'Cross-agent device login',
    });
    await threads.assignSession(deviceA.context, thread.workThreadId, {
      sourceSessionId: claudeSession,
      assignment: 'confirmed',
    });

    // Device B's Codex session is suggested for the same thread, then confirmed.
    const suggestions = await threads.suggestThreads(
      deviceA.context,
      project.projectId,
      codexSession,
    );
    expect(suggestions.suggestions[0]?.workThread.workThreadId).toBe(
      thread.workThreadId,
    );
    await threads.assignSession(deviceA.context, thread.workThreadId, {
      sourceSessionId: codexSession,
      assignment: 'suggested',
    });
    const confirmed = await threads.assignSession(
      deviceA.context,
      thread.workThreadId,
      {
        sourceSessionId: codexSession,
        assignment: 'confirmed',
      },
    );
    expect(confirmed.assignment).toBe('confirmed');

    const sessions = await threads.listThreadSessions(
      deviceA.context,
      thread.workThreadId,
    );
    expect(
      sessions.sessions.map((s) => s.sourceSession.sourceAgent).sort(),
    ).toEqual(['claudecode', 'codex']);

    const readback = await threads.readWorkThreadEvents(
      deviceA.context,
      thread.workThreadId,
      { limit: 500 },
    );
    expect(new Set(readback.events.map((e) => e.sourceAgent))).toEqual(
      new Set(['claudecode', 'codex']),
    );
    expect(readback.events).toHaveLength(7);

    const overview = await threads.getWorkThreadOverview(
      deviceA.context,
      thread.workThreadId,
    );
    expect(overview.decisions.map((d) => d.summary)).toContain(
      'Use device authorization grant',
    );
    expect(overview.tasks.map((t) => t.text)).toContain(
      'Finish token exchange',
    );

    // A second tenant cannot see or mutate the thread.
    const otherAccount = await establishAccount();
    const otherDevice = await registerDevice(otherAccount, 'other');
    await expect(
      threads.readWorkThreadEvents(
        otherDevice.context,
        thread.workThreadId,
        {},
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  interface Device {
    context: { principal: AuthPrincipal; requestId: string };
    deviceId: string;
  }

  interface Account {
    browserToken: string;
  }

  async function establishAccount(): Promise<Account> {
    const subject = `wt-${randomUUID()}`;
    const session = await identity.establishBrowserSession(
      {
        issuer: 'https://integration.example.test',
        subject,
        email: `${subject}@example.test`,
        displayName: subject,
      },
      { requestId: randomUUID() },
    );
    return { browserToken: session.sessionToken };
  }

  async function registerDevice(
    account: Account,
    label: string,
  ): Promise<Device> {
    const browser = await identity.authenticateBrowserSession(
      account.browserToken,
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

  async function seedSession(
    device: Device,
    projectId: string,
    options: {
      agent: 'claudecode' | 'codex';
      sourceSessionId: string;
      nativeSessionHash: string;
      payloads: SourceEventInput['payload'][];
    },
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
    const events = options.payloads.map((payload, index) =>
      createSourceEvent({
        sourceSessionId: options.sourceSessionId,
        workThreadId: null,
        sourceAgent: options.agent,
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
        sourceSessionId: options.sourceSessionId,
        agent: options.agent,
        nativeSessionHash: options.nativeSessionHash,
        parserVersion: 'integration-v1',
      },
      expectedHeadEventId: null,
      previousCursor: null,
      proposedCursor: 'cursor:1',
      events,
    });
  }
});
