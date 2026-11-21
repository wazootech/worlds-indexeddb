/**
 * idb-search-index-projector projects RDF quads into search chunks stored in
 * IndexedDB. It handles chunk creation, embedding projection, and chunk
 * cleanup — the write side of the IndexedDB hybrid search index.
 */

import type * as rdfjs from "@rdfjs/types";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { chunkAndEmbedQuads } from "@worlds/sdk/search-index/quad-chunker";
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
 * buildChunkRecords chunks and embeds novel quad insertions, through the shared
 * `chunkAndEmbedQuads`, and returns the rows to write without writing them. A
 * chunking failure rejects here, so a caller that builds first writes nothing.
 * An embedding failure rejects too, as on every worlds backend, so a caller
 * that builds first writes nothing and can retry.
 *
 * The embedding input stays the chunk's original text. `ftsValueOf` is not
 * used on purpose: it would also embed the lowercased text, changing the stored
 * vectors. `vectorDimensions` is not forwarded either, because the SDK factory
 * defaults it to 1536 and a service with another size (the 512-dimension
 * Universal Sentence Encoder) would then degrade every projection.
 */
export async function buildChunkRecords(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectorOptions,
): Promise<SearchChunkRecord[]> {
  if (novelInsertions.length === 0) return [];

  // The SDK's default is to throw on an embedding failure; no option is passed.
  const { rows } = await chunkAndEmbedQuads(
    novelInsertions,
    novelQuadIds,
    {
      textSplitter: options.textSplitter,
      embeddingService: options.embeddingService,
    },
  );

  return rows.map(({ chunk, vector }) => ({
    quad_id: chunk.quad_id,
    subject: chunk.subject,
    predicate: chunk.predicate,
    graph: chunk.graph,
    value: chunk.value,
    fts_value: buildChunkFtsValue(chunk.value),
    ...(vector ? { vector: Array.from(vector) } : {}),
  }));
}

/** projectChunks builds the chunk records for novel quad insertions and stores them. */
export async function projectChunks(
  novelInsertions: rdfjs.Quad[],
  novelQuadIds: string[],
  options: ProjectorOptions,
): Promise<void> {
  const records = await buildChunkRecords(
    novelInsertions,
    novelQuadIds,
    options,
  );
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
