import type * as rdfjs from "@rdfjs/types";
import type { ReindexRequest, ReindexResponse } from "@worlds/sdk/search-index";
import {
  type ChunkRebuildDriver,
  type RebuildPage,
  type RebuildScope,
  rebuildSearchIndex,
} from "@worlds/sdk/search-index";
import type { EmbeddedChunk } from "@worlds/sdk/search-index/quad-chunker";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";
import { pageStoredQuads } from "@/indexeddb/rdfjs-store/page-quads.ts";
import type { IndexeddbSearchIndexOptions } from "./indexeddb-search-index.ts";
import { toChunkRecords } from "./idb-search-index-projector.ts";
import type { IdbChunkStore } from "./idb-chunk-store.ts";

/** DEFAULT_READ_PAGE_SIZE is how many quads one reindex page reads unless the request says. */
const DEFAULT_READ_PAGE_SIZE = 1000;

/**
 * pagerFor returns the `pageQuads` of a rebuild driver over `store`. An
 * IndexeddbStore is read by cursor, one keyset page at a time. Any other
 * RDF/JS store has no ordered range to resume from, so it is read once with
 * `match` and that array is sliced, which keeps every quad in memory.
 */
function pagerFor(
  store: rdfjs.Store,
): ChunkRebuildDriver["pageQuads"] {
  if (store instanceof IndexeddbStore) {
    return ({ after, pageSize }) =>
      pageStoredQuads(store, { after: after as string | undefined, pageSize });
  }
  let scanned: Promise<rdfjs.Quad[]> | undefined;
  const scan = () =>
    scanned ??= new Promise<rdfjs.Quad[]>((resolve, reject) => {
      const all: rdfjs.Quad[] = [];
      const stream = store.match(null, null, null, null);
      stream.on("data", (quad: rdfjs.Quad) => all.push(quad));
      stream.on("end", () => resolve(all));
      stream.on("error", reject);
    });
  return async ({ after, pageSize }): Promise<RebuildPage> => {
    const all = await scan();
    const from = (after as number | undefined) ?? 0;
    const end = from + pageSize;
    return {
      quads: all.slice(from, end),
      next: end < all.length ? end : undefined,
    };
  };
}

/**
 * bufferingDriver is the IndexedDB half of the shared rebuild loop. It reads
 * pages through `pageQuads`, buffers every embedded page in `writePage`, and
 * does the one chunk-store transaction in `finish`, so a failed embedding (or a
 * failed write) leaves the old chunks: the all-or-nothing swap.
 */
function bufferingDriver(
  chunkStore: IdbChunkStore,
  pageQuads: ChunkRebuildDriver["pageQuads"],
): ChunkRebuildDriver {
  const rows: EmbeddedChunk[] = [];
  const hashes: string[] = [];
  let unscoped = false;
  return {
    pageQuads,
    writePage(scope: RebuildScope, pageRows: EmbeddedChunk[]) {
      rows.push(...pageRows);
      if ("hashes" in scope) hashes.push(...scope.hashes);
      else unscoped = true;
      return Promise.resolve();
    },
    finish() {
      const records = toChunkRecords(rows);
      return unscoped
        ? chunkStore.replaceAll(records)
        : chunkStore.replaceForQuads(hashes, records);
    },
  };
}

/**
 * reindexChunks rebuilds search chunks from the quads in `quadsStore` through
 * the SDK's shared `rebuildSearchIndex` loop, the same one the SQL backends
 * run: it pages the stored quads, chunks and embeds each page, and only then
 * writes, in one transaction, so a failed embedding leaves the old chunks.
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
  const driver = bufferingDriver(options.chunkStore, pagerFor(quadsStore));
  return await rebuildSearchIndex(
    driver,
    {
      textSplitter: options.textSplitter,
      embeddingService: options.embeddingService,
    },
    {
      pageSize: request?.readPageSize ?? DEFAULT_READ_PAGE_SIZE,
      scope: {
        include: request?.include ?? options.include,
        exclude: request?.exclude ?? options.exclude,
      },
    },
  );
}
