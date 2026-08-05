import { randomUUID } from 'node:crypto';

import type { AuthPrincipal } from '@baton/auth';
import {
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type CollectionPolicy,
  type SourceEventInput,
} from '@baton/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { IngestionRequestContext } from '../src/ingestion-store.js';
import { InMemoryIngestionStore } from '../src/memory-ingestion-store.js';
import { InMemoryWorkThreadStore } from '../src/memory-work-thread-store.js';

const policy: CollectionPolicy = {
  policyVersion: 'work-thread-test-v1',
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

function principal(
  tenantId: string,
  userId: string,
  deviceId: string,
): AuthPrincipal {
  return {
    userId,
    tenantId,
    deviceId,
    scopes: ['projects:read', 'projects:write', 'ingest:write', 'work:read'],
    credentialKind: 'access_token',
    credentialId: randomUUID(),
  };
}

function context(auth: AuthPrincipal): IngestionRequestContext {
  return { principal: auth, requestId: randomUUID() };
}

async function seedSession(
  ingestion: InMemoryIngestionStore,
  ctx: IngestionRequestContext,
  projectId: string,
  options: {
    agent: 'claudecode' | 'codex';
    deviceId: string;
    sourceSessionId: string;
    nativeSessionHash: string;
    payloads: SourceEventInput['payload'][];
  },
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
  const events = options.payloads.map((payload, index) =>
    createSourceEvent({
      sourceSessionId: options.sourceSessionId,
      workThreadId: null,
      sourceAgent: options.agent,
      sourceDeviceId: options.deviceId,
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
    deviceId: options.deviceId,
    projectId,
    projectInstallationId: installationId,
    consentRecordId: consent.consentRecordId,
    policyVersion: policy.policyVersion,
    disclosureVersion: currentCollectionDisclosureVersion,
    source: {
      sourceSessionId: options.sourceSessionId,
      agent: options.agent,
      nativeSessionHash: options.nativeSessionHash,
      parserVersion: 'test-v1',
    },
    expectedHeadEventId: null,
    previousCursor: null,
    proposedCursor: 'cursor:1',
    events,
  });
}

describe('InMemoryWorkThreadStore cross-agent threads', () => {
  let ingestion: InMemoryIngestionStore;
  let threads: InMemoryWorkThreadStore;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  const claudeSession = randomUUID();
  const codexSession = randomUUID();
  let projectId: string;
  let ctxA: IngestionRequestContext;

  beforeEach(async () => {
    ingestion = new InMemoryIngestionStore();
    threads = new InMemoryWorkThreadStore(ingestion);
    ctxA = context(principal(tenantId, userId, deviceA));
    const project = await ingestion.createProject(ctxA, {
      displayName: 'Hosted auth',
      collectionPolicy: policy,
    });
    projectId = project.projectId;
    await seedSession(ingestion, ctxA, projectId, {
      agent: 'claudecode',
      deviceId: deviceA,
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
    const ctxB = context(principal(tenantId, userId, deviceB));
    await seedSession(ingestion, ctxB, projectId, {
      agent: 'codex',
      deviceId: deviceB,
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
  });

  it('merges a Claude session and a Codex session into one confirmed thread', async () => {
    const thread = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Implement hosted authentication',
      goal: null,
    });
    await threads.assignSession(ctxA, thread.workThreadId, {
      sourceSessionId: claudeSession,
      assignment: 'confirmed',
    });
    // Second device's session joins as a suggestion, then the user confirms it.
    const suggested = await threads.assignSession(ctxA, thread.workThreadId, {
      sourceSessionId: codexSession,
      assignment: 'suggested',
    });
    expect(suggested.assignment).toBe('suggested');
    const confirmed = await threads.assignSession(ctxA, thread.workThreadId, {
      sourceSessionId: codexSession,
      assignment: 'confirmed',
    });
    expect(confirmed.assignment).toBe('confirmed');

    const sessions = await threads.listThreadSessions(
      ctxA,
      thread.workThreadId,
    );
    expect(sessions.sessions).toHaveLength(2);
    expect(
      sessions.sessions.map((s) => s.sourceSession.sourceAgent).sort(),
    ).toEqual(['claudecode', 'codex']);

    const readback = await threads.readWorkThreadEvents(
      ctxA,
      thread.workThreadId,
      {
        limit: 500,
      },
    );
    const agents = new Set(readback.events.map((event) => event.sourceAgent));
    expect(agents).toEqual(new Set(['claudecode', 'codex']));
    expect(readback.events.length).toBe(7);

    const overview = await threads.getWorkThreadOverview(
      ctxA,
      thread.workThreadId,
    );
    expect(overview.sessions).toHaveLength(2);
    expect(overview.decisions.map((d) => d.summary)).toContain(
      'Use device authorization grant',
    );
    expect(overview.tasks.map((t) => t.text)).toContain(
      'Finish token exchange',
    );
    expect(
      overview.fileActivities.find((f) => f.path === 'src/auth.ts')?.operations,
    ).toEqual(expect.arrayContaining(['create', 'edit']));
  });

  it('suggests the existing thread for the second device session', async () => {
    const thread = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Implement hosted authentication',
      goal: null,
    });
    await threads.assignSession(ctxA, thread.workThreadId, {
      sourceSessionId: claudeSession,
      assignment: 'confirmed',
    });
    const suggestions = await threads.suggestThreads(
      ctxA,
      projectId,
      codexSession,
    );
    expect(suggestions.suggestions).toHaveLength(1);
    expect(suggestions.suggestions[0]!.workThread.workThreadId).toBe(
      thread.workThreadId,
    );
    expect(suggestions.suggestions[0]!.reasons).toEqual(
      expect.arrayContaining(['shared_files', 'same_branch']),
    );
  });

  it('refuses to assign a source session to two threads', async () => {
    const first = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Thread one',
      goal: null,
    });
    const second = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Thread two',
      goal: null,
    });
    await threads.assignSession(ctxA, first.workThreadId, {
      sourceSessionId: claudeSession,
      assignment: 'confirmed',
    });
    await expect(
      threads.assignSession(ctxA, second.workThreadId, {
        sourceSessionId: claudeSession,
        assignment: 'confirmed',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('allows reassignment after removal', async () => {
    const first = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Thread one',
      goal: null,
    });
    const second = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Thread two',
      goal: null,
    });
    await threads.assignSession(ctxA, first.workThreadId, {
      sourceSessionId: claudeSession,
      assignment: 'confirmed',
    });
    await threads.removeSession(ctxA, first.workThreadId, claudeSession);
    const moved = await threads.assignSession(ctxA, second.workThreadId, {
      sourceSessionId: claudeSession,
      assignment: 'confirmed',
    });
    expect(moved.workThreadId).toBe(second.workThreadId);
  });

  it('isolates threads across tenants', async () => {
    const thread = await threads.createWorkThread(ctxA, {
      projectId,
      title: 'Tenant A thread',
      goal: null,
    });
    const otherTenant = context(
      principal(randomUUID(), randomUUID(), randomUUID()),
    );
    await expect(
      threads.updateWorkThread(otherTenant, thread.workThreadId, {
        state: 'archived',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      threads.listWorkThreads(otherTenant, projectId),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
