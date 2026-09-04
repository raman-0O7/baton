import { estimateTokens, type ChunkKind } from '@baton/indexing';
import type { WorkThreadOverview } from '@baton/protocol';
import type { RankedChunk } from '@baton/retrieval';

/**
 * A single cited line of compiled context. `marker` (e.g. `#1`) appears inline
 * in the document text; `sourceEventIds` point back to the immutable events the
 * claim was derived from so any statement can be traced to evidence.
 */
export interface Citation {
  marker: string;
  chunkId: string;
  kind: ChunkKind;
  sourceEventIds: string[];
  occurredAt: string;
}

export interface CompiledContext {
  text: string;
  tokenEstimate: number;
  citations: Citation[];
  includedChunkIds: string[];
  /** True when the token budget forced at least one ranked chunk to be dropped. */
  truncated: boolean;
}

export interface CompileOptions {
  tokenBudget: number;
  header?: string;
}

/**
 * Compile ranked chunks into a budget-bounded, fully cited evidence document.
 * Chunks are taken in ranked order and each becomes one cited line; inclusion
 * stops as soon as the next line would exceed the token budget. Every emitted
 * line carries a citation, so no claim is uncited. Degradation is deterministic:
 * the same ranking and budget always yield the same document.
 */
/** The minimal evidence shape the compiler needs from a retrieval result. */
export interface RetrievedEvidence {
  chunkId: string;
  kind: ChunkKind;
  text: string;
  sourceEventIds: string[];
  occurredAt: string;
}

export function compileContext(
  ranked: readonly RankedChunk[],
  options: CompileOptions,
): CompiledContext {
  return compileRetrievedContext(
    ranked.map((item) => item.chunk),
    options,
  );
}

/**
 * Compile already-ranked retrieval evidence into a budget-bounded, fully cited
 * document. Evidence is taken in order and each becomes one cited line;
 * inclusion stops as soon as the next line would exceed the token budget.
 */
export function compileRetrievedContext(
  evidence: readonly RetrievedEvidence[],
  options: CompileOptions,
): CompiledContext {
  const header = options.header ?? 'Relevant evidence:';
  const lines: string[] = [header];
  const citations: Citation[] = [];
  const includedChunkIds: string[] = [];
  let tokenEstimate = estimateTokens(header);
  let truncated = false;

  for (const item of evidence) {
    const marker = `#${citations.length + 1}`;
    const line = `- ${item.text} [${marker}]`;
    const lineTokens = estimateTokens(line);
    if (tokenEstimate + lineTokens > options.tokenBudget) {
      truncated = true;
      continue;
    }
    lines.push(line);
    tokenEstimate += lineTokens;
    citations.push({
      marker,
      chunkId: item.chunkId,
      kind: item.kind,
      sourceEventIds: item.sourceEventIds,
      occurredAt: item.occurredAt,
    });
    includedChunkIds.push(item.chunkId);
  }

  return {
    text: lines.join('\n'),
    tokenEstimate,
    citations,
    includedChunkIds,
    truncated,
  };
}

export interface BootstrapOptions {
  tokenBudget?: number;
  mcpInstruction?: string;
}

const defaultBootstrapBudget = 1000;
const defaultMcpInstruction =
  'Use the Baton MCP tools with this work thread id to retrieve cited context on demand; do not request the full transcript.';

/**
 * A compact continuation bootstrap: thread identity, goal, current state, the
 * top open tasks, the most recent decision, and an MCP usage instruction —
 * within a small token budget (default 1000). Everything is derived from the
 * materialized thread overview, and structured items keep their evidence
 * citations.
 */
export function compileBootstrap(
  overview: WorkThreadOverview,
  options: BootstrapOptions = {},
): CompiledContext {
  const budget = options.tokenBudget ?? defaultBootstrapBudget;
  const thread = overview.workThread;
  const lines: string[] = [
    `Work thread ${thread.workThreadId}: ${thread.title} (${thread.state}).`,
  ];
  if (thread.goal !== null) lines.push(`Goal: ${thread.goal}.`);
  const agents = [
    ...new Set(overview.sessions.map((s) => s.sourceSession.sourceAgent)),
  ].sort();
  if (agents.length > 0) lines.push(`Sources: ${agents.join(', ')}.`);

  const citations: Citation[] = [];
  const includedChunkIds: string[] = [];
  const openTasks = overview.tasks
    .filter((task) => task.status !== 'completed')
    .slice(0, 5);
  if (openTasks.length > 0) {
    lines.push('Open tasks:');
    for (const task of openTasks) {
      const marker = `#${citations.length + 1}`;
      lines.push(`- ${task.text} (${task.status}) [${marker}]`);
      citations.push({
        marker,
        chunkId: task.eventId,
        kind: 'task',
        sourceEventIds: [task.eventId],
        occurredAt: task.occurredAt,
      });
      includedChunkIds.push(task.eventId);
    }
  }
  const lastDecision = overview.decisions.at(-1);
  if (lastDecision !== undefined) {
    const marker = `#${citations.length + 1}`;
    lines.push(`Latest decision: ${lastDecision.summary} [${marker}].`);
    citations.push({
      marker,
      chunkId: lastDecision.eventId,
      kind: 'decision',
      sourceEventIds: [lastDecision.eventId],
      occurredAt: lastDecision.occurredAt,
    });
    includedChunkIds.push(lastDecision.eventId);
  }
  lines.push(options.mcpInstruction ?? defaultMcpInstruction);

  // Deterministic degradation: drop trailing lines until within budget, but
  // never drop the identity line.
  let text = lines.join('\n');
  let truncated = false;
  while (estimateTokens(text) > budget && lines.length > 1) {
    lines.pop();
    truncated = true;
    text = lines.join('\n');
  }

  return {
    text,
    tokenEstimate: estimateTokens(text),
    citations,
    includedChunkIds,
    truncated,
  };
}
