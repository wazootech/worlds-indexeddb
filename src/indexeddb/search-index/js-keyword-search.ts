import type { SearchChunkRecord } from "./idb-chunk-store.ts";
import type { SearchResultRow } from "./js-search-types.ts";
import { IDB_SEARCH_STOPWORDS } from "./js-search-stopwords.ts";

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
