import {
  createSourceEvent,
  type SourceEvent,
  type SourceEventPayload,
} from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import { chunkEvents, estimateTokens } from '../src/index.js';

const sessionId = '018f0f90-2000-7000-8000-0000000000a1';
const deviceId = '018f0f90-1000-7000-8000-0000000000d1';
const projectId = '018f0f90-9000-7000-8000-000000000001';

let sequence = 0;
function event(payload: SourceEventPayload): SourceEvent {
  sequence += 1;
  const occurredAt = new Date(
    Date.parse('2026-07-01T10:00:00Z') + sequence * 1000,
  ).toISOString();
  return createSourceEvent({
    sourceSessionId: sessionId,
    workThreadId: null,
    sourceAgent: 'claudecode',
    sourceDeviceId: deviceId,
    nativeSequence: sequence,
    parentEventId: null,
    occurredAt,
    observedAt: occurredAt,
    schemaVersion: 1,
    payload,
  });
}

describe('estimateTokens', () => {
  it('is deterministic, non-zero for content, and zero for blanks', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});

describe('chunkEvents', () => {
  it('pairs a tool call with its result and cuts semantic boundaries', () => {
    const events = [
      event({ kind: 'message', role: 'user', text: 'Rename Greet to Hello.' }),
      event({
        kind: 'tool_call',
        toolCallId: 'call-1',
        name: 'Edit',
        inputSummary: 'greet.go',
      }),
      event({
        kind: 'tool_result',
        toolCallId: 'call-1',
        outputSummary: 'updated greet.go',
        isError: false,
      }),
      event({
        kind: 'file_change',
        path: 'greet.go',
        operation: 'edit',
        diff: '--- a/greet.go\n+++ b/greet.go\n-func Greet(name string) string {\n+func Hello(name string) string {\n',
        summary: 'renamed function',
      }),
      event({
        kind: 'decision',
        summary: 'Rename to Hello',
        rationale: 'API clarity',
      }),
      event({ kind: 'task', text: 'Add unit tests', status: 'pending' }),
      event({ kind: 'error', message: 'build failed', command: 'go build' }),
      // Empty assistant message (tool-only turn) contributes no chunk.
      event({ kind: 'message', role: 'assistant', text: '' }),
      // Session metadata is not evidence.
      event({ kind: 'session_metadata', title: 'Greeting', gitBranch: 'main' }),
    ];

    const chunks = chunkEvents(events, projectId);
    const kinds = chunks.map((chunk) => chunk.kind);
    expect(kinds).toEqual([
      'message',
      'tool_use',
      'file_change',
      'decision',
      'task',
      'error',
    ]);

    const toolChunk = chunks[1]!;
    expect(toolChunk.sourceEventIds).toHaveLength(2); // call + result folded
    expect(toolChunk.text).toContain('Edit');
    expect(toolChunk.text).toContain('updated greet.go');

    const fileChunk = chunks[2]!;
    expect(fileChunk.filePaths).toEqual(['greet.go']);
    expect(fileChunk.text).toContain('func Hello'); // diff markers stripped
    expect(fileChunk.text).not.toContain('+func');

    for (const chunk of chunks) {
      expect(chunk.projectId).toBe(projectId);
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
      expect(chunk.chunkId).toMatch(/^chunk_[a-f0-9]{32}$/);
      expect(chunk.sourceEventIds.length).toBeGreaterThan(0);
    }
  });

  it('emits an unpaired tool result as its own chunk', () => {
    const chunks = chunkEvents(
      [
        event({
          kind: 'tool_result',
          toolCallId: 'orphan',
          outputSummary: 'go build ./... ok',
          isError: false,
        }),
      ],
      projectId,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('tool_use');
    expect(chunks[0]!.text).toContain('go build');
  });

  it('produces stable chunk ids for the same source events', () => {
    const payload: SourceEventPayload = {
      kind: 'message',
      role: 'user',
      text: 'stable',
    };
    const one = event(payload);
    const first = chunkEvents([one], projectId);
    const again = chunkEvents([one], projectId);
    expect(first[0]!.chunkId).toBe(again[0]!.chunkId);
  });
});
