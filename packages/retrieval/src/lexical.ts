import type { Chunk, ChunkKind } from '@baton/indexing';

export interface RankedChunk {
  chunk: Chunk;
  score: number;
  matchedTerms: string[];
}

export interface RankOptions {
  limit?: number;
}

const bm25K1 = 1.5;
const bm25B = 0.75;

// Small additive importance so decisions, errors, and tasks edge out chatter on
// a score tie — the structured outcomes a continuation usually needs most.
const kindWeight: Record<ChunkKind, number> = {
  decision: 0.05,
  error: 0.05,
  task: 0.03,
  file_change: 0.02,
  tool_use: 0.0,
  message: 0.0,
};

const stopwords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

/**
 * Deterministic term extraction: lowercase, split on non-alphanumerics (dotted
 * identifiers like `greet.go` also yield their parts), drop stopwords and
 * single characters. No stemming — the retriever leans on exact term overlap so
 * results are explainable and reproducible.
 */
export function extractTerms(text: string): string[] {
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || stopwords.has(raw)) continue;
    terms.push(raw);
  }
  return terms;
}

/**
 * Rank chunks for a free-text query with a compact BM25 over the supplied
 * chunk set (the caller is responsible for tenant/project/thread scoping before
 * calling). Ties break by recency then chunk id so the order is total and
 * stable. Only chunks that match at least one query term are returned.
 */
export function rankChunks(
  query: string,
  chunks: readonly Chunk[],
  options: RankOptions = {},
): RankedChunk[] {
  const queryTerms = new Set(extractTerms(query));
  if (queryTerms.size === 0 || chunks.length === 0) return [];

  const docTerms = chunks.map((chunk) => extractTerms(chunk.text));
  const docLengths = docTerms.map((terms) => terms.length);
  const avgdl =
    docLengths.reduce((sum, length) => sum + length, 0) /
    Math.max(1, docLengths.length);
  const documentFrequency = new Map<string, number>();
  for (const terms of docTerms) {
    for (const term of new Set(terms)) {
      if (queryTerms.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const total = chunks.length;
  const ranked: RankedChunk[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const terms = docTerms[index]!;
    const length = docLengths[index]!;
    const frequency = new Map<string, number>();
    for (const term of terms) {
      if (queryTerms.has(term)) {
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
      }
    }
    if (frequency.size === 0) continue;

    let score = 0;
    for (const [term, freq] of frequency) {
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator =
        freq + bm25K1 * (1 - bm25B + (bm25B * length) / avgdl);
      score += idf * ((freq * (bm25K1 + 1)) / denominator);
    }
    score += kindWeight[chunk.kind];
    ranked.push({ chunk, score, matchedTerms: [...frequency.keys()].sort() });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const recency = right.chunk.occurredAt.localeCompare(left.chunk.occurredAt);
    if (recency !== 0) return recency;
    return left.chunk.chunkId.localeCompare(right.chunk.chunkId);
  });

  const limit = options.limit ?? ranked.length;
  return dedupeRanked(ranked).slice(0, Math.max(0, limit));
}

/**
 * Drop chunks that repeat an already-seen chunk id or identical text, keeping
 * the first (highest-ranked) occurrence. Prevents a near-duplicate from
 * crowding out diverse evidence within a token budget.
 */
export function dedupeRanked(ranked: readonly RankedChunk[]): RankedChunk[] {
  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  const kept: RankedChunk[] = [];
  for (const item of ranked) {
    const key = item.chunk.text.toLowerCase();
    if (seenIds.has(item.chunk.chunkId) || seenText.has(key)) continue;
    seenIds.add(item.chunk.chunkId);
    seenText.add(key);
    kept.push(item);
  }
  return kept;
}
