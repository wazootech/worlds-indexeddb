import type {
  Patch,
  QuadFilter,
  TransactionContext,
} from "@worlds/sdk/quad-store";
import { preparePatch, selectNovelQuads } from "@worlds/sdk/quad-store";
import type { SearchIndexOnImport } from "@worlds/sdk/search-index";
import { planSearchIndexing } from "@worlds/sdk/search-index";
import type { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";
import { quadKey } from "@/indexeddb/rdfjs-store/quad-record.ts";
import { findStoredQuadKeys } from "@/indexeddb/rdfjs-store/stored-quad-keys.ts";
import type { IdbChunkStore } from "./idb-chunk-store.ts";
import {
  buildChunkRecords,
  type ProjectorOptions,
} from "./idb-search-index-projector.ts";

/** ProjectingCommitOptions wires the quad store, the chunk store, and the indexing mode. */
export interface ProjectingCommitOptions extends QuadFilter {
  /** store is the quad store every commit writes to. */
  store: IndexeddbStore;

  /** chunkStore holds the search chunks kept in step with the quads. Same database as `store`. */
  chunkStore: IdbChunkStore;

  /**
   * projector chunks and embeds the novel quads of a commit. Without it (no
   * text splitter) a commit writes no chunks and never reindexes, but still
   * applies the filter and drops the chunks of deleted quads.
   */
  projector?: ProjectorOptions;

  /**
   * searchIndexOnImport is the indexing mode. Defaults to "incremental", the
   * default of every worlds backend; "disabled" writes no chunks on commit (only
   * a reindex does) but still drops the chunks of deleted quads.
   */
  searchIndexOnImport?: SearchIndexOnImport;

  /** reindex rebuilds every chunk from the stored quads (a deferred import runs it once). */
  reindex?: () => Promise<unknown>;
}

/**
 * createProjectingCommit returns the commit function for the IndexedDB quad
 * store. In "incremental" and "deferred" mode it keeps chunks in step with
 * quads using the shared policy (`planSearchIndexing`) and novel-quad rule
 * (`preparePatch`, `selectNovelQuads`):
 *
 * 0. apply the include/exclude filter to both sides of the patch, as the SQL
 *    core does (`preparePatch(patch, filter)`): a quad outside the filter is
 *    neither stored nor projected, so a commit and a reindex agree;
 * 1. chunk and embed the novel quads (an embedding failure throws here, by
 *    default, before anything is written);
 * 2. write the quads, the deleted quads' chunks (all chunks on a replace
 *    import), and the new chunk rows in ONE IndexedDB readwrite transaction;
 * 3. a deferred import reindexes once afterwards instead of projecting.
 *
 * Embedding is step 1 because a transaction auto-commits across an await of a
 * non-IndexedDB promise, so it cannot wait on the embedding service. The commit
 * is atomic: a failed write leaves the prior quads and chunks. In "disabled"
 * mode (or with no projector) no chunk is written, but the same transaction
 * still drops the chunks of deleted quads and of a replace wipe, as the SQL
 * backends do, so no row is orphaned.
 */
export function createProjectingCommit(
  options: ProjectingCommitOptions,
): (patch: Patch, context?: TransactionContext) => Promise<void> {
  const { store, chunkStore, projector } = options;
  return async (patch, context) => {
    const plan = planSearchIndexing(options.searchIndexOnImport, context);
    const replacing = context?.importMode === "replace";
    const prepared = preparePatch(patch, {
      include: options.include,
      exclude: options.exclude,
    });
    const novel = plan.projectDuringCommit && projector
      ? await selectNovelQuads(prepared, {
        keyOf: (quad) => quadKey(quad),
        lookupExisting: (keys) => findStoredQuadKeys(store, keys),
        replacing,
      })
      : { novelInsertions: [], novelQuadIds: [] };
    const records = projector
      ? await buildChunkRecords(
        novel.novelInsertions,
        novel.novelQuadIds,
        projector,
      )
      : [];

    const filtered: Patch = {
      ...patch,
      insertions: prepared.insertions,
      deletions: prepared.deletions,
    };
    await store.applyPatch(filtered, context, {
      chunkStoreName: chunkStore.chunkStoreName,
      clear: replacing,
      deleteQuadIds: [...prepared.deletionIds, ...novel.novelQuadIds],
      records,
    });
    if (plan.reindexAfterCommit && projector) await options.reindex?.();
  };
}
