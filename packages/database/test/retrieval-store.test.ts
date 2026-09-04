import { randomUUID } from 'node:crypto';

import type { AuthPrincipal } from '@baton/auth';
import {
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type CollectionPolicy,
  type SourceEventInput,
} from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import type { IngestionRequestContext } from '../src/ingestion-store.js';
import { InMemoryIngestionStore } from '../src/memory-ingestion-store.js';
import { InMemoryRetrievalStore } from '../src/memory-retrieval-store.js';

const policy: CollectionPolicy = {
  policyVersion: 'retrieval-test-v1',
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

function context(
  tenantId: string,
  userId: string,
  deviceId: string,
): IngestionRequestContext {
  const principal: AuthPrincipal = {
    userId,
    tenantId,
    deviceId,
    scopes: ['projects:write', 'ingest:write', 'work:read'],
    credentialKind: 'access_token',
    credentialId: randomUUID(),
  };
  return { principal, requestId: randomUUID() };
}

async function seed(
  ingestion: InMemoryIngestionStore,
  ctx: IngestionRequestContext,
  projectId: string,
  sourceSessionId: string,
  payloads: SourceEventInput['payload'][],
): Promise<void> {
  const installationId = randomUUID();
  const consent = await ingestion.recordConsent(ctx, projectId, {
    projectInstallationId: installationId,
    disclosureVersion: currentCollectionDisclosureVersion,
    disclosureDigest: currentCollectionDisclosureDigest,
    collectionPolicy: policy,
    cloudProcessingAcknowledged: true,
    modelProcessingAcknowledged: true,
    captureSurface: 'cli',
    historicalImport: false,
  });
  const events = payloads.map((payload, index) =>
    createSourceEvent({
      sourceSessionId,
      workThreadId: null,
      sourceAgent: 'claudecode',
      sourceDeviceId: ctx.principal.deviceId!,
      nativeSequence: index,
      parentEventId: null,
      occurredAt: new Date(
        Date.parse('2026-07-01T10:00:00Z') + index * 1000,
      ).toISOString(),
      observedAt: new Date(
        Date.parse('2026-07-01T10:00:00Z') + index * 1000,
      ).toISOString(),
      schemaVersion: 1,
      payload,
    }),
  );
  await ingestion.ingestBatch(ctx, {
    schemaVersion: 1,
    batchId: randomUUID(),
    deviceId: ctx.principal.deviceId!,
    projectId,
    projectInstallationId: installationId,
    consentRecordId: consent.consentRecordId,
    policyVersion: policy.policyVersion,
    disclosureVersion: currentCollectionDisclosureVersion,
    source: {
      sourceSessionId,
      agent: 'claudecode',
      nativeSessionHash: 'a'.repeat(64),
      parserVersion: 'test-v1',
    },
    expectedHeadEventId: null,
    previousCursor: null,
    proposedCursor: 'cursor:1',
    events,
  });
}

describe('InMemoryRetrievalStore', () => {
  it('indexes events and retrieves lexically relevant chunks', async () => {
    const ingestion = new InMemoryIngestionStore();
    const retrieval = new InMemoryRetrievalStore(ingestion);
    const ctx = context(randomUUID(), randomUUID(), randomUUID());
    const project = await ingestion.createProject(ctx, {
      displayName: 'Greeting',
      collectionPolicy: policy,
    });
    const session = randomUUID();
    await seed(ingestion, ctx, project.projectId, session, [
      {
        kind: 'message',
        role: 'assistant',
        text: 'Renamed the Greet function to Hello.',
      },
      {
        kind: 'file_change',
        path: 'greet.go',
        operation: 'edit',
        summary: 'rename',
      },
      { kind: 'task', text: 'Add unit tests', status: 'pending' },
    ]);

    const indexed = await retrieval.reindexProject(ctx, project.projectId);
    expect(indexed).toBe(3);

    const result = await retrieval.search(ctx, {
      projectId: project.projectId,
      query: 'What happened to the Greet function?',
    });
    expect(result.lexicalFallback).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]!.text).toContain('Hello');
    for (const chunk of result.chunks) {
      expect(chunk.sourceEventIds.length).toBeGreaterThan(0);
    }

    const pending = await retrieval.search(ctx, {
      projectId: project.projectId,
      query: 'pending tests',
    });
    expect(pending.chunks[0]!.text).toContain('Add unit tests');
  });

  it('denies retrieval for a project in another tenant', async () => {
    const ingestion = new InMemoryIngestionStore();
    const retrieval = new InMemoryRetrievalStore(ingestion);
    const owner = context(randomUUID(), randomUUID(), randomUUID());
    const project = await ingestion.createProject(owner, {
      displayName: 'Private',
      collectionPolicy: policy,
    });
    const other = context(randomUUID(), randomUUID(), randomUUID());
    await expect(
      retrieval.search(other, {
        projectId: project.projectId,
        query: 'anything',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('scopes retrieval to the requested source sessions', async () => {
    const ingestion = new InMemoryIngestionStore();
    const retrieval = new InMemoryRetrievalStore(ingestion);
    const ctx = context(randomUUID(), randomUUID(), randomUUID());
    const project = await ingestion.createProject(ctx, {
      displayName: 'Two sessions',
      collectionPolicy: policy,
    });
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    await seed(ingestion, ctx, project.projectId, sessionA, [
      { kind: 'message', role: 'user', text: 'alpha rename greet' },
    ]);
    await seed(ingestion, ctx, project.projectId, sessionB, [
      { kind: 'message', role: 'user', text: 'beta rename greet' },
    ]);
    await retrieval.reindexProject(ctx, project.projectId);

    const scoped = await retrieval.search(ctx, {
      projectId: project.projectId,
      sourceSessionIds: [sessionA],
      query: 'rename greet',
    });
    expect(scoped.chunks).toHaveLength(1);
    expect(scoped.chunks[0]!.sourceSessionId).toBe(sessionA);
  });
});
