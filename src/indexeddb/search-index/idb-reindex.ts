import type * as rdfjs from "@rdfjs/types";
import type { ReindexRequest, ReindexResponse } from "@worlds/sdk/search-index";
import {
  filterQuads,
  hashQuads,
  isTextualLiteral,
} from "@worlds/sdk/quad-store";
import type { IndexeddbSearchIndexOptions } from "./indexeddb-search-index.ts";
import { projectChunks } from "./idb-search-index-projector.ts";

/**
 * reindexChunks rebuilds every search chunk from the quads in `quadsStore`: it
 * clears the chunk store, then projects the textual literals page by page.
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

  // Clear existing chunks and re-project
  await options.chunkStore.clear();

  // Process in pages
  for (let i = 0; i < allQuads.length; i += readPageSize) {
    const page = allQuads.slice(i, i + readPageSize);
    const quadIds = await hashQuads(page);

    // Only project textual literals
    const textChunks = page.filter((quad) => isTextualLiteral(quad.object));
    const textQuadIds = quadIds.filter((_, index) =>
      isTextualLiteral(page[index]!.object)
    );

    if (textChunks.length > 0) {
      await projectChunks(textChunks, textQuadIds, {
        chunkStore: options.chunkStore,
        textSplitter: options.textSplitter,
        embeddingService: options.embeddingService,
        vectorDimensions: options.vectorDimensions,
      });
    }
  }

  const chunkRowCount = await options.chunkStore.countChunks();

  return {
    processedQuadCount: allQuads.length,
    chunkRowCount,
  };
}
