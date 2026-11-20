import type { Patch, TransactionContext } from "@worlds/sdk/quad-store";
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
export interface ProjectingCommitOptions {
  /** store is the quad store every commit writes to. */
  store: IndexeddbStore;

  /** chunkStore holds the search chunks kept in step with the quads. */
  chunkStore: IdbChunkStore;

  /** projector chunks and embeds the novel quads of a commit. */
  projector: ProjectorOptions;

  /**
   * searchIndexOnImport is the indexing mode. IndexedDB defaults to "disabled":
   * a commit never touches chunks and only a reindex writes them.
   */
  searchIndexOnImport?: SearchIndexOnImport;

  /** reindex rebuilds every chunk from the stored quads (a deferred import runs it once). */
  reindex: () => Promise<unknown>;
}

/**
 * createProjectingCommit returns the commit function for the IndexedDB quad
 * store. In "incremental" and "deferred" mode it keeps chunks in step with
 * quads using the shared policy (`planSearchIndexing`) and novel-quad rule
 * (`preparePatch`, `selectNovelQuads`):
 *
 * 1. chunk and embed the novel quads (nothing is written if this throws);
 * 2. write the patch to the quad store (one IndexedDB readwrite transaction);
 * 3. drop the chunks of deleted quads (all chunks on a replace import) and
 *    write the new chunk rows (a deferred import reindexes instead).
 *
 * Quads and chunks live in separate IndexedDB transactions, so a failure in
 * step 3 leaves the quads stored without chunks, never chunks without quads; a
 * reindex repairs it. In "disabled" mode (the default) it is a plain
 * `store.applyPatch`, byte for byte what the commit did before.
 */
export function createProjectingCommit(
  options: ProjectingCommitOptions,
): (patch: Patch, context?: TransactionContext) => Promise<void> {
  const { store, chunkStore, projector } = options;
  return async (patch, context) => {
    const plan = planSearchIndexing(options.searchIndexOnImport, context, {
      defaultMode: "disabled",
    });
    if (!plan.projectDuringCommit && !plan.reindexAfterCommit) {
      return await store.applyPatch(patch, context);
    }

    const replacing = context?.importMode === "replace";
    const prepared = preparePatch(patch);
    const novel = plan.projectDuringCommit
      ? await selectNovelQuads(prepared, {
        keyOf: (quad) => quadKey(quad),
        lookupExisting: (keys) => findStoredQuadKeys(store, keys),
        replacing,
      })
      : { novelInsertions: [], novelQuadIds: [] };
    const records = await buildChunkRecords(
      novel.novelInsertions,
      novel.novelQuadIds,
      projector,
    );

    await store.applyPatch(patch, context);

    if (replacing) {
      await chunkStore.clear();
    } else {
      await chunkStore.deleteByQuadIds([
        ...prepared.deletionIds,
        ...novel.novelQuadIds,
      ]);
    }
    await chunkStore.insertChunks(records);
    if (plan.reindexAfterCommit) await options.reindex();
  };
}
