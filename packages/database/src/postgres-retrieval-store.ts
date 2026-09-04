import { chunkEvents, type Chunk } from '@baton/indexing';
import type {
  RetrievalResult,
  RetrievedChunk,
  SourceEvent,
} from '@baton/protocol';
import { extractTerms } from '@baton/retrieval';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import {
  chunks as chunksTable,
  identitySchema,
  projects,
  sourceEvents,
  sourceSessions,
} from './schema.js';
import {
  defaultRetrievalLimit,
  maxRetrievalLimit,
  type RetrievalSearch,
  type RetrievalStore,
} from './retrieval-store.js';

type Database = PostgresJsDatabase<typeof identitySchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PostgresRetrievalStore implements RetrievalStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async reindexProject(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, projectId);
      const sessions = await tx
        .select({
          sourceSessionId: sourceSessions.sourceSessionId,
        })
        .from(sourceSessions)
        .where(
          and(
            eq(sourceSessions.tenantId, context.principal.tenantId),
            eq(sourceSessions.projectId, projectId),
          ),
        );
      const materialized: Chunk[] = [];
      for (const session of sessions) {
        const rows = await tx
          .select()
          .from(sourceEvents)
          .where(
            and(
              eq(sourceEvents.tenantId, context.principal.tenantId),
              eq(sourceEvents.sourceSessionId, session.sourceSessionId),
            ),
          );
        const events = rows.map(sourceEventFromRow).sort(compareEvents);
        materialized.push(...chunkEvents(events, projectId));
      }

      await tx
        .delete(chunksTable)
        .where(
          and(
            eq(chunksTable.tenantId, context.principal.tenantId),
            eq(chunksTable.projectId, projectId),
          ),
        );
      const now = new Date(this.now());
      if (materialized.length > 0) {
        await tx.insert(chunksTable).values(
          materialized.map((chunk) => ({
            tenantId: context.principal.tenantId,
            chunkId: chunk.chunkId,
            projectId,
            workThreadId: chunk.workThreadId,
            sourceSessionId: chunk.sourceSessionId,
            sourceAgent: chunk.sourceAgent,
            kind: chunk.kind,
            text: chunk.text,
            filePaths: chunk.filePaths,
            sourceEventIds: chunk.sourceEventIds,
            occurredAt: new Date(chunk.occurredAt),
            tokenEstimate: chunk.tokenEstimate,
            createdAt: now,
          })),
        );
      }
      return materialized.length;
    });
  }

  async search(
    context: IngestionRequestContext,
    search: RetrievalSearch,
  ): Promise<RetrievalResult> {
    const limit = Math.min(
      search.limit ?? defaultRetrievalLimit,
      maxRetrievalLimit,
    );
    // Extract lexemes in JS and OR them together so retrieval matches on any
    // query term (the deterministic lexical fallback), rather than the AND
    // semantics of websearch/plainto tsquery.
    const terms = extractTerms(search.query);
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, search.projectId);
      if (terms.length === 0) {
        return {
          query: search.query,
          projectId: search.projectId,
          workThreadId: search.workThreadId ?? null,
          chunks: [],
          lexicalFallback: true as const,
        };
      }
      const sessionFilter =
        search.sourceSessionIds === undefined
          ? sql``
          : search.sourceSessionIds.length === 0
            ? sql` and false`
            : sql` and ${inArray(chunksTable.sourceSessionId, search.sourceSessionIds)}`;
      const searchVector = sql`search_vector`;
      const tsquery = sql`to_tsquery('english', ${terms.join(' | ')})`;
      const rows = await tx
        .select({
          chunkId: chunksTable.chunkId,
          workThreadId: chunksTable.workThreadId,
          sourceSessionId: chunksTable.sourceSessionId,
          sourceAgent: chunksTable.sourceAgent,
          kind: chunksTable.kind,
          text: chunksTable.text,
          filePaths: chunksTable.filePaths,
          sourceEventIds: chunksTable.sourceEventIds,
          occurredAt: chunksTable.occurredAt,
          tokenEstimate: chunksTable.tokenEstimate,
          rank: sql<number>`ts_rank_cd(${searchVector}, ${tsquery})`,
        })
        .from(chunksTable)
        .where(
          sql`${eq(chunksTable.tenantId, context.principal.tenantId)} and ${eq(chunksTable.projectId, search.projectId)}${sessionFilter} and ${searchVector} @@ ${tsquery}`,
        )
        .orderBy(
          sql`ts_rank_cd(${searchVector}, ${tsquery}) desc, ${chunksTable.occurredAt} desc, ${chunksTable.chunkId} asc`,
        )
        .limit(limit);
      return {
        query: search.query,
        projectId: search.projectId,
        workThreadId: search.workThreadId ?? null,
        chunks: rows.map(retrievedChunkFromRow),
        lexicalFallback: true as const,
      };
    });
  }
}

function retrievedChunkFromRow(row: {
  chunkId: string;
  workThreadId: string | null;
  sourceSessionId: string;
  sourceAgent: RetrievedChunk['sourceAgent'];
  kind: string;
  text: string;
  filePaths: string[];
  sourceEventIds: string[];
  occurredAt: Date;
  tokenEstimate: number;
  rank: number;
}): RetrievedChunk {
  return {
    chunkId: row.chunkId,
    workThreadId: row.workThreadId,
    sourceSessionId: row.sourceSessionId,
    sourceAgent: row.sourceAgent,
    kind: row.kind as RetrievedChunk['kind'],
    text: row.text,
    filePaths: row.filePaths,
    occurredAt: row.occurredAt.toISOString(),
    tokenEstimate: row.tokenEstimate,
    sourceEventIds: row.sourceEventIds,
    score: Number(row.rank),
  };
}

function sourceEventFromRow(
  row: typeof sourceEvents.$inferSelect,
): SourceEvent {
  return {
    eventId: row.eventId,
    idempotencyKey: row.idempotencyKey,
    contentHash: row.contentHash,
    sourceSessionId: row.sourceSessionId,
    workThreadId: row.workThreadId,
    sourceAgent: row.sourceAgent,
    sourceDeviceId: row.sourceDeviceId,
    nativeSequence: row.nativeSequence,
    parentEventId: row.parentEventId,
    occurredAt: row.occurredAt.toISOString(),
    observedAt: row.observedAt.toISOString(),
    schemaVersion: row.schemaVersion as SourceEvent['schemaVersion'],
    payload: row.payload,
  };
}

function compareEvents(left: SourceEvent, right: SourceEvent): number {
  if (left.nativeSequence !== null && right.nativeSequence !== null) {
    const sequence = left.nativeSequence - right.nativeSequence;
    if (sequence !== 0) return sequence;
  }
  const occurred = left.occurredAt.localeCompare(right.occurredAt);
  return occurred === 0 ? left.eventId.localeCompare(right.eventId) : occurred;
}

async function requireProject(
  tx: Transaction,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: projects.projectId })
    .from(projects)
    .where(
      and(eq(projects.tenantId, tenantId), eq(projects.projectId, projectId)),
    )
    .limit(1);
  if (row === undefined) {
    throw new IngestionStoreError(
      'not_found',
      404,
      'The project was not found.',
    );
  }
}

async function setTenant(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config('baton.tenant_id', ${tenantId}, true)`,
  );
}
