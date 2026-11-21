import type * as rdfjs from "@rdfjs/types";
import type { ReindexRequest, ReindexResponse } from "@worlds/sdk/search-index";
import {
  filterQuads,
  hashQuads,
  isTextualLiteral,
} from "@worlds/sdk/quad-store";
import type { IndexeddbSearchIndexOptions } from "./indexeddb-search-index.ts";
import { buildChunkRecords } from "./idb-search-index-projector.ts";
import type { SearchChunkRecord } from "./idb-chunk-store.ts";

/**
 * reindexChunks rebuilds every search chunk from the quads in `quadsStore`: it
 * chunks and embeds the textual literals page by page, then swaps the whole
 * chunk store in one transaction, so a failed embedding leaves the old chunks.
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
  const readPageSize = request?.readPageSize ?? 1000;

  // Scan all quads from the store
  const allQuads: rdfjs.Quad[] = [];
  const stream = quadsStore.match(null, null, null, null);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (quad: rdfjs.Quad) => {
      const matcher = filterQuads({ include, exclude });
      if (matcher(quad)) {
        allQuads.push(quad);
      }
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  // Build every row first; nothing is written until all pages are embedded.
  const records: SearchChunkRecord[] = [];
  for (let i = 0; i < allQuads.length; i += readPageSize) {
    const page = allQuads.slice(i, i + readPageSize);
    const quadIds = await hashQuads(page);

    // Only project textual literals
    const textChunks = page.filter((quad) => isTextualLiteral(quad.object));
    const textQuadIds = quadIds.filter((_, index) =>
      isTextualLiteral(page[index]!.object)
    );

    records.push(
      ...await buildChunkRecords(textChunks, textQuadIds, {
        chunkStore: options.chunkStore,
        textSplitter: options.textSplitter,
        embeddingService: options.embeddingService,
        vectorDimensions: options.vectorDimensions,
      }),
    );
  }

  await options.chunkStore.replaceAll(records);

  return {
    processedQuadCount: allQuads.length,
    chunkRowCount: records.length,
  };
}
