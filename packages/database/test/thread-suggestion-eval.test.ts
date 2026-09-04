import { readFile } from 'node:fs/promises';

import {
  createSourceEvent,
  type SourceEvent,
  type SourceEventPayload,
  type WorkThread,
} from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import {
  compareThreadEvents,
  rankSuggestions,
  scoreThreadSuggestion,
  type CandidateSession,
  type ThreadScoringInput,
} from '../src/work-thread-store.js';

interface CorpusEvent {
  sourceSessionId?: string;
  sourceAgent?: SourceEvent['sourceAgent'];
  sourceDeviceId?: string;
  occurredAt: string;
  nativeSequence?: number | null;
  payload: SourceEventPayload;
}

interface CorpusCase {
  id: string;
  activeThreadCount: number;
  candidate: {
    sourceSessionId: string;
    sourceAgent: SourceEvent['sourceAgent'];
    sourceDeviceId: string;
    events: CorpusEvent[];
  } | null;
  threads: Array<{
    workThreadId: string;
    title: string;
    state: WorkThread['state'];
    updatedAt: string;
    assignedSourceSessionIds: string[];
    events: CorpusEvent[];
  }>;
  expected: {
    topWorkThreadId: string | null;
    reasons: string[];
    minScore: number;
  };
}

const projectId = '018f0f90-9000-7000-8000-000000000001';
const defaultAgent = 'codex';
const defaultDevice = '018f0f90-1000-7000-8000-0000000000d9';

function buildEvent(event: CorpusEvent, fallbackSession: string): SourceEvent {
  return createSourceEvent({
    sourceSessionId: event.sourceSessionId ?? fallbackSession,
    workThreadId: null,
    sourceAgent: event.sourceAgent ?? defaultAgent,
    sourceDeviceId: event.sourceDeviceId ?? defaultDevice,
    nativeSequence: event.nativeSequence ?? null,
    parentEventId: null,
    occurredAt: event.occurredAt,
    observedAt: event.occurredAt,
    schemaVersion: 1,
    payload: event.payload,
  });
}

describe('thread suggestion evaluation corpus', () => {
  it('reproduces the expected suggestion for every locked case', async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL(
          '../../../testdata/hosted/threads/suggestion-cases-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { nowIso: string; cases: CorpusCase[] };
    const nowMs = Date.parse(corpus.nowIso);

    for (const testCase of corpus.cases) {
      const candidate: CandidateSession | null =
        testCase.candidate === null
          ? null
          : {
              sourceSessionId: testCase.candidate.sourceSessionId,
              events: testCase.candidate.events.map((event) =>
                buildEvent(event, testCase.candidate!.sourceSessionId),
              ),
            };

      const suggestions = testCase.threads
        .map((thread) => {
          const events = thread.events
            .map((event) =>
              buildEvent(event, thread.assignedSourceSessionIds[0]!),
            )
            .sort(compareThreadEvents);
          const scoring: ThreadScoringInput = {
            workThread: {
              workThreadId: thread.workThreadId,
              projectId,
              title: thread.title,
              goal: null,
              state: thread.state,
              createdAt: thread.updatedAt,
              updatedAt: thread.updatedAt,
            },
            assignedSourceSessionIds: new Set(thread.assignedSourceSessionIds),
            events,
          };
          return scoreThreadSuggestion(scoring, candidate, {
            activeThreadCount: testCase.activeThreadCount,
            nowMs,
          });
        })
        .filter((suggestion) => suggestion !== null);

      const ranked = rankSuggestions(suggestions);

      if (testCase.expected.topWorkThreadId === null) {
        expect(ranked, testCase.id).toHaveLength(0);
        continue;
      }
      expect(ranked.length, testCase.id).toBeGreaterThan(0);
      expect(ranked[0]!.workThread.workThreadId, testCase.id).toBe(
        testCase.expected.topWorkThreadId,
      );
      expect(ranked[0]!.reasons, testCase.id).toEqual(
        expect.arrayContaining(testCase.expected.reasons),
      );
      expect(ranked[0]!.score, testCase.id).toBeGreaterThanOrEqual(
        testCase.expected.minScore,
      );
    }
  });
});
