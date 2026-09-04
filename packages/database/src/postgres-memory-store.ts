import { randomUUID } from 'node:crypto';

import {
  renderSoul,
  screenProhibitedClaim,
  validateMemoryCandidate,
} from '@baton/memory';
import type {
  ApproveMemoryRequest,
  Memory,
  MemoryCandidate,
  MemoryCandidateList,
  MemoryList,
  MemoryScope,
  MemoryStatus,
  SoulDocument,
} from '@baton/protocol';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

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
import { identitySchema, memories, memoryCandidates } from './schema.js';

type Database = PostgresJsDatabase<typeof identitySchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PostgresMemoryStore implements MemoryStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async proposeCandidate(
    context: IngestionRequestContext,
    input: MemoryProposeInput,
  ): Promise<MemoryCandidate> {
    const signature = memorySignature(input.claim, input.scope);
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const existing = await tx
        .select()
        .from(memoryCandidates)
        .where(eq(memoryCandidates.tenantId, context.principal.tenantId));
      const match = existing.find(
        (row) => memorySignature(row.claim, scopeOf(row)) === signature,
      );
      if (match !== undefined) return candidateFromRow(match);

      const validation = validateMemoryCandidate({
        claim: input.claim,
        scopeType: input.scope.type,
        evidence: input.evidence,
      });
      const status: MemoryStatus =
        validation.verdict === 'accept'
          ? 'proposed'
          : validation.verdict === 'needs_review'
            ? 'needs_review'
            : 'rejected';
      const now = new Date(this.now());
      const [row] = await tx
        .insert(memoryCandidates)
        .values({
          tenantId: context.principal.tenantId,
          candidateId: randomUUID(),
          category: input.category,
          claim: input.claim,
          scopeType: input.scope.type,
          scopeId: input.scope.id,
          confidence: toMilli(validation.confidence),
          status,
          reasonCode: validation.reasonCode,
          provenance: input.provenance ?? manualProvenance,
          evidenceEventIds: input.evidence.map((item) => item.eventId),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return candidateFromRow(row!);
    });
  }

  async listCandidates(
    context: IngestionRequestContext,
    statuses?: MemoryStatus[],
  ): Promise<MemoryCandidateList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const rows = await tx
        .select()
        .from(memoryCandidates)
        .where(
          statuses === undefined || statuses.length === 0
            ? eq(memoryCandidates.tenantId, context.principal.tenantId)
            : and(
                eq(memoryCandidates.tenantId, context.principal.tenantId),
                inArray(memoryCandidates.status, statuses),
              ),
        )
        .orderBy(desc(memoryCandidates.updatedAt));
      return { candidates: rows.map(candidateFromRow) };
    });
  }

  async approveCandidate(
    context: IngestionRequestContext,
    candidateId: string,
    input: ApproveMemoryRequest,
  ): Promise<Memory> {
    return this.db.transaction(
      async (tx) => {
        await setTenant(tx, context.principal.tenantId);
        const [candidate] = await tx
          .select()
          .from(memoryCandidates)
          .where(
            and(
              eq(memoryCandidates.tenantId, context.principal.tenantId),
              eq(memoryCandidates.candidateId, candidateId),
            ),
          )
          .limit(1)
          .for('update');
        if (candidate === undefined) notFound('memory candidate');
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
        const scope: MemoryScope = input.scope ?? scopeOf(candidate);
        if (screenProhibitedClaim(claim) !== null) {
          throw new IngestionStoreError(
            'invalid_request',
            400,
            'The claim asserts a prohibited sensitive inference and cannot be approved.',
          );
        }
        const now = new Date(this.now());
        const [memoryRow] = await tx
          .insert(memories)
          .values({
            tenantId: context.principal.tenantId,
            memoryId: randomUUID(),
            candidateId,
            category: candidate.category,
            claim,
            scopeType: scope.type,
            scopeId: scope.id,
            confidence: candidate.confidence,
            status: 'approved',
            provenance: candidate.provenance,
            evidenceEventIds: candidate.evidenceEventIds,
            firstObservedAt: candidate.createdAt,
            lastConfirmedAt: now,
            expiresAt:
              input.expiresAt === undefined || input.expiresAt === null
                ? null
                : new Date(input.expiresAt),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await tx
          .update(memoryCandidates)
          .set({ status: 'approved', updatedAt: now })
          .where(
            and(
              eq(memoryCandidates.tenantId, context.principal.tenantId),
              eq(memoryCandidates.candidateId, candidateId),
            ),
          );
        return memoryFromRow(memoryRow!);
      },
      { isolationLevel: 'serializable' },
    );
  }

  async rejectCandidate(
    context: IngestionRequestContext,
    candidateId: string,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const [row] = await tx
        .update(memoryCandidates)
        .set({ status: 'rejected', updatedAt: new Date(this.now()) })
        .where(
          and(
            eq(memoryCandidates.tenantId, context.principal.tenantId),
            eq(memoryCandidates.candidateId, candidateId),
          ),
        )
        .returning({ id: memoryCandidates.candidateId });
      if (row === undefined) notFound('memory candidate');
    });
  }

  async listMemories(
    context: IngestionRequestContext,
    filter?: MemoryScopeFilter,
  ): Promise<MemoryList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const rows = await tx
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.tenantId, context.principal.tenantId),
            eq(memories.status, 'approved'),
          ),
        )
        .orderBy(desc(memories.lastConfirmedAt));
      const nowMs = this.now();
      return {
        memories: rows
          .map(memoryFromRow)
          .filter(
            (memory) =>
              isLiveMemory(memory, nowMs) &&
              matchesScopeFilter(memory.scope, filter),
          ),
      };
    });
  }

  async revokeMemory(
    context: IngestionRequestContext,
    memoryId: string,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const [row] = await tx
        .update(memories)
        .set({ status: 'revoked', updatedAt: new Date(this.now()) })
        .where(
          and(
            eq(memories.tenantId, context.principal.tenantId),
            eq(memories.memoryId, memoryId),
          ),
        )
        .returning({ id: memories.memoryId });
      if (row === undefined) notFound('memory');
    });
  }

  async renderSoulDocument(
    context: IngestionRequestContext,
    options: { tokenBudget: number; filter?: MemoryScopeFilter },
  ): Promise<SoulDocument> {
    const list = await this.listMemories(context, options.filter);
    return renderSoul(list.memories, { tokenBudget: options.tokenBudget });
  }
}

