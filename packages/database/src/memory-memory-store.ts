import { randomUUID } from 'node:crypto';

import type {
  ApproveMemoryRequest,
  Memory,
  MemoryCandidate,
  MemoryCandidateList,
  MemoryList,
  MemoryProvenance,
  MemoryScope,
  MemoryStatus,
  SoulDocument,
} from '@baton/protocol';
import {
  renderSoul,
  screenProhibitedClaim,
  validateMemoryCandidate,
} from '@baton/memory';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import {
  fromMilli,
  isLiveMemory,
  manualProvenance,
  matchesScopeFilter,
  memorySignature,
  toMilli,
  type MemoryProposeInput,
  type MemoryScopeFilter,
  type MemoryStore,
} from './memory-store.js';

interface StoredCandidate {
  tenantId: string;
  candidate: MemoryCandidate;
  signature: string;
}

interface StoredMemory {
  tenantId: string;
  memory: Memory;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly candidates = new Map<string, StoredCandidate>();
  private readonly memories = new Map<string, StoredMemory>();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  async proposeCandidate(
    context: IngestionRequestContext,
    input: MemoryProposeInput,
  ): Promise<MemoryCandidate> {
    return this.exclusive(() => {
      const signature = memorySignature(input.claim, input.scope);
      const existing = [...this.candidates.values()].find(
        (entry) =>
          entry.tenantId === context.principal.tenantId &&
          entry.signature === signature,
      );
      // An identical proposal is never regenerated (respects a prior rejection).
      if (existing !== undefined) return structuredClone(existing.candidate);

      const validation = validateMemoryCandidate({
        claim: input.claim,
        scopeType: input.scope.type,
        evidence: input.evidence.map((item) => ({
          eventId: item.eventId,
          projectId: item.projectId,
          workThreadId: item.workThreadId,
          text: item.text,
          ...(item.role === undefined ? {} : { role: item.role }),
        })),
      });
      const status: MemoryStatus =
        validation.verdict === 'accept'
          ? 'proposed'
          : validation.verdict === 'needs_review'
            ? 'needs_review'
            : 'rejected';
      const now = new Date(this.now()).toISOString();
      const candidate: MemoryCandidate = {
        candidateId: randomUUID(),
        category: input.category,
        claim: input.claim,
        scope: structuredClone(input.scope),
        confidence: fromMilli(toMilli(validation.confidence)),
        status,
        reasonCode: validation.reasonCode,
        evidenceEventIds: input.evidence.map((item) => item.eventId),
        provenance: provenanceOf(input.provenance),
        createdAt: now,
        updatedAt: now,
      };
      this.candidates.set(
        candidateKey(context.principal.tenantId, candidate.candidateId),
        {
          tenantId: context.principal.tenantId,
          candidate,
          signature,
        },
      );
      return structuredClone(candidate);
    });
  }

  async listCandidates(
    context: IngestionRequestContext,
    statuses?: MemoryStatus[],
  ): Promise<MemoryCandidateList> {
    return this.exclusive(() => ({
      candidates: [...this.candidates.values()]
        .filter(
          (entry) =>
            entry.tenantId === context.principal.tenantId &&
            (statuses === undefined ||
              statuses.includes(entry.candidate.status)),
        )
        .map((entry) => structuredClone(entry.candidate))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }));
  }

  async approveCandidate(
    context: IngestionRequestContext,
    candidateId: string,
    input: ApproveMemoryRequest,
  ): Promise<Memory> {
    return this.exclusive(() => {
      const entry = this.candidates.get(
        candidateKey(context.principal.tenantId, candidateId),
      );
      if (entry === undefined || entry.tenantId !== context.principal.tenantId)
        notFound('memory candidate');
      const candidate = entry.candidate;
      if (
        candidate.status !== 'proposed' &&
        candidate.status !== 'needs_review'
      ) {
        throw new IngestionStoreError(
          'conflict',
          409,
          'Only a proposed or review candidate can be approved.',
        );
      }
      const claim = input.claim ?? candidate.claim;
      const scope: MemoryScope = input.scope ?? candidate.scope;
      // Re-screen: an edit can never introduce a prohibited sensitive claim.
      if (screenProhibitedClaim(claim) !== null) {
        throw new IngestionStoreError(
          'invalid_request',
          400,
          'The claim asserts a prohibited sensitive inference and cannot be approved.',
        );
      }
      const now = new Date(this.now()).toISOString();
      const memory: Memory = {
        memoryId: randomUUID(),
        category: candidate.category,
        claim,
        scope: structuredClone(scope),
        confidence: candidate.confidence,
        status: 'approved',
        evidenceEventIds: [...candidate.evidenceEventIds],
        provenance: structuredClone(candidate.provenance),
        firstObservedAt: candidate.createdAt,
        lastConfirmedAt: now,
        expiresAt: input.expiresAt ?? null,
      };
      this.memories.set(
        memoryKey(context.principal.tenantId, memory.memoryId),
        {
          tenantId: context.principal.tenantId,
          memory,
        },
      );
      candidate.status = 'approved';
      candidate.updatedAt = now;
      return structuredClone(memory);
    });
  }

  async rejectCandidate(
    context: IngestionRequestContext,
    candidateId: string,
  ): Promise<void> {
    return this.exclusive(() => {
      const entry = this.candidates.get(
        candidateKey(context.principal.tenantId, candidateId),
      );
      if (entry === undefined || entry.tenantId !== context.principal.tenantId)
        notFound('memory candidate');
      entry.candidate.status = 'rejected';
      entry.candidate.updatedAt = new Date(this.now()).toISOString();
    });
  }

  async listMemories(
    context: IngestionRequestContext,
    filter?: MemoryScopeFilter,
  ): Promise<MemoryList> {
    return this.exclusive(() => ({
      memories: this.liveMemories(context, filter).map((memory) =>
        structuredClone(memory),
      ),
    }));
  }

  async revokeMemory(
    context: IngestionRequestContext,
    memoryId: string,
  ): Promise<void> {
    return this.exclusive(() => {
      const entry = this.memories.get(
        memoryKey(context.principal.tenantId, memoryId),
      );
      if (entry === undefined || entry.tenantId !== context.principal.tenantId)
        notFound('memory');
      entry.memory.status = 'revoked';
    });
  }

  async renderSoulDocument(
    context: IngestionRequestContext,
    options: { tokenBudget: number; filter?: MemoryScopeFilter },
  ): Promise<SoulDocument> {
    return this.exclusive(() =>
      renderSoul(this.liveMemories(context, options.filter), {
        tokenBudget: options.tokenBudget,
      }),
    );
  }

  private liveMemories(
    context: IngestionRequestContext,
    filter?: MemoryScopeFilter,
  ): Memory[] {
    const nowMs = this.now();
    return [...this.memories.values()]
      .filter(
        (entry) =>
          entry.tenantId === context.principal.tenantId &&
          isLiveMemory(entry.memory, nowMs) &&
          matchesScopeFilter(entry.memory.scope, filter),
      )
      .map((entry) => entry.memory);
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function provenanceOf(
  provenance: MemoryProvenance | undefined,
): MemoryProvenance {
  return provenance === undefined ? manualProvenance : provenance;
}

function candidateKey(tenantId: string, candidateId: string): string {
  return `${tenantId}:${candidateId}`;
}

function memoryKey(tenantId: string, memoryId: string): string {
  return `${tenantId}:${memoryId}`;
}

function notFound(label: string): never {
  throw new IngestionStoreError(
    'not_found',
    404,
    `The ${label} was not found.`,
  );
}
