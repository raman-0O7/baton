import type {
  Memory,
  RetrievalResult,
  ThreadContext,
  ThreadSuggestionList,
  WorkThread,
  WorkThreadOverview,
} from '@baton/protocol';

/**
 * The read-only surface the Baton MCP tools depend on. `BatonCloudClient`
 * satisfies this structurally; tests supply a stub. Every method takes an
 * access token whose scope the hosted API enforces — the MCP layer never
 * bypasses tenant/project authorization and never sees another tenant's data.
 */
export interface BatonReadClient {
  workThreads(projectId: string, accessToken: string): Promise<WorkThread[]>;
  suggestThreads(
    projectId: string,
    sourceSessionId: string | null,
    accessToken: string,
  ): Promise<ThreadSuggestionList>;
  workThreadOverview(
    workThreadId: string,
    accessToken: string,
  ): Promise<WorkThreadOverview>;
  searchRetrieval(
    input: {
      projectId: string;
      workThreadId?: string;
      query: string;
      limit?: number;
    },
    accessToken: string,
  ): Promise<RetrievalResult>;
  workThreadContext(
    workThreadId: string,
    options: { query?: string; tokenBudget?: number },
    accessToken: string,
  ): Promise<ThreadContext>;
  approvedMemories(accessToken: string): Promise<Memory[]>;
}
