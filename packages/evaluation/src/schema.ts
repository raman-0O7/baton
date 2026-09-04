import type { SourceEvent } from '@baton/protocol';

export type CorpusOrigin =
  'derived_from_sanitized_fixture' | 'synthetic_scenario';

export type AgentName = 'claudecode' | 'codex' | 'opencode';

export interface AdapterFixture {
  id: string;
  agent: AgentName;
  formatVersion: string;
  origin: 'derived_from_sanitized_fixture';
  nativeFixture: string;
  nativeSha256: string;
  legacyGolden: string;
  legacyGoldenSha256: string;
  expectedEventsCase: string;
}

export interface AdapterParityCorpus {
  schemaVersion: 1;
  datasetKind: 'adapter_parity';
  fixtures: AdapterFixture[];
}

export interface AdapterExpectedEventsCorpus {
  schemaVersion: 1;
  datasetKind: 'adapter_expected_events';
  identityFields: {
    status: 'intentionally_omitted';
    fields: string[];
    reason: string;
  };
  cases: Array<{
    id: string;
    agent: AgentName;
    origin: 'derived_from_sanitized_fixture';
    sourceFixture: string;
    sourceGolden: string;
    events: Array<{
      key: string;
      occurredAt: string;
      sourcePointer: string;
      nativeLocator: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>;
  }>;
}

export interface AdapterTransitionCase {
  id: string;
  agents: AgentName[];
  origin: CorpusOrigin;
  scenario: 'incremental_append' | 'partial_final_line' | 'truncation_rewrite';
  sourceFixtures: string[];
  steps: unknown[];
  invariants: string[];
}

export interface AdapterTransitionCorpus {
  schemaVersion: 1;
  datasetKind: 'adapter_transitions';
  cases: AdapterTransitionCase[];
}

export interface IngestionConvergenceCase {
  id: string;
  origin: 'synthetic_scenario';
  scenario: 'duplicate' | 'out_of_order' | 'divergence';
  events: SourceEvent[];
  deliveries: unknown[];
  expected: Record<string, unknown>;
}

export interface IngestionConvergenceCorpus {
  schemaVersion: 1;
  datasetKind: 'ingestion_convergence';
  cases: IngestionConvergenceCase[];
}

export interface RetrievalCorpus {
  schemaVersion: 1;
  datasetKind: 'retrieval';
  origin: CorpusOrigin;
  evidence: Array<{
    id: string;
    sourceGolden: string;
    sourcePointer: string;
    text: string;
    projectId: string;
    workThreadId: string;
  }>;
  cases: Array<{
    id: string;
    question: string;
    projectId: string;
    workThreadId: string;
    expectedEvidenceIds: string[];
    excludedEvidenceIds: string[];
    maxContextTokens: number;
  }>;
}

export interface MemoryCorpus {
  schemaVersion: 1;
  datasetKind: 'memory';
  origin: 'synthetic_scenario';
  evidence: Array<{
    id: string;
    projectId: string;
    workThreadId: string;
    role: 'user' | 'assistant';
    text: string;
  }>;
  cases: Array<{
    id: string;
    category:
      | 'acceptable_candidate'
      | 'wrong_scope'
      | 'insufficient_evidence'
      | 'contradiction'
      | 'prohibited_sensitive_inference';
    evidenceIds: string[];
    proposedCandidate: {
      statement: string;
      scope: 'global' | 'organization' | 'project' | 'work_thread';
      projectId?: string;
      workThreadId?: string;
    };
    expected: {
      verdict: 'accept' | 'reject' | 'needs_review';
      scope?: 'global' | 'organization' | 'project' | 'work_thread';
      reasonCode: string;
    };
  }>;
}

export interface ThreadSuggestionEvent {
  sourceSessionId?: string;
  sourceAgent?: AgentName;
  sourceDeviceId?: string;
  occurredAt: string;
  nativeSequence?: number | null;
  payload: Record<string, unknown>;
}

export interface ThreadSuggestionCorpus {
  schemaVersion: 1;
  datasetKind: 'thread_suggestion';
  origin: 'synthetic_scenario';
  nowIso: string;
  cases: Array<{
    id: string;
    description: string;
    activeThreadCount: number;
    candidate: {
      sourceSessionId: string;
      sourceAgent: AgentName;
      sourceDeviceId: string;
      events: ThreadSuggestionEvent[];
    } | null;
    threads: Array<{
      workThreadId: string;
      title: string;
      state: 'active' | 'paused' | 'completed' | 'archived';
      updatedAt: string;
      assignedSourceSessionIds: string[];
      events: ThreadSuggestionEvent[];
    }>;
    expected: {
      topWorkThreadId: string | null;
      reasons: string[];
      minScore: number;
    };
  }>;
}

export type CorpusDocument =
  | AdapterParityCorpus
  | AdapterExpectedEventsCorpus
  | AdapterTransitionCorpus
  | IngestionConvergenceCorpus
  | RetrievalCorpus
  | MemoryCorpus
  | ThreadSuggestionCorpus;

export interface EvaluationCorpus {
  adapterParity: AdapterParityCorpus;
  adapterExpectedEvents: AdapterExpectedEventsCorpus;
  adapterTransitions: AdapterTransitionCorpus;
  ingestionConvergence: IngestionConvergenceCorpus;
  retrieval: RetrievalCorpus;
  memory: MemoryCorpus;
  threadSuggestion: ThreadSuggestionCorpus;
}

const datasetKinds = new Set([
  'adapter_parity',
  'adapter_expected_events',
  'adapter_transitions',
  'ingestion_convergence',
  'retrieval',
  'memory',
  'thread_suggestion',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertArray(
  value: unknown,
  field: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
}

export function assertCorpusDocument(
  value: unknown,
): asserts value is CorpusDocument {
  if (!isRecord(value)) {
    throw new TypeError('corpus document must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError('corpus schemaVersion must be 1');
  }
  if (
    typeof value.datasetKind !== 'string' ||
    !datasetKinds.has(value.datasetKind)
  ) {
    throw new TypeError('corpus datasetKind is unsupported');
  }

  switch (value.datasetKind) {
    case 'adapter_parity':
      assertArray(value.fixtures, 'fixtures');
      break;
    case 'adapter_expected_events':
    case 'adapter_transitions':
    case 'ingestion_convergence':
      assertArray(value.cases, 'cases');
      break;
    case 'retrieval':
    case 'memory':
      assertArray(value.evidence, 'evidence');
      assertArray(value.cases, 'cases');
      break;
    case 'thread_suggestion':
      assertArray(value.cases, 'cases');
      break;
  }
}
