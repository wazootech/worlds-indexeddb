/**
 * js-search-engine implements JS-side keyword scoring (TF-IDF) and vector
 * similarity (cosine) for the IndexedDB search index. Since IndexedDB has no
 * built-in FTS or vector search, all scoring runs in JS over the chunk store.
 */

import type { SearchChunkRecord } from "./idb-chunk-store.ts";

/** IDB_SEARCH_STOPWORDS are common English words excluded from keyword scoring. */
const IDB_SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "these",
  "those",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

/**
 * tokenize splits text into lowercase word tokens, stripping punctuation and
 * filtering stopwords.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}\p{M}]+/gu, ""))
    .filter(
      (token) => token.length > 0 && !IDB_SEARCH_STOPWORDS.has(token),
    );
}

/**
 * computeTermFrequencies computes raw term frequency for a tokenized document.
 */
function computeTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * computeIdf computes inverse document frequency for query terms across a
 * corpus of chunks.
 */
function computeIdf(
  queryTokens: string[],
  corpusFtsValues: string[],
): Map<string, number> {
  const totalDocs = corpusFtsValues.length;
  const idf = new Map<string, number>();

  for (const token of queryTokens) {
    let docCount = 0;
    for (const ftsValue of corpusFtsValues) {
      if (ftsValue.includes(token)) {
        docCount++;
      }
    }
    // Standard IDF with smoothing: log((1 + N) / (1 + df)) + 1
    idf.set(
      token,
      Math.log((1 + totalDocs) / (1 + docCount)) + 1,
    );
  }

  return idf;
}

/**
 * keywordScore computes a TF-IDF score for a single chunk against query tokens.
 */
function keywordScore(
  chunkFtsValue: string,
  queryTokens: string[],
  idf: Map<string, number>,
): number {
  const tokens = chunkFtsValue.split(/\s+/).filter((t) => t.length > 0);
  const tf = computeTermFrequencies(tokens);
  const maxTf = Math.max(1, ...tf.values());

  let score = 0;
  for (const token of queryTokens) {
    const termFreq = tf.get(token) ?? 0;
    const normalizedTf = termFreq / maxTf;
    const tokenIdf = idf.get(token) ?? 1;
    score += normalizedTf * tokenIdf;
  }

  return score;
}

/**
 * cosineSimilarity computes the cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/** SearchResultRow is an intermediate search result before RRF fusion. */
export interface SearchResultRow {
  chunkId: number;
  subject: string;
  predicate: string;
  graph: string;
  value: string;
  keywordRank?: number;
  vectorRank?: number;
  keywordScore?: number;
  vectorScore?: number;
}

/**
 * RRF_K is the constant used in Reciprocal Rank Fusion: score = 1 / (k + rank).
 * Matches the libsql/sqlite reference constant (k=60).
 */
export const RRF_K = 60;

/**
 * searchKeyword performs JS-side TF-IDF keyword search over all chunks.
 * Returns results ranked by TF-IDF score, with ranks assigned by position.
 */
export function searchKeyword(
  query: string,
  chunks: SearchChunkRecord[],
  limit: number,
  filter?: {
    subjects?: string[];
    predicates?: string[];
    graphs?: string[];
  },
): SearchResultRow[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const ftsValues = chunks.map((c) => c.fts_value);
  const idf = computeIdf(queryTokens, ftsValues);

  const scored: SearchResultRow[] = [];

  for (const chunk of chunks) {
    // Apply QuadFilter-style inclusion filtering
    if (filter?.subjects?.length && !filter.subjects.includes(chunk.subject)) {
      continue;
    }
    if (
      filter?.predicates?.length &&
      !filter.predicates.includes(chunk.predicate)
    ) {
      continue;
    }
    if (filter?.graphs?.length && !filter.graphs.includes(chunk.graph)) {
      continue;
    }

    const score = keywordScore(chunk.fts_value, queryTokens, idf);
    if (score > 0) {
      scored.push({
        chunkId: chunk.id!,
        subject: chunk.subject,
        predicate: chunk.predicate,
        graph: chunk.graph,
        value: chunk.value,
        keywordScore: score,
      });
    }
  }

  // Sort by keyword score descending, assign ranks
  scored.sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0));

  return scored.slice(0, limit).map((row, index) => ({
    ...row,
    keywordRank: index + 1,
  }));
}

/**
 * searchVector performs JS-side cosine similarity vector search over all chunks
 * that have embeddings. Returns results ranked by similarity.
 */
export function searchVector(
  queryVector: number[],
  chunks: SearchChunkRecord[],
  limit: number,
  filter?: {
    subjects?: string[];
    predicates?: string[];
    graphs?: string[];
  },
): SearchResultRow[] {
  if (queryVector.length === 0) return [];

  const scored: SearchResultRow[] = [];

  for (const chunk of chunks) {
    if (!chunk.vector || chunk.vector.length === 0) continue;

    // Apply QuadFilter-style inclusion filtering
    if (filter?.subjects?.length && !filter.subjects.includes(chunk.subject)) {
      continue;
    }
    if (
      filter?.predicates?.length &&
      !filter.predicates.includes(chunk.predicate)
    ) {
      continue;
    }
    if (filter?.graphs?.length && !filter.graphs.includes(chunk.graph)) {
      continue;
    }

    const similarity = cosineSimilarity(queryVector, chunk.vector);
    if (similarity > 0) {
      scored.push({
        chunkId: chunk.id!,
        subject: chunk.subject,
        predicate: chunk.predicate,
        graph: chunk.graph,
        value: chunk.value,
        vectorScore: similarity,
      });
    }
  }

  // Sort by vector score descending, assign ranks
  scored.sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0));

  return scored.slice(0, limit).map((row, index) => ({
    ...row,
    vectorRank: index + 1,
  }));
}

/**
 * fuseWithRrf combines keyword and vector results using Reciprocal Rank Fusion.
 * Each result gets score = 1/(k + rank) from each branch; overlapping chunk ids
 * sum both contributions.
 */
export function fuseWithRrf(
  keywordResults: SearchResultRow[],
  vectorResults: SearchResultRow[],
  limit: number,
): SearchResultRow[] {
  const fused = new Map<number, SearchResultRow>();

  for (const row of keywordResults) {
    const rrfScore = 1 / (RRF_K + (row.keywordRank ?? 0));
    fused.set(row.chunkId, {
      ...row,
      keywordScore: rrfScore,
      vectorScore: 0,
    });
  }

  for (const row of vectorResults) {
    const rrfScore = 1 / (RRF_K + (row.vectorRank ?? 0));
    const existing = fused.get(row.chunkId);
    if (existing) {
      existing.keywordScore = (existing.keywordScore ?? 0) + 0;
      existing.vectorScore = (existing.vectorScore ?? 0) + rrfScore;
    } else {
      fused.set(row.chunkId, {
        ...row,
        keywordScore: 0,
        vectorScore: rrfScore,
      });
    }
  }

  // Combine into final score
  const results: SearchResultRow[] = [];
  for (const row of fused.values()) {
    results.push({
      ...row,
      keywordScore: (row.keywordScore ?? 0) + (row.vectorScore ?? 0),
    });
  }

  results.sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0));
  return results.slice(0, limit);
}
