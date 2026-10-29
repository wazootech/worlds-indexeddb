import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import type * as rdfjs from "@rdfjs/types";
import type { IdbChunkStore } from "./idb-chunk-store.ts";

/** IndexeddbSearchIndexOptions configures the IndexedDB search engine. */
export interface IndexeddbSearchIndexOptions {
  /** chunkStore is the IDB-backed chunk store. */
  chunkStore: IdbChunkStore;

  /** textSplitter splits long literal values into chunk rows. */
  textSplitter: TextSplitterInterface;

  /** embeddingService optionally projects chunk text into comparison vectors. */
  embeddingService?: EmbeddingService;

  /**
   * vectorDimensions pins the expected embedding dimensionality.
   * Required when embeddingService is set (default 1536).
   */
  vectorDimensions?: number;

  /** limit establishes the default search result cap (default 100). */
  limit?: number;

  /** include restricts search to quads matching these subject/predicate/graph values. */
  include?: { subjects?: string[]; predicates?: string[]; graphs?: string[] };

  /** exclude removes quads matching these subject/predicate/graph values from search. */
  exclude?: { subjects?: string[]; predicates?: string[]; graphs?: string[] };

  /** searchIndexOnImport controls when chunk projection runs during import. */
  searchIndexOnImport?: "incremental" | "deferred" | "disabled";

  /**
   * quadsStore is the RDF/JS store used to scan quads during reindex.
   * Required for the reindex pathway.
   */
  quadsStore?: rdfjs.Store & { size: number };
}
