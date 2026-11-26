import type { SparqlEngineInterface } from "@wazoo/sparql-engine";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { WorldsSdk, type WorldsSdkInterface } from "@worlds/sdk";
import { RdfjsQuadStore } from "@worlds/sdk/rdfjs";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import type { QuadCriteria } from "@worlds/sdk/quad-store";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/mod.ts";
import { IdbChunkStore } from "@/indexeddb/search-index/mod.ts";
import { IndexeddbSearchIndex } from "@/indexeddb/search-index/mod.ts";
import { createProjectingCommit } from "@/indexeddb/search-index/idb-projecting-commit.ts";
import { PatchTransaction } from "@/indexeddb/rdfjs-store/patch-transaction.ts";

/**
 * IndexeddbWorldsSdkOptions configures createIndexeddbWorldsSdk.
 *
 * The exact surface follows the org convention (`createSqliteSdk` precedent,
 * backends aligning on the `*WorldsSdk` suffix): the store's options plus an
 * optional pre-wired SPARQL engine, text splitter, and embedding service.
 */
export interface IndexeddbWorldsSdkOptions {
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
   * searchIndexOnImport controls when chunks are written. It needs a
   * textSplitter. "incremental" (the default, as in every worlds backend)
   * projects chunks in every commit (SDK imports and SPARQL updates),
   * "deferred" does so except for imports, which rebuild once afterwards, and
   * "disabled" never touches chunks on commit: only `reindex()` writes them.
   * Quads and chunks are written in one IndexedDB transaction.
   */
  searchIndexOnImport?: SearchIndexOnImport;

  /**
   * include limits ingested and projected facts to matching subjects,
   * predicates and graphs, as `createSqliteWorldsSdk` does: a commit stores and
   * indexes only matching quads, and `reindex()` scopes to them by default.
   */
  include?: QuadCriteria;

  /** exclude rejects facts matching any declared subject, predicate or graph. */
  exclude?: QuadCriteria;

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
 * createIndexeddbWorldsSdk assembles a Worlds SDK facade over an IndexedDB-backed
 * quad store. When a `textSplitter` is provided, the SDK uses
 * `IndexeddbSearchIndex` for JS-side hybrid search (TF-IDF keyword scoring
 * + cosine vector similarity, fused with RRF k=60). When no textSplitter is
 * provided, the scan-based `RdfjsSearchIndex` is used as a fallback.
 */
export async function createIndexeddbWorldsSdk(
  options: IndexeddbWorldsSdkOptions,
): Promise<WorldsSdkInterface> {
  const store = new IndexeddbStore({
    dbName: options.dbName,
    storeName: options.storeName,
    chunkStoreName: options.chunkStoreName,
  });

  // Open the quad store database first.
  await store.openDb();

  // Determine the search index: hybrid (if textSplitter provided) or scan-based.
  // The chunk store shares the quad store's database (same schema version), and
  // every commit goes through it, so deleting a quad drops its chunk rows in
  // the same transaction whether or not indexing is on (as the SQL backends do).
  const chunkStore = new IdbChunkStore({
    dbName: options.dbName,
    chunkStoreName: options.chunkStoreName,
    storeName: options.storeName,
  });
  await chunkStore.openDb();

  let searchIndex;
  let index: IndexeddbSearchIndex | undefined;
  if (options.textSplitter) {
    searchIndex = new IndexeddbSearchIndex({
      chunkStore,
      textSplitter: options.textSplitter,
      embeddingService: options.embeddingService,
      vectorDimensions: options.vectorDimensions ?? DEFAULT_VECTOR_DIMENSIONS,
      searchIndexOnImport: options.searchIndexOnImport,
      quadsStore: store,
      include: options.include,
      exclude: options.exclude,
    });
    index = searchIndex;
  } else {
    // Fallback: scan-based search (no chunking, no hybrid).
    const { RdfjsSearchIndex } = await import("@worlds/sdk/rdfjs");
    searchIndex = new RdfjsSearchIndex(store);
  }

  const commit = createProjectingCommit({
    store,
    chunkStore,
    projector: options.textSplitter && {
      chunkStore,
      textSplitter: options.textSplitter,
      embeddingService: options.embeddingService,
    },
    searchIndexOnImport: options.searchIndexOnImport,
    include: options.include,
    exclude: options.exclude,
    reindex: () => index!.reindex(),
  });

  return new WorldsSdk({
    quadStore: new RdfjsQuadStore({ store, commit }),
    sparqlEngine:
      options.queryEngine ??
      new WazooSparqlEngine({
        store,
        createTransaction: () => new PatchTransaction(commit),
      }),
    searchIndex,
  });
}
