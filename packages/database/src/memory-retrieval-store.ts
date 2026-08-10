import { chunkEvents, type Chunk } from '@baton/indexing';
import type { RetrievalResult, RetrievedChunk } from '@baton/protocol';
import { rankChunks } from '@baton/retrieval';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import type { InMemoryIngestionStore } from './memory-ingestion-store.js';
import {
  defaultRetrievalLimit,
  maxRetrievalLimit,
  type RetrievalSearch,
  type RetrievalStore,
} from './retrieval-store.js';

/**
 * In-memory retrieval store used by API tests and the local harness. It reads
 * captured events from an {@link InMemoryIngestionStore}, chunks them, and ranks
 * with the deterministic lexical scorer — the same behaviour the Postgres store
 * provides through full-text search.
 */
export class InMemoryRetrievalStore implements RetrievalStore {
  private readonly chunksByProject = new Map<string, Chunk[]>();

  constructor(private readonly ingestion: InMemoryIngestionStore) {}

  async reindexProject(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<number> {
    this.requireProject(context, projectId);
    const sessions = this.ingestion.sourceSessionsForProject(
      context.principal.tenantId,
      projectId,
    );
    const chunks: Chunk[] = [];
    for (const session of sessions) {
      const events = this.ingestion
        .eventsForSessions(context.principal.tenantId, [
          session.sourceSessionId,
        ])
        .sort(compareByOccurred);
      chunks.push(...chunkEvents(events, projectId));
    }
    this.chunksByProject.set(
      key(context.principal.tenantId, projectId),
      chunks,
    );
    return chunks.length;
  }

  async search(
    context: IngestionRequestContext,
    search: RetrievalSearch,
  ): Promise<RetrievalResult> {
    this.requireProject(context, search.projectId);
    const limit = Math.min(
      search.limit ?? defaultRetrievalLimit,
      maxRetrievalLimit,
    );
    const all =
      this.chunksByProject.get(
        key(context.principal.tenantId, search.projectId),
      ) ?? [];
    const scoped =
      search.sourceSessionIds === undefined
        ? all
        : all.filter((chunk) =>
            search.sourceSessionIds!.includes(chunk.sourceSessionId),
          );
    const ranked = rankChunks(search.query, scoped, { limit });
    return {
      query: search.query,
      projectId: search.projectId,
      workThreadId: search.workThreadId ?? null,
      chunks: ranked.map((item) => toRetrievedChunk(item.chunk, item.score)),
      lexicalFallback: true as const,
    };
  }

  purge(tenantId: string, projectId: string | null): Record<string, number> {
    let chunks = 0;
    for (const [mapKey, list] of [...this.chunksByProject]) {
      if (!mapKey.startsWith(`${tenantId}:`)) continue;
      if (projectId !== null && mapKey !== `${tenantId}:${projectId}`) continue;
      chunks += list.length;
      this.chunksByProject.delete(mapKey);
    }
    return { chunks };
  }

  private requireProject(
    context: IngestionRequestContext,
    projectId: string,
  ): void {
    if (!this.ingestion.projectExists(context.principal.tenantId, projectId)) {
      throw new IngestionStoreError(
        'not_found',
        404,
        'The project was not found.',
      );
    }
  }
}

function toRetrievedChunk(chunk: Chunk, score: number): RetrievedChunk {
  return {
    chunkId: chunk.chunkId,
    workThreadId: chunk.workThreadId,
    sourceSessionId: chunk.sourceSessionId,
    sourceAgent: chunk.sourceAgent,
    kind: chunk.kind,
    text: chunk.text,
    filePaths: chunk.filePaths,
    occurredAt: chunk.occurredAt,
    tokenEstimate: chunk.tokenEstimate,
    sourceEventIds: chunk.sourceEventIds,
    score,
  };
}

function compareByOccurred(
  left: { occurredAt: string; eventId: string; nativeSequence: number | null },
  right: { occurredAt: string; eventId: string; nativeSequence: number | null },
): number {
  if (left.nativeSequence !== null && right.nativeSequence !== null) {
    const sequence = left.nativeSequence - right.nativeSequence;
    if (sequence !== 0) return sequence;
  }
  const occurred = left.occurredAt.localeCompare(right.occurredAt);
  return occurred === 0 ? left.eventId.localeCompare(right.eventId) : occurred;
}

function key(tenantId: string, projectId: string): string {
  return `${tenantId}:${projectId}`;
}
