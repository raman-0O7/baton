import type { Chunk } from '@baton/indexing';
import { describe, expect, it } from 'vitest';

import { dedupeRanked, extractTerms, rankChunks } from '../src/index.js';

let counter = 0;
function chunk(text: string, overrides: Partial<Chunk> = {}): Chunk {
  counter += 1;
  return {
    chunkId: overrides.chunkId ?? `chunk_${String(counter).padStart(32, '0')}`,
    projectId: 'p1',
    workThreadId: 't1',
    sourceSessionId: 's1',
    sourceAgent: 'claudecode',
    kind: overrides.kind ?? 'message',
    text,
    filePaths: overrides.filePaths ?? [],
    occurredAt: overrides.occurredAt ?? '2026-07-01T10:00:00.000Z',
    tokenEstimate: Math.ceil(text.length / 4),
    sourceEventIds: overrides.sourceEventIds ?? ['e1'],
  };
}

describe('extractTerms', () => {
  it('lowercases, splits identifiers, and drops stopwords', () => {
    expect(extractTerms('What happened to greet.go?')).toEqual([
      'happened',
      'greet',
      'go',
    ]);
  });
});

describe('rankChunks', () => {
  it('surfaces term-overlapping chunks and ignores the rest', () => {
    const chunks = [
      chunk('Done: greet.go created and the function renamed to Hello.'),
      chunk('greet.go changed func Greet to func Hello.'),
      chunk('go build ./... completed with output ok.'),
      chunk('Use os.ReadDir — it returns entries sorted by filename.'),
    ];
    const ranked = rankChunks(
      'What happened to the original Greet function name?',
      chunks,
    );
    const texts = ranked.map((item) => item.chunk.text);
    expect(texts[0]).toContain('renamed to Hello');
    expect(texts).toContain('greet.go changed func Greet to func Hello.');
    // Non-overlapping chunks are not returned at all.
    expect(texts).not.toContain('go build ./... completed with output ok.');
    expect(texts).not.toContain(
      'Use os.ReadDir — it returns entries sorted by filename.',
    );
  });

  it('returns nothing for an all-stopword query', () => {
    expect(rankChunks('what is the', [chunk('greet.go renamed')])).toEqual([]);
  });

  it('breaks ties by recency then id', () => {
    const older = chunk('pending task alpha', {
      occurredAt: '2026-07-01T09:00:00.000Z',
      chunkId: 'chunk_a',
    });
    const newer = chunk('pending task beta', {
      occurredAt: '2026-07-01T11:00:00.000Z',
      chunkId: 'chunk_b',
    });
    const ranked = rankChunks('pending task', [older, newer]);
    expect(ranked[0]!.chunk.chunkId).toBe('chunk_b');
  });

  it('respects the limit and boosts structured kinds on ties', () => {
    const message = chunk('rename the helper', { kind: 'message' });
    const decision = chunk('rename the helper', {
      kind: 'decision',
      chunkId: 'chunk_decision',
    });
    // Identical text → dedupe keeps the first after ranking; the decision's kind
    // boost should make it the survivor.
    const ranked = rankChunks('rename helper', [message, decision]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.chunk.kind).toBe('decision');
  });
});

describe('dedupeRanked', () => {
  it('drops repeated ids and identical text', () => {
    const base = chunk('same text', { chunkId: 'chunk_x' });
    const deduped = dedupeRanked([
      { chunk: base, score: 2, matchedTerms: [] },
      { chunk: base, score: 1, matchedTerms: [] },
      {
        chunk: chunk('same text', { chunkId: 'chunk_y' }),
        score: 0.5,
        matchedTerms: [],
      },
    ]);
    expect(deduped).toHaveLength(1);
  });
});
