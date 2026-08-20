import type { SparqlEngineInterface } from "@wazoo/sparql-engine";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { Sdk, type SdkInterface } from "@worlds/sdk";
import { RdfjsQuadStore } from "@worlds/sdk/rdfjs";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/mod.ts";
import { IdbChunkStore } from "@/indexeddb/search-index/mod.ts";
import { IndexeddbSearchIndex } from "@/indexeddb/search-index/mod.ts";

/**
 * IndexeddbSdkOptions configures createIndexeddbSdk.
 *
 * The exact surface follows the org convention (`createSqliteSdk` precedent,
 * backends aligning on the `*Sdk` suffix): the store's options plus an
 * optional pre-wired SPARQL engine, text splitter, and embedding service.
 */
export interface IndexeddbSdkOptions {
  /** IndexedDB database name backing the quad store. */
  dbName: string;

  /** Object store name for quads (defaults to "quads"). */
  storeName?: string;

  /** Object store name for search chunks (defaults to "search_chunks"). */
  chunkStoreName?: string;

  /**
   * textSplitter splits long literal values into chunk rows for search.
   * When provided, the SDK uses IndexeddbSearchIndex (hybrid keyword + vector)
   * instead of the scan-based RdfjsSearchIndex.
   */
  textSplitter?: TextSplitterInterface;

  /**
   * embeddingService optionally projects chunk text into comparison vectors
   * for vector similarity search. When omitted, keyword-only search is used.
   */
  embeddingService?: EmbeddingService;

  /**
   * vectorDimensions pins the expected embedding dimensionality (default 1536).
   * Must match the output of the embedding service.
   */
  vectorDimensions?: number;

  /**
   * searchIndexOnImport controls when chunk projection runs during import.
   * Defaults to "incremental" when textSplitter is provided.
   */
  searchIndexOnImport?: SearchIndexOnImport;

  /**
   * SPARQL engine to wire as the SDK's sparqlEngine. Defaults to a
   * WazooSparqlEngine over the IndexeddbStore with its `createTransaction`
   * hook, so SPARQL updates commit atomically (one IDB readwrite
   * transaction per update).
   */
  queryEngine?: SparqlEngineInterface;
}

/** DEFAULT_VECTOR_DIMENSIONS is the default embedding dimensionality. */
const DEFAULT_VECTOR_DIMENSIONS = 1536;

/**
 * createIndexeddbSdk assembles a Worlds SDK facade over an IndexedDB-backed
 * quad store. When a `textSplitter` is provided, the SDK uses
 * `IndexeddbSearchIndex` for JS-side hybrid search (TF-IDF keyword scoring
 * + cosine vector similarity, fused with RRF k=60). When no textSplitter is
 * provided, the scan-based `RdfjsSearchIndex` is used as a fallback.
 */
export async function createIndexeddbSdk(
  options: IndexeddbSdkOptions,
): Promise<SdkInterface> {
  const store = new IndexeddbStore({
    dbName: options.dbName,
    storeName: options.storeName,
  });

  // Open the quad store database first.
  await store.openDb();

  // Determine the search index: hybrid (if textSplitter provided) or scan-based.
  let searchIndex;
  if (options.textSplitter) {
    const chunkStore = new IdbChunkStore({
      dbName: options.dbName,
      chunkStoreName: options.chunkStoreName,
    });
    // Open the chunk store database (handles upgrade from v1 to v2).
    await chunkStore.openDb();

    searchIndex = new IndexeddbSearchIndex({
      chunkStore,
      textSplitter: options.textSplitter,
      embeddingService: options.embeddingService,
      vectorDimensions: options.vectorDimensions ?? DEFAULT_VECTOR_DIMENSIONS,
      searchIndexOnImport: options.searchIndexOnImport,
      quadsStore: store,
    });
  } else {
    // Fallback: scan-based search (no chunking, no hybrid).
    const { RdfjsSearchIndex } = await import("@worlds/sdk/rdfjs");
    searchIndex = new RdfjsSearchIndex(store);
  }

  return new Sdk({
    quadStore: new RdfjsQuadStore({ store }),
    sparqlEngine: options.queryEngine ??
      new WazooSparqlEngine({
        store,
        createTransaction: () => store.createTransaction(),
      }),
    searchIndex,
  });
}
