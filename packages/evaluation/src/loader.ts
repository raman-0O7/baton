import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCorpusDocument,
  type AdapterExpectedEventsCorpus,
  type AdapterParityCorpus,
  type AdapterTransitionCorpus,
  type CorpusDocument,
  type EvaluationCorpus,
  type IngestionConvergenceCorpus,
  type MemoryCorpus,
  type RetrievalCorpus,
  type ThreadSuggestionCorpus,
} from './schema.js';

export const corpusDocuments = {
  adapterParity: 'testdata/hosted/adapters/manifest-v1.json',
  adapterExpectedEvents: 'testdata/hosted/adapters/expected-events-v1.json',
  adapterTransitions: 'testdata/hosted/adapters/transitions-v1.json',
  ingestionConvergence: 'testdata/hosted/ingestion/convergence-v1.json',
  retrieval: 'testdata/hosted/retrieval/cases-v1.json',
  memory: 'testdata/hosted/memory/cases-v1.json',
  threadSuggestion: 'testdata/hosted/threads/suggestion-cases-v1.json',
} as const;

export function repositoryRootFrom(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '../../..');
}

export async function loadCorpusDocument(
  repositoryRoot: string,
  relativePath: string,
): Promise<CorpusDocument> {
  const encoded = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
  const document: unknown = JSON.parse(encoded);
  assertCorpusDocument(document);
  return document;
}

export async function loadEvaluationCorpus(
  repositoryRoot: string,
): Promise<EvaluationCorpus> {
  const [
    adapterParity,
    adapterExpectedEvents,
    adapterTransitions,
    ingestionConvergence,
    retrieval,
    memory,
    threadSuggestion,
  ] = await Promise.all([
    loadCorpusDocument(repositoryRoot, corpusDocuments.adapterParity),
    loadCorpusDocument(repositoryRoot, corpusDocuments.adapterExpectedEvents),
    loadCorpusDocument(repositoryRoot, corpusDocuments.adapterTransitions),
    loadCorpusDocument(repositoryRoot, corpusDocuments.ingestionConvergence),
    loadCorpusDocument(repositoryRoot, corpusDocuments.retrieval),
    loadCorpusDocument(repositoryRoot, corpusDocuments.memory),
    loadCorpusDocument(repositoryRoot, corpusDocuments.threadSuggestion),
  ]);

  if (adapterParity.datasetKind !== 'adapter_parity') {
    throw new TypeError('adapter parity corpus has the wrong datasetKind');
  }
  if (adapterExpectedEvents.datasetKind !== 'adapter_expected_events') {
    throw new TypeError('adapter event corpus has the wrong datasetKind');
  }
  if (adapterTransitions.datasetKind !== 'adapter_transitions') {
    throw new TypeError('adapter transition corpus has the wrong datasetKind');
  }
  if (ingestionConvergence.datasetKind !== 'ingestion_convergence') {
    throw new TypeError('ingestion corpus has the wrong datasetKind');
  }
  if (retrieval.datasetKind !== 'retrieval') {
    throw new TypeError('retrieval corpus has the wrong datasetKind');
  }
  if (memory.datasetKind !== 'memory') {
    throw new TypeError('memory corpus has the wrong datasetKind');
  }
  if (threadSuggestion.datasetKind !== 'thread_suggestion') {
    throw new TypeError('thread suggestion corpus has the wrong datasetKind');
  }

  return {
    adapterParity: adapterParity as AdapterParityCorpus,
    adapterExpectedEvents: adapterExpectedEvents as AdapterExpectedEventsCorpus,
    adapterTransitions: adapterTransitions as AdapterTransitionCorpus,
    ingestionConvergence: ingestionConvergence as IngestionConvergenceCorpus,
    retrieval: retrieval as RetrievalCorpus,
    memory: memory as MemoryCorpus,
    threadSuggestion: threadSuggestion as ThreadSuggestionCorpus,
  };
}
