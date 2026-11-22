import type * as rdfjs from "@rdfjs/types";
import type { ReindexRequest, ReindexResponse } from "@worlds/sdk/search-index";
import { filterQuads, hashQuads } from "@worlds/sdk/quad-store";
import type { QuadFilter } from "@worlds/sdk/quad-store";
import type { IndexeddbSearchIndexOptions } from "./indexeddb-search-index.ts";
import { buildChunkRecords } from "./idb-search-index-projector.ts";
import type { SearchChunkRecord } from "./idb-chunk-store.ts";

/** hasCriteria is true when one side of a QuadFilter names anything to match. */
function hasCriteria(side: QuadFilter["include"]): boolean {
  return side !== undefined && Object.values(side).some((v) => v?.length);
}

/**
 * reindexChunks rebuilds search chunks from the quads in `quadsStore`, with the
 * semantics of the SQL backends' `rebuildSqlSearchIndexWithCounts`: it chunks
 * and embeds the in-scope textual literals page by page, and only then writes,
 * in one transaction, so a failed embedding leaves the old chunks.
 *
 * Unscoped, the write replaces the whole chunk store (orphan rows included). A
 * scope (include or exclude with any criteria) clears nothing: it replaces only
 * the chunk rows of the in-scope quads and leaves every other row alone.
 * `processedQuadCount` is every stored quad scanned, in scope or not.
 */
export async function reindexChunks(
  options: IndexeddbSearchIndexOptions,
  request?: ReindexRequest,
): Promise<ReindexResponse> {
  const quadsStore = options.quadsStore;
  if (!quadsStore) {
    throw new Error(
      "IndexeddbSearchIndex reindex requires quadsStore in options",
    );
  }

  const include = request?.include ?? options.include;
  const exclude = request?.exclude ?? options.exclude;
  const scoped = hasCriteria(include) || hasCriteria(exclude);
  const inScope = scoped ? filterQuads({ include, exclude }) : () => true;
  const readPageSize = Math.max(1, request?.readPageSize ?? 1000);

  // Scan all quads from the store (a known limit: SQL pages by keyset instead).
  const scanned: rdfjs.Quad[] = [];
  const stream = quadsStore.match(null, null, null, null);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (quad: rdfjs.Quad) => scanned.push(quad));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const quads = scanned.filter(inScope);

  // Build every row first; nothing is written until all pages are embedded.
  // chunkAndEmbedQuads keeps only textual literals, so pages are not pre-filtered.
  const records: SearchChunkRecord[] = [];
  const scopeIds: string[] = [];
  for (let i = 0; i < quads.length; i += readPageSize) {
    const page = quads.slice(i, i + readPageSize);
    const quadIds = await hashQuads(page);
    scopeIds.push(...quadIds);
    records.push(
      ...await buildChunkRecords(page, quadIds, {
        chunkStore: options.chunkStore,
        textSplitter: options.textSplitter,
        embeddingService: options.embeddingService,
        vectorDimensions: options.vectorDimensions,
      }),
    );
  }

  if (scoped) {
    await options.chunkStore.replaceForQuads(scopeIds, records);
  } else {
    await options.chunkStore.replaceAll(records);
  }

  return {
    processedQuadCount: scanned.length,
    chunkRowCount: records.length,
  };
}
