import type { RetrievalResult } from '@baton/protocol';

import type { IngestionRequestContext } from './ingestion-store.js';

export interface RetrievalSearch {
  projectId: string;
  /** Echoed back on the result when the search is scoped to a work thread. */
  workThreadId?: string | null;
  /** Restrict to these source sessions (e.g. a work thread's sessions). */
  sourceSessionIds?: string[];
  query: string;
  limit?: number;
}

export interface RetrievalStore {
  /**
   * Materialize (or refresh) the chunk index for a project from its immutable
   * events. Deterministic: re-running produces the same chunks. Returns the
   * number of chunks now indexed for the project.
   */
  reindexProject(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<number>;
  /**
   * Lexical retrieval scoped to the caller's tenant and the given project
   * (and optionally a set of source sessions). Deny-by-default: a project the
   * caller cannot see yields no results.
   */
  search(
    context: IngestionRequestContext,
    search: RetrievalSearch,
  ): Promise<RetrievalResult>;
}

export const maxRetrievalLimit = 200;
export const defaultRetrievalLimit = 20;
