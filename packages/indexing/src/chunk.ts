import type { AgentName } from '@baton/protocol';

/**
 * A stable, source-linked retrieval unit. Chunks are cut on semantic
 * boundaries (a message, a tool call with its result, a file change, a task, a
 * decision, an error) so a retriever can return a coherent piece of evidence
 * without replaying a whole transcript. Every chunk cites the source events it
 * was derived from.
 */
export type ChunkKind =
  'message' | 'tool_use' | 'file_change' | 'task' | 'decision' | 'error';

export interface Chunk {
  chunkId: string;
  projectId: string;
  workThreadId: string | null;
  sourceSessionId: string;
  sourceAgent: AgentName;
  kind: ChunkKind;
  text: string;
  filePaths: string[];
  occurredAt: string;
  tokenEstimate: number;
  sourceEventIds: string[];
}

/**
 * Deterministic token estimate. Uses the widely used ~4-characters-per-token
 * heuristic; retrieval budgets are conservative, so a stable over-estimate is
 * safer than a model-specific tokenizer here. Never returns zero for non-empty
 * text.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}
