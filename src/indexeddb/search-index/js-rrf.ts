import type { SearchResultRow } from "./js-search-types.ts";

/**
 * RRF_K is the constant used in Reciprocal Rank Fusion: score = 1 / (k + rank).
 * Matches the libsql/sqlite reference constant (k=60).
 */
export const RRF_K = 60;

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
