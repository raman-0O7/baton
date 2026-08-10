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
import { InMemoryLifecycleStore } from '../src/memory-lifecycle-store.js';
import { InMemoryMemoryStore } from '../src/memory-memory-store.js';
import { InMemoryRetrievalStore } from '../src/memory-retrieval-store.js';
import { InMemoryWorkThreadStore } from '../src/memory-work-thread-store.js';

const policy: CollectionPolicy = {
  policyVersion: 'lifecycle-test-v1',
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
    scopes: ['projects:write', 'ingest:write', 'work:read', 'memory:write'],
    credentialKind: 'access_token',
    credentialId: randomUUID(),
  };
  return { principal, requestId: randomUUID() };
}

async function seedSession(
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

describe('InMemoryLifecycleStore', () => {
  async function seedEverything() {
    const ingestion = new InMemoryIngestionStore();
    const workThreads = new InMemoryWorkThreadStore(ingestion);
    const retrieval = new InMemoryRetrievalStore(ingestion);
    const memory = new InMemoryMemoryStore();
    const lifecycle = new InMemoryLifecycleStore(
      ingestion,
      workThreads,
      retrieval,
      memory,
    );
    const ctx = context(randomUUID(), randomUUID(), randomUUID());
    const project = await ingestion.createProject(ctx, {
      displayName: 'Greeting',
      collectionPolicy: policy,
    });
    const session = randomUUID();
    await seedSession(ingestion, ctx, project.projectId, session, [
      { kind: 'message', role: 'assistant', text: 'Renamed Greet to Hello.' },
      { kind: 'decision', summary: 'Use Hello', rationale: 'clarity' },
    ]);
    const thread = await workThreads.createWorkThread(ctx, {
      projectId: project.projectId,
      title: 'Rename greeting',
      goal: null,
    });
    await workThreads.assignSession(ctx, thread.workThreadId, {
      sourceSessionId: session,
      assignment: 'confirmed',
    });
    await retrieval.reindexProject(ctx, project.projectId);
    const candidate = await memory.proposeCandidate(ctx, {
      category: 'engineering_workflow',
      claim: 'Avoids ORMs.',
      scope: { type: 'project', id: project.projectId },
      evidence: [
        {
          eventId: randomUUID(),
          projectId: project.projectId,
          workThreadId: null,
          text: 'No ORM here.',
        },
        {
          eventId: randomUUID(),
          projectId: project.projectId,
          workThreadId: null,
          text: 'Still no ORM.',
        },
      ],
    });
    await memory.approveCandidate(ctx, candidate.candidateId, {});
    return {
      ingestion,
      workThreads,
      retrieval,
      memory,
      lifecycle,
      ctx,
      project,
    };
  }

  it('exports the account content across every store', async () => {
    const { lifecycle, ctx, project } = await seedEverything();
    const archive = await lifecycle.exportContent(ctx, null);
    expect(archive.projects.map((p) => p.projectId)).toContain(
      project.projectId,
    );
    expect(archive.workThreads).toHaveLength(1);
    expect(archive.events.length).toBe(2);
    expect(archive.memories.map((m) => m.claim)).toContain('Avoids ORMs.');
  });

  it('deletes a project across every store so nothing is queryable', async () => {
    const {
      ingestion,
      workThreads,
      retrieval,
      memory,
      lifecycle,
      ctx,
      project,
    } = await seedEverything();
    const receipt = await lifecycle.deleteProject(ctx, project.projectId);
    expect(receipt.complete).toBe(true);
    expect(receipt.deletedCounts.events).toBe(2);
    expect(receipt.deletedCounts.work_threads).toBe(1);
    expect(receipt.deletedCounts.chunks).toBeGreaterThan(0);
    expect(receipt.deletedCounts.memories).toBe(1);

    // The project and all of its content are gone from every read path.
    expect(
      ingestion.projectExists(ctx.principal.tenantId, project.projectId),
    ).toBe(false);
    await expect(
      workThreads.listWorkThreads(ctx, project.projectId),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      retrieval.search(ctx, { projectId: project.projectId, query: 'greet' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await memory.listMemories(ctx)).memories).toHaveLength(0);
  });

  it('deletes an entire account', async () => {
    const { ingestion, memory, lifecycle, ctx } = await seedEverything();
    const receipt = await lifecycle.deleteAccount(ctx);
    expect(receipt.scope).toBe('account');
    expect(receipt.deletedCounts.projects).toBe(1);
    expect((await ingestion.listProjects(ctx)).projects).toHaveLength(0);
    expect((await memory.listMemories(ctx)).memories).toHaveLength(0);
    expect((await memory.listCandidates(ctx)).candidates).toHaveLength(0);
  });
});
