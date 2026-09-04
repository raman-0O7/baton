import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  validateMemoryCandidate,
  type MemoryEvidenceInput,
} from '../src/index.js';

interface CorpusEvidence {
  id: string;
  projectId: string;
  workThreadId: string;
  role: string;
  text: string;
}

interface CorpusCase {
  id: string;
  category: string;
  evidenceIds: string[];
  proposedCandidate: { statement: string; scope: string };
  expected: { verdict: string; scope?: string; reasonCode: string };
}

describe('memory validation gate', () => {
  it('reproduces the locked verdict and reason for every memory case', async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL(
          '../../../testdata/hosted/memory/cases-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { evidence: CorpusEvidence[]; cases: CorpusCase[] };
    const evidenceById = new Map(
      corpus.evidence.map((item) => [item.id, item]),
    );

    for (const testCase of corpus.cases) {
      const evidence: MemoryEvidenceInput[] = testCase.evidenceIds.map((id) => {
        const item = evidenceById.get(id)!;
        return {
          eventId: item.id,
          projectId: item.projectId,
          workThreadId: item.workThreadId,
          text: item.text,
          role: item.role,
        };
      });

      const result = validateMemoryCandidate({
        claim: testCase.proposedCandidate.statement,
        scopeType: testCase.proposedCandidate.scope as
          'global' | 'organization' | 'project' | 'work_thread',
        evidence,
      });

      expect(result.verdict, testCase.id).toBe(testCase.expected.verdict);
      expect(result.reasonCode, testCase.id).toBe(testCase.expected.reasonCode);
      if (testCase.expected.scope !== undefined) {
        expect(result.suggestedScopeType, testCase.id).toBe(
          testCase.expected.scope,
        );
      }
    }
  });

  it('never accepts a sensitive inference even from benign evidence', async () => {
    const result = validateMemoryCandidate({
      claim: 'The user has diabetes.',
      scopeType: 'global',
      evidence: [
        {
          eventId: 'e',
          projectId: 'p',
          workThreadId: null,
          text: 'Schedule the deploy around my weekly insulin appointment.',
        },
        {
          eventId: 'e2',
          projectId: 'p2',
          workThreadId: null,
          text: 'Insulin appointment again next week.',
        },
      ],
    });
    // Even with repeated cross-project evidence, a health inference is rejected.
    expect(result.verdict).toBe('reject');
    expect(result.reasonCode).toBe('sensitive_health_inference_prohibited');
  });
});
