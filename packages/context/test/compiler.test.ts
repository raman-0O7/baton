import type { Chunk } from '@baton/indexing';
import type { WorkThreadOverview } from '@baton/protocol';
import type { RankedChunk } from '@baton/retrieval';
import { describe, expect, it } from 'vitest';

import { compileBootstrap, compileContext } from '../src/index.js';

function ranked(text: string, index: number): RankedChunk {
  const chunk: Chunk = {
    chunkId: `chunk_${String(index).padStart(32, '0')}`,
    projectId: 'p1',
    workThreadId: 't1',
    sourceSessionId: 's1',
    sourceAgent: 'claudecode',
    kind: 'message',
    text,
    filePaths: [],
    occurredAt: '2026-07-01T10:00:00.000Z',
    tokenEstimate: Math.ceil(text.length / 4),
    sourceEventIds: [`e${index}`],
  };
  return { chunk, score: 10 - index, matchedTerms: [] };
}

describe('compileContext', () => {
  it('cites every line and honours the token budget', () => {
    const chunks = [
      ranked('greet.go renamed func Greet to func Hello.', 1),
      ranked('Add unit tests is pending.', 2),
      ranked('go build completed with output ok.', 3),
    ];
    const compiled = compileContext(chunks, { tokenBudget: 1000 });
    // One citation per included chunk, markers referenced in the text.
    expect(compiled.citations).toHaveLength(3);
    for (const citation of compiled.citations) {
      expect(compiled.text).toContain(`[${citation.marker}]`);
      expect(citation.sourceEventIds.length).toBeGreaterThan(0);
    }
    expect(compiled.truncated).toBe(false);
    expect(compiled.tokenEstimate).toBeLessThanOrEqual(1000);
  });

  it('drops the lowest-ranked chunks when the budget is tight', () => {
    const chunks = [
      ranked('first evidence line about the rename', 1),
      ranked('second evidence line about pending tests', 2),
      ranked('third evidence line about the build', 3),
    ];
    const compiled = compileContext(chunks, { tokenBudget: 20 });
    expect(compiled.truncated).toBe(true);
    expect(compiled.tokenEstimate).toBeLessThanOrEqual(20);
    expect(compiled.includedChunkIds.length).toBeLessThan(3);
    // Highest-ranked survives.
    expect(compiled.includedChunkIds[0]).toBe(chunks[0]!.chunk.chunkId);
  });
});

describe('compileBootstrap', () => {
  const overview: WorkThreadOverview = {
    workThread: {
      workThreadId: '018f0f90-3000-7000-8000-000000000001',
      projectId: '018f0f90-9000-7000-8000-000000000001',
      title: 'Implement hosted authentication',
      goal: 'Cross-agent device login',
      state: 'active',
      createdAt: '2026-07-01T09:00:00.000Z',
      updatedAt: '2026-07-01T12:00:00.000Z',
    },
    sessions: [],
    tasks: [
      {
        text: 'Finish token exchange',
        status: 'in_progress',
        eventId: '018f0f90-4000-7000-8000-000000000001',
        occurredAt: '2026-07-01T10:00:00.000Z',
      },
      {
        text: 'Ship login',
        status: 'completed',
        eventId: '018f0f90-4000-7000-8000-000000000002',
        occurredAt: '2026-07-01T10:05:00.000Z',
      },
    ],
    decisions: [
      {
        summary: 'Use device authorization grant',
        rationale: null,
        eventId: '018f0f90-4000-7000-8000-000000000003',
        occurredAt: '2026-07-01T10:02:00.000Z',
      },
    ],
    fileActivities: [],
    errors: [],
    eventCount: 5,
    lastActivityAt: '2026-07-01T10:05:00.000Z',
  };

  it('emits identity, goal, open tasks, latest decision, and an MCP instruction', () => {
    const bootstrap = compileBootstrap(overview);
    expect(bootstrap.text).toContain('Implement hosted authentication');
    expect(bootstrap.text).toContain('Cross-agent device login');
    expect(bootstrap.text).toContain('Finish token exchange');
    expect(bootstrap.text).not.toContain('Ship login'); // completed task excluded
    expect(bootstrap.text).toContain('Use device authorization grant');
    expect(bootstrap.text).toContain('Baton MCP');
    expect(bootstrap.tokenEstimate).toBeLessThanOrEqual(1000);
    expect(bootstrap.citations.length).toBeGreaterThan(0);
  });

  it('keeps the identity line under a tiny budget', () => {
    const bootstrap = compileBootstrap(overview, { tokenBudget: 12 });
    expect(bootstrap.truncated).toBe(true);
    expect(bootstrap.text).toContain('Implement hosted authentication');
  });
});
