import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { IdentityService, type AuthPrincipal } from '@baton/auth';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/client.js';
import type { IngestionRequestContext } from '../src/ingestion-store.js';
import { PostgresIdentityStore } from '../src/postgres-identity-store.js';
import { PostgresMemoryStore } from '../src/postgres-memory-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

integration('Postgres Phase 6 memory', () => {
  let database: DatabaseClient;
  let identity: IdentityService;
  let store: PostgresMemoryStore;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../migrations', import.meta.url),
      ),
    });
    identity = new IdentityService(new PostgresIdentityStore(database.db), {
      tokenPepper:
        'memory-integration-pepper-longer-than-thirty-two-characters!!',
      verificationUri: 'https://app.example.test/activate',
      devicePollingIntervalSeconds: 1,
    });
    store = new PostgresMemoryStore(database.db);
  });

  afterAll(async () => database?.close());

  it('validates, approves, and returns only approved memories, isolating tenants', async () => {
    const owner = await accountContext('owner');

    const rejected = await store.proposeCandidate(owner, {
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
    });
    expect(rejected.status).toBe('rejected');

    const candidate = await store.proposeCandidate(owner, {
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
    });
    expect(candidate.status).toBe('proposed');
    expect((await store.listMemories(owner)).memories).toHaveLength(0);

    const memory = await store.approveCandidate(
      owner,
      candidate.candidateId,
      {},
    );
    expect(memory.status).toBe('approved');
    expect((await store.listMemories(owner)).memories).toHaveLength(1);

    const soul = await store.renderSoulDocument(owner, { tokenBudget: 1000 });
    expect(soul.text).toContain('Prefers concise answers');

    const other = await accountContext('intruder');
    expect((await store.listMemories(other)).memories).toHaveLength(0);
    expect((await store.listCandidates(other)).candidates).toHaveLength(0);
  });

  async function accountContext(
    label: string,
  ): Promise<IngestionRequestContext> {
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
    const principal: AuthPrincipal = await identity.authenticateBrowserSession(
      session.sessionToken,
    );
    return { principal, requestId: randomUUID() };
  }
});
