import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SourceEventSchema } from '@baton/protocol';

import { loadEvaluationCorpus, repositoryRootFrom } from '../src/index.js';

const repositoryRoot = repositoryRootFrom(import.meta.url);

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(repositoryRoot, relativePath), 'utf8'),
  );
}

async function sha256(relativePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(resolve(repositoryRoot, relativePath)))
    .digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function pointer(document: unknown, encodedPointer: string): unknown {
  if (encodedPointer === '') return document;
  return encodedPointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, part) => {
      if (Array.isArray(current)) return current[Number(part)];
      return record(current)[part];
    }, document);
}

describe('hosted evaluation corpus', () => {
  it('pins every supported sanitized fixture and its legacy golden', async () => {
    const corpus = await loadEvaluationCorpus(repositoryRoot);

    expect(
      new Set(corpus.adapterParity.fixtures.map((item) => item.agent)),
    ).toEqual(new Set(['claudecode', 'codex', 'opencode']));
    expect(corpus.adapterParity.fixtures).toHaveLength(6);

    for (const fixture of corpus.adapterParity.fixtures) {
      expect(await sha256(fixture.nativeFixture)).toBe(fixture.nativeSha256);
      expect(await sha256(fixture.legacyGolden)).toBe(
        fixture.legacyGoldenSha256,
      );
      expect(fixture.origin).toBe('derived_from_sanitized_fixture');
    }
  });

  it('grounds every expected semantic event in a legacy golden', async () => {
    const corpus = await loadEvaluationCorpus(repositoryRoot);
    const expectedById = new Map(
      corpus.adapterExpectedEvents.cases.map((item) => [item.id, item]),
    );

    for (const fixture of corpus.adapterParity.fixtures) {
      const expected = expectedById.get(fixture.expectedEventsCase);
      expect(expected).toBeDefined();
      expect(expected?.sourceFixture).toBe(fixture.nativeFixture);
      expect(expected?.sourceGolden).toBe(fixture.legacyGolden);
      expect(expected?.events.length).toBeGreaterThan(0);

      const golden = await readJson(fixture.legacyGolden);
      for (const event of expected?.events ?? []) {
        const source = record(pointer(golden, event.sourcePointer));
        const payload = event.payload;
        expect(Date.parse(event.occurredAt)).not.toBeNaN();

        switch (payload.kind) {
          case 'message':
            expect(payload.role).toBe(source.role);
            expect(payload.text).toBe(source.text);
            break;
          case 'tool_call':
            expect(payload.toolCallId).toBe(source.id);
            expect(payload.name).toBe(source.name);
            expect(payload.inputSummary).toBe(source.input_summary);
            break;
          case 'tool_result':
            expect(payload.toolCallId).toBe(source.id);
            expect(payload.outputSummary).toBe(source.output_summary);
            break;
          case 'file_change':
            expect(payload.path).toBe(source.path);
            expect(payload.operation).toBe(source.kind);
            expect(payload.summary).toBe(source.summary);
            if (source.diff !== undefined)
              expect(payload.diff).toBe(source.diff);
            break;
          case 'task':
            expect(payload.text).toBe(source.text);
            expect(payload.status).toBe(source.status);
            break;
          default:
            throw new Error(`unverified event kind ${String(payload.kind)}`);
        }
      }
    }
  });

  it('covers append, partial-line, rewrite, retry, ordering, and divergence', async () => {
    const corpus = await loadEvaluationCorpus(repositoryRoot);

    expect(
      new Set(corpus.adapterTransitions.cases.map((item) => item.scenario)),
    ).toEqual(
      new Set([
        'incremental_append',
        'partial_final_line',
        'truncation_rewrite',
      ]),
    );
    expect(
      new Set(corpus.ingestionConvergence.cases.map((item) => item.scenario)),
    ).toEqual(new Set(['duplicate', 'out_of_order', 'divergence']));

    for (const scenario of corpus.ingestionConvergence.cases) {
      for (const event of scenario.events) {
        expect(SourceEventSchema.safeParse(event).success).toBe(true);
      }
    }

    for (const scenario of corpus.adapterTransitions.cases) {
      expect(scenario.steps.length).toBeGreaterThan(1);
      expect(scenario.invariants.length).toBeGreaterThan(0);
      for (const sourceFixture of scenario.sourceFixtures) {
        expect(
          await readFile(resolve(repositoryRoot, sourceFixture), 'utf8'),
        ).not.toHaveLength(0);
      }
    }
  });

  it('keeps retrieval evidence source-linked and token-budgeted', async () => {
    const { retrieval } = await loadEvaluationCorpus(repositoryRoot);
    const evidenceIds = new Set(retrieval.evidence.map((item) => item.id));

    for (const evidence of retrieval.evidence) {
      const golden = await readJson(evidence.sourceGolden);
      expect(pointer(golden, evidence.sourcePointer)).toBeDefined();
    }
    for (const testCase of retrieval.cases) {
      expect(testCase.maxContextTokens).toBeGreaterThan(0);
      expect(testCase.expectedEvidenceIds.length).toBeGreaterThan(0);
      for (const id of [
        ...testCase.expectedEvidenceIds,
        ...testCase.excludedEvidenceIds,
      ]) {
        expect(evidenceIds.has(id)).toBe(true);
      }
    }
  });

  it('covers every required memory-policy outcome with synthetic evidence', async () => {
    const { memory } = await loadEvaluationCorpus(repositoryRoot);
    const evidenceIds = new Set(memory.evidence.map((item) => item.id));

    expect(new Set(memory.cases.map((item) => item.category))).toEqual(
      new Set([
        'acceptable_candidate',
        'wrong_scope',
        'insufficient_evidence',
        'contradiction',
        'prohibited_sensitive_inference',
      ]),
    );
    for (const testCase of memory.cases) {
      expect(testCase.evidenceIds.length).toBeGreaterThan(0);
      for (const id of testCase.evidenceIds)
        expect(evidenceIds.has(id)).toBe(true);
    }
  });

  it('covers positive, certain, negative, and sole-thread suggestion outcomes', async () => {
    const { threadSuggestion } = await loadEvaluationCorpus(repositoryRoot);
    expect(Date.parse(threadSuggestion.nowIso)).not.toBeNaN();
    expect(new Set(threadSuggestion.cases.map((item) => item.id))).toEqual(
      new Set([
        'cross-agent-continuation',
        'shared-source-session-is-certain',
        'no-shared-evidence-is-not-suggested',
        'sole-active-thread-without-candidate',
      ]),
    );
    for (const testCase of threadSuggestion.cases) {
      expect(testCase.threads.length).toBeGreaterThan(0);
      expect(testCase.expected.minScore).toBeGreaterThanOrEqual(0);
      // The expected top thread, when present, must be one of the case threads.
      if (testCase.expected.topWorkThreadId !== null) {
        expect(testCase.threads.map((thread) => thread.workThreadId)).toContain(
          testCase.expected.topWorkThreadId,
        );
      }
    }
  });
});
