import { randomUUID } from 'node:crypto';

import type { AuthPrincipal } from '@baton/auth';
import { describe, expect, it } from 'vitest';

import type { IngestionRequestContext } from '../src/ingestion-store.js';
import { InMemoryMemoryStore } from '../src/memory-memory-store.js';
import type { MemoryEvidence } from '../src/memory-store.js';

function context(tenantId = randomUUID()): IngestionRequestContext {
  const principal: AuthPrincipal = {
    userId: randomUUID(),
    tenantId,
    deviceId: null,
    scopes: ['memory:read', 'memory:write'],
    credentialKind: 'browser_session',
    credentialId: randomUUID(),
  };
  return { principal, requestId: randomUUID() };
}

function evidence(
  projectId: string,
  text: string,
  workThreadId: string | null = null,
): MemoryEvidence {
  return { eventId: randomUUID(), projectId, workThreadId, text, role: 'user' };
}

describe('InMemoryMemoryStore', () => {
  it('accepts a repeated cross-project preference and renders it in SOUL with evidence', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = context();
    const candidate = await store.proposeCandidate(ctx, {
      category: 'communication_preference',
      claim: 'Prefers concise answers by default.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-a', 'Keep your answers concise.'),
        evidence('project-b', 'Please keep this concise too.'),
      ],
    });
    expect(candidate.status).toBe('proposed');

    // Not visible to agents until approved.
    expect((await store.listMemories(ctx)).memories).toHaveLength(0);

    const memory = await store.approveCandidate(ctx, candidate.candidateId, {});
    expect(memory.status).toBe('approved');

    const listed = await store.listMemories(ctx);
    expect(listed.memories).toHaveLength(1);
    expect(listed.memories[0]!.evidenceEventIds.length).toBe(2);

    const soul = await store.renderSoulDocument(ctx, { tokenBudget: 1000 });
    expect(soul.text).toContain('Prefers concise answers');
    expect(soul.text).toContain('evidence');
  });

  it('records a prohibited sensitive inference as rejected and never approvable', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = context();
    const candidate = await store.proposeCandidate(ctx, {
      category: 'communication_preference',
      claim: 'The user has diabetes.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-c', 'Schedule around my insulin appointment.'),
      ],
    });
    expect(candidate.status).toBe('rejected');
    expect(candidate.reasonCode).toBe('sensitive_health_inference_prohibited');
    await expect(
      store.approveCandidate(ctx, candidate.candidateId, {}),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.listMemories(ctx)).memories).toHaveLength(0);
  });

  it('marks contradictory evidence for review rather than accepting', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = context();
    const candidate = await store.proposeCandidate(ctx, {
      category: 'communication_preference',
      claim: 'Always wants terse answers.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-a', 'Give me just the commands.'),
        evidence(
          'project-a',
          'This is unfamiliar; explain every step in detail.',
        ),
      ],
    });
    expect(candidate.status).toBe('needs_review');
  });

  it('downscopes an over-broad project rule and accepts it at project scope', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = context();
    const tooBroad = await store.proposeCandidate(ctx, {
      category: 'engineering_workflow',
      claim: 'Avoids ORMs.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-a', 'For this service, do not introduce an ORM.'),
      ],
    });
    expect(tooBroad.status).toBe('rejected');
    expect(tooBroad.reasonCode).toBe('scope_too_broad');

    const projectId = randomUUID();
    const scoped = await store.proposeCandidate(ctx, {
      category: 'engineering_workflow',
      claim: 'Avoids ORMs.',
      scope: { type: 'project', id: projectId },
      evidence: [
        evidence('project-a', 'For this service, do not introduce an ORM.'),
        evidence('project-a', 'Still no ORM here please.'),
      ],
    });
    expect(scoped.status).toBe('proposed');
  });

  it('refuses to approve a claim edited into a prohibited inference', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = context();
    const candidate = await store.proposeCandidate(ctx, {
      category: 'communication_preference',
      claim: 'Prefers concise answers by default.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-a', 'Keep answers concise.'),
        evidence('project-b', 'Concise please.'),
      ],
    });
    await expect(
      store.approveCandidate(ctx, candidate.candidateId, {
        claim: 'The user is being treated for depression.',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('does not regenerate an identical rejected proposal and isolates tenants', async () => {
    const store = new InMemoryMemoryStore();
    const ctx = context();
    const first = await store.proposeCandidate(ctx, {
      category: 'tooling_preference',
      claim: 'Prefers tabs.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-a', 'Use tabs in this generated Makefile only.'),
      ],
    });
    const second = await store.proposeCandidate(ctx, {
      category: 'tooling_preference',
      claim: 'Prefers tabs.',
      scope: { type: 'global', id: null },
      evidence: [
        evidence('project-a', 'Use tabs in this generated Makefile only.'),
      ],
    });
    expect(second.candidateId).toBe(first.candidateId);

    const other = context();
    expect((await store.listCandidates(other)).candidates).toHaveLength(0);
  });
});
