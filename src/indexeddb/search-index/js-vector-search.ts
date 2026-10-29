import type { SearchChunkRecord } from "./idb-chunk-store.ts";
import type { SearchResultRow } from "./js-search-types.ts";

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