function scopeOf(row: {
  scopeType: MemoryScope['type'];
  scopeId: string | null;
}): MemoryScope {
  return { type: row.scopeType, id: row.scopeId };
}

function candidateFromRow(
  row: typeof memoryCandidates.$inferSelect,
): MemoryCandidate {
  return {
    candidateId: row.candidateId,
    category: row.category,
    claim: row.claim,
    scope: scopeOf(row),
    confidence: fromMilli(row.confidence),
    status: row.status,
    reasonCode: (row.reasonCode as MemoryCandidate['reasonCode']) ?? null,
    evidenceEventIds: row.evidenceEventIds,
    provenance: row.provenance,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function memoryFromRow(row: typeof memories.$inferSelect): Memory {
  return {
    memoryId: row.memoryId,
    category: row.category,
    claim: row.claim,
    scope: scopeOf(row),
    confidence: fromMilli(row.confidence),
    status: row.status,
    evidenceEventIds: row.evidenceEventIds,
    provenance: row.provenance,
    firstObservedAt: row.firstObservedAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

async function setTenant(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config('baton.tenant_id', ${tenantId}, true)`,
  );
}

function notFound(label: string): never {
  throw new IngestionStoreError(
    'not_found',
    404,
    `The ${label} was not found.`,
  );
}
