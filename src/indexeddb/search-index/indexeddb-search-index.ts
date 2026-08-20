/**
 * IndexeddbSearchIndex implements SearchIndexInterface over IndexedDB using
 * JS-side hybrid search: TF-IDF keyword scoring + cosine vector similarity,
 * fused with Reciprocal Rank Fusion (k=60, matching the libsql reference).
 *
 * Since IndexedDB has no built-in FTS or vector search, all scoring runs in
 * JS over the chunk store. This is the "phase 2" build for worlds-indexeddb:
 * the first backend where the entire search pipeline is pure JS.
 */

import type {
  ReindexRequest,
  ReindexResponse,
  SearchIndexInterface,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "@worlds/sdk/search-index";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { filterQuads, isTextualLiteral } from "@worlds/sdk/quad-store";
import { hashQuads } from "@worlds/sdk/quad-store";
import type * as rdfjs from "@rdfjs/types";
import { buildSearchResultId } from "./build-search-result-id.ts";
import type { IdbChunkStore } from "./idb-chunk-store.ts";
import {
  fuseWithRrf,
  searchKeyword,
  searchVector,
} from "./js-search-engine.ts";
import { projectChunks } from "./idb-search-index-projector.ts";

/** SearchRequestWithProfile extends SearchRequest with memory profile overrides. */
interface SearchRequestWithProfile extends SearchRequest {
  topK?: number;
  minScore?: number;
}

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

/**
 * IndexeddbSearchIndex implements hybrid keyword + vector search entirely
 * in JS over IndexedDB. It stores search chunks in a separate IDB object
 * store, scores them with TF-IDF (keyword) and cosine similarity (vector),
 * and fuses the results with Reciprocal Rank Fusion.
 */
export class IndexeddbSearchIndex implements SearchIndexInterface {
  public constructor(
    private readonly options: IndexeddbSearchIndexOptions,
  ) {}

  /**
   * search executes a hybrid keyword + vector query against the IDB chunk
   * store. The pipeline:
   * 1. Embed the query (graceful fallback to keyword-only on failure)
   * 2. Load all chunks from IDB
   * 3. Run keyword scoring (TF-IDF) and/or vector scoring (cosine)
   * 4. Fuse with RRF if both branches produced results
   */
  public async search(request: SearchRequest): Promise<SearchResponse> {
    const profileRequest = request as SearchRequestWithProfile;
    const searchLimit = profileRequest.topK ?? this.options.limit ?? 100;
    const minScore = profileRequest.minScore ?? 0;

    // 1. Embed the query (optional)
    let queryVector: number[] | undefined;
    if (this.options.embeddingService) {
      try {
        const [vector] = await this.options.embeddingService.embed([
          request.query,
        ]);
        queryVector = Array.from(vector);
      } catch (error) {
        console.warn(
          `[Search Warning] Embedding service failure. ` +
            `Degrading to keyword-only search fallback. Reason: ${
              (error as Error).message
            }`,
        );
      }
    }

    // 2. Load all chunks from IDB
    const allChunks = await this.options.chunkStore.getAllChunks();

    // 3. Determine search mode and execute
    const hasQuery = request.query && request.query.trim().length > 0;
    const hasVector = queryVector && queryVector.length > 0;

    const filter = {
      subjects: request.include?.subjects,
      predicates: request.include?.predicates,
      graphs: request.include?.graphs,
    };

    const keywordResults = hasQuery
      ? searchKeyword(request.query, allChunks, searchLimit, filter)
      : [];
    const vectorResults = hasVector
      ? searchVector(queryVector!, allChunks, searchLimit, filter)
      : [];

    // 4. Fuse with RRF if both branches produced results
    let fusedResults;
    if (keywordResults.length > 0 && vectorResults.length > 0) {
      fusedResults = fuseWithRrf(keywordResults, vectorResults, searchLimit);
    } else if (keywordResults.length > 0) {
      fusedResults = keywordResults;
    } else if (vectorResults.length > 0) {
      fusedResults = vectorResults;
    } else {
      return { results: [] };
    }

    // 5. Build SearchResult array with stable IDs
    const results: SearchResult[] = [];
    for (const row of fusedResults) {
      const score = row.keywordScore ?? 0;
      if (score < minScore) continue;

      const searchResultBase = {
        subject: row.subject,
        predicate: row.predicate,
        graph: row.graph,
        text: row.value,
      };
      results.push({
        id: await buildSearchResultId(searchResultBase),
        ...searchResultBase,
        score,
      });
    }

    return { results };
  }

  /**
   * reindex rebuilds search chunks from durable quads. This is idempotent —
   * running it multiple times produces the same result.
   */
  public async reindex(
    request?: ReindexRequest,
  ): Promise<ReindexResponse> {
    const quadsStore = this.options.quadsStore;
    if (!quadsStore) {
      throw new Error(
        "IndexeddbSearchIndex reindex requires quadsStore in options",
      );
    }

    const include = request?.include ?? this.options.include;
    const exclude = request?.exclude ?? this.options.exclude;
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
    await this.options.chunkStore.clear();

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
          chunkStore: this.options.chunkStore,
          textSplitter: this.options.textSplitter,
          embeddingService: this.options.embeddingService,
          vectorDimensions: this.options.vectorDimensions,
        });
      }
    }

    const chunkRowCount = await this.options.chunkStore.countChunks();

    return {
      processedQuadCount: allQuads.length,
      chunkRowCount,
    };
  }
}
