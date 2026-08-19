/**
 * idb-search-index-projector projects RDF quads into search chunks stored in
 * IndexedDB. It handles chunk creation, embedding projection, and chunk
 * cleanup — the write side of the IndexedDB hybrid search index.
 */

import type * as rdfjs from "@rdfjs/types";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { chunkQuads } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { IdbChunkStore, SearchChunkRecord } from "./idb-chunk-store.ts";

/** ProjectorOptions configures the search chunk projector. */
export interface ProjectorOptions {
  /** chunkStore is the IDB-backed chunk store for persisting search chunks. */
  chunkStore: IdbChunkStore;

  /** textSplitter splits long literal values into chunk rows. */
  textSplitter: TextSplitterInterface;

  /** embeddingService optionally projects chunk text into comparison vectors. */
  embeddingService?: EmbeddingService;

  /**
   * vectorDimensions is the expected embedding dimensionality (must match
   * the embedding service output). Required when embeddingService is set.
   */
  vectorDimensions?: number;
}

/**
 * buildChunkFtsValue returns the lowercased text content for keyword scoring.
 * Mirrors the reference (libsql/sqlite) contract: keyword search matches
 * object literal text only.
 */
export function buildChunkFtsValue(value: string): string {
  return value.toLowerCase();
}

/**
 * projectChunks creates search chunks from novel quad insertions. Each textual
 * literal is split into chunks (via the textSplitter), and each chunk is
 * optionally embedded and stored in the IDB chunk store.
 */
export async function projectChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectorOptions,
): Promise<void> {
  if (novelInsertions.length === 0) return;

  const chunks = await chunkQuads(
    novelInsertions,
    options.textSplitter,
    novelQuadIds,
  );

  if (chunks.length === 0) return;

  // Build chunk records with FTS values
  const records: SearchChunkRecord[] = chunks.map((chunk) => ({
    quad_id: chunk.quad_id,
    subject: chunk.subject,
    predicate: chunk.predicate,
    graph: chunk.graph,
    value: chunk.value,
    fts_value: buildChunkFtsValue(chunk.value),
  }));

  // Optionally embed chunk text
  if (options.embeddingService) {
    const textsToEmbed = records.map((r) => r.value);
    try {
      const vectors = await options.embeddingService.embed(textsToEmbed);
      for (let i = 0; i < records.length; i++) {
        records[i]!.vector = Array.from(vectors[i]!);
      }
    } catch (error) {
      // Graceful degradation: store chunks without vectors (keyword-only search)
      console.warn(
        `[Search Warning] Embedding service failure during projection. ` +
          `Chunks stored without vectors (keyword-only). Reason: ${
            (error as Error).message
          }`,
      );
    }
  }

  await options.chunkStore.insertChunks(records);
}

/**
 * refreshChunksForQuads deletes existing chunks for the given quad ids and
 * re-projects them. Returns the number of chunk rows written.
 */
export async function refreshChunksForQuads(
  quads: rdfjs.Quad[],
  quadIds: string[],
  options: ProjectorOptions,
): Promise<number> {
  if (quads.length === 0) return 0;

  // Phase 1: sweep old chunks
  await options.chunkStore.deleteByQuadIds(quadIds);

  // Phase 2: re-project
  await projectChunks(quads, quadIds, options);

  return (await options.chunkStore.getChunksByQuadIds(quadIds)).length;
}
