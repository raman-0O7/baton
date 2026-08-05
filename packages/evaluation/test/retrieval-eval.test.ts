import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileContext } from '@baton/context';
import { estimateTokens, type Chunk, type ChunkKind } from '@baton/indexing';
import { rankChunks } from '@baton/retrieval';
import { describe, expect, it } from 'vitest';

import { repositoryRootFrom } from '../src/index.js';

const repositoryRoot = repositoryRootFrom(import.meta.url);

interface Evidence {
  id: string;
  sourcePointer: string;
  text: string;
  projectId: string;
  workThreadId: string;
}

interface RetrievalCase {
  id: string;
  question: string;
  projectId: string;
  workThreadId: string;
  expectedEvidenceIds: string[];
  excludedEvidenceIds: string[];
  maxContextTokens: number;
}

function kindOf(pointer: string): ChunkKind {
  if (pointer.includes('/file_ops/')) return 'file_change';
  if (pointer.includes('/todos/')) return 'task';
  if (pointer.includes('/tool_calls/')) return 'tool_use';
  return 'message';
}

/** Turn a corpus evidence item into a retrievable chunk (id === evidence id). */
function evidenceChunk(evidence: Evidence, index: number): Chunk {
  const occurredAt = new Date(
    Date.parse('2026-07-01T10:00:00Z') + index * 60_000,
  ).toISOString();
  return {
    chunkId: evidence.id,
    projectId: evidence.projectId,
    workThreadId: evidence.workThreadId,
    sourceSessionId: `session-${evidence.workThreadId}`,
    sourceAgent: 'claudecode',
    kind: kindOf(evidence.sourcePointer),
    text: evidence.text,
    filePaths: [],
    occurredAt,
    tokenEstimate: estimateTokens(evidence.text),
    sourceEventIds: [evidence.id],
  };
}

/** Irrelevant filler so the "full transcript" is realistically large. */
function fillerChunks(workThreadId: string, count: number): Chunk[] {
  return Array.from({ length: count }, (_, index) => {
    const text = `Routine progress note ${index}: adjusted logging, updated metrics dashboard, and reviewed unrelated infrastructure configuration for the deployment pipeline.`;
    return {
      chunkId: `filler-${workThreadId}-${index}`,
      projectId: 'noise',
      workThreadId,
      sourceSessionId: `session-${workThreadId}`,
      sourceAgent: 'codex' as const,
      kind: 'message' as const,
      text,
      filePaths: [],
      occurredAt: new Date(
        Date.parse('2026-07-01T08:00:00Z') + index * 1000,
      ).toISOString(),
      tokenEstimate: estimateTokens(text),
      sourceEventIds: [`filler-${workThreadId}-${index}`],
    };
  });
}

describe('retrieval evaluation gate', () => {
  it('recalls expected evidence, cites it, scopes it, and reduces context ≥80%', async () => {
    const corpus = JSON.parse(
      await readFile(
        resolve(repositoryRoot, 'testdata/hosted/retrieval/cases-v1.json'),
        'utf8',
      ),
    ) as { evidence: Evidence[]; cases: RetrievalCase[] };

    const evidenceChunks = corpus.evidence.map((evidence, index) =>
      evidenceChunk(evidence, index),
    );
    const reductions: number[] = [];

    for (const testCase of corpus.cases) {
      // Deny-by-default scoping: only this project + thread is searchable, plus
      // a large amount of same-thread filler to model a full transcript.
      const scoped = [
        ...evidenceChunks.filter(
          (chunk) =>
            chunk.projectId === testCase.projectId &&
            chunk.workThreadId === testCase.workThreadId,
        ),
        ...fillerChunks(testCase.workThreadId, 60),
      ];

      // Nothing from another project or thread leaked into scope.
      for (const excludedId of testCase.excludedEvidenceIds) {
        expect(
          scoped.some((chunk) => chunk.chunkId === excludedId),
          `${testCase.id}: excluded ${excludedId} must be out of scope`,
        ).toBe(false);
      }

      const ranked = rankChunks(testCase.question, scoped);
      const compiled = compileContext(ranked, {
        tokenBudget: testCase.maxContextTokens,
      });

      // Recall: every expected evidence chunk is present.
      for (const expectedId of testCase.expectedEvidenceIds) {
        expect(
          compiled.includedChunkIds,
          `${testCase.id}: expected ${expectedId}`,
        ).toContain(expectedId);
      }
      // Precision on excluded: none present.
      for (const excludedId of testCase.excludedEvidenceIds) {
        expect(compiled.includedChunkIds).not.toContain(excludedId);
      }
      // Budget honoured and every included claim is cited.
      expect(compiled.tokenEstimate).toBeLessThanOrEqual(
        testCase.maxContextTokens,
      );
      expect(compiled.citations).toHaveLength(compiled.includedChunkIds.length);
      const citedIds = new Set(
        compiled.citations.flatMap((citation) => citation.sourceEventIds),
      );
      for (const includedId of compiled.includedChunkIds) {
        expect(citedIds.has(includedId)).toBe(true);
      }

      const fullTranscriptTokens = scoped.reduce(
        (sum, chunk) => sum + chunk.tokenEstimate,
        0,
      );
      const reduction = 1 - compiled.tokenEstimate / fullTranscriptTokens;
      reductions.push(reduction);
      expect(
        reduction,
        `${testCase.id}: context reduction ${reduction.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(0.8);
    }

    const sorted = [...reductions].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(median).toBeGreaterThanOrEqual(0.8);
  });
});
