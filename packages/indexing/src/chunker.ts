import { sha256Hex, type SourceEvent } from '@baton/protocol';

import { estimateTokens, type Chunk, type ChunkKind } from './chunk.js';

/**
 * Cut a work thread's ordered events into semantic chunks. A tool call is
 * folded together with its result (matched by tool-call id); messages, file
 * changes, tasks, decisions, and errors each become their own chunk. Session
 * metadata is not evidence and is skipped. The input should already be in
 * thread order; this function does not reorder events.
 */
export function chunkEvents(
  events: readonly SourceEvent[],
  projectId: string,
): Chunk[] {
  const resultsByCall = new Map<string, SourceEvent>();
  for (const event of events) {
    if (event.payload.kind === 'tool_result') {
      resultsByCall.set(event.payload.toolCallId, event);
    }
  }
  const consumedResults = new Set<string>();

  const chunks: Chunk[] = [];
  for (const event of events) {
    const payload = event.payload;
    switch (payload.kind) {
      case 'message': {
        const text = payload.text.trim();
        if (text.length === 0) break;
        chunks.push(makeChunk(event, projectId, 'message', text, []));
        break;
      }
      case 'tool_call': {
        const result = resultsByCall.get(payload.toolCallId);
        const parts = [payload.name];
        if (payload.inputSummary !== undefined)
          parts.push(payload.inputSummary);
        const sourceEventIds = [event.eventId];
        if (result !== undefined && result.payload.kind === 'tool_result') {
          if (result.payload.outputSummary !== undefined) {
            parts.push('→', result.payload.outputSummary);
          }
          if (result.payload.isError) parts.push('(error)');
          sourceEventIds.push(result.eventId);
          consumedResults.add(payload.toolCallId);
        }
        chunks.push(
          makeChunk(
            event,
            projectId,
            'tool_use',
            parts.join(' '),
            filePathsFrom(payload.inputSummary),
            sourceEventIds,
          ),
        );
        break;
      }
      case 'tool_result': {
        if (consumedResults.has(payload.toolCallId)) break;
        const parts = ['tool result'];
        if (payload.outputSummary !== undefined)
          parts.push(payload.outputSummary);
        if (payload.isError) parts.push('(error)');
        chunks.push(
          makeChunk(event, projectId, 'tool_use', parts.join(' '), []),
        );
        break;
      }
      case 'file_change': {
        const parts = [payload.path, payload.operation];
        if (payload.summary !== undefined) parts.push(payload.summary);
        if (payload.diff !== undefined) parts.push(diffText(payload.diff));
        chunks.push(
          makeChunk(event, projectId, 'file_change', parts.join(' '), [
            payload.path,
          ]),
        );
        break;
      }
      case 'task':
        chunks.push(
          makeChunk(
            event,
            projectId,
            'task',
            `${payload.text} (${payload.status})`,
            [],
          ),
        );
        break;
      case 'decision': {
        const text =
          payload.rationale === undefined
            ? payload.summary
            : `${payload.summary} — ${payload.rationale}`;
        chunks.push(makeChunk(event, projectId, 'decision', text, []));
        break;
      }
      case 'error': {
        const text =
          payload.command === undefined
            ? payload.message
            : `${payload.message} (${payload.command})`;
        chunks.push(makeChunk(event, projectId, 'error', text, []));
        break;
      }
      case 'session_metadata':
        break;
    }
  }
  return chunks;
}

function makeChunk(
  event: SourceEvent,
  projectId: string,
  kind: ChunkKind,
  text: string,
  filePaths: string[],
  sourceEventIds: string[] = [event.eventId],
): Chunk {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    chunkId: `chunk_${sha256Hex(sourceEventIds.join('|')).slice(0, 32)}`,
    projectId,
    workThreadId: event.workThreadId,
    sourceSessionId: event.sourceSessionId,
    sourceAgent: event.sourceAgent,
    kind,
    text: normalized,
    filePaths,
    occurredAt: event.occurredAt,
    tokenEstimate: estimateTokens(normalized),
    sourceEventIds,
  };
}

/**
 * Strip unified-diff markers so the changed identifiers remain searchable text
 * without the leading +/- noise dominating the term frequencies.
 */
function diffText(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => line.replace(/^[+-]/, ''))
    .join(' ');
}

function filePathsFrom(inputSummary: string | undefined): string[] {
  if (inputSummary === undefined) return [];
  const trimmed = inputSummary.trim();
  // A bare path-like input summary (Write/Edit tools) is a useful file signal.
  return /^[\w./-]+\.[A-Za-z0-9]+$/.test(trimmed) ? [trimmed] : [];
}
