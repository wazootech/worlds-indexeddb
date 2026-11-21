import type { SearchChunkRecord } from "@/indexeddb/search-index/idb-chunk-store.ts";

/**
 * ChunkWrite is the chunk-row side of one commit. IndexeddbStore applies it in
 * the same IndexedDB transaction as the quads, so the two commit or abort together.
 */
export interface ChunkWrite {
  /** chunkStoreName is the object store holding the chunk rows. */
  chunkStoreName: string;

  /** clear drops every chunk first (a replace import wipes the graph). */
  clear?: boolean;

  /** deleteQuadIds drops the chunks of these quads before the new rows are written. */
  deleteQuadIds: string[];

  /** records are the new chunk rows. */
  records: SearchChunkRecord[];
}

/**
 * writeChunks queues a ChunkWrite on `tx`, which must cover `chunkStoreName`.
 * New rows are put only after every delete lookup has finished, so a cursor can
 * never drop a row this commit just wrote. An exception thrown from a request
 * callback aborts the transaction, which also rolls back the quads.
 */
export function writeChunks(tx: IDBTransaction, write: ChunkWrite): void {
  const store = tx.objectStore(write.chunkStoreName);
  const put = () => {
    for (const record of write.records) store.put(record);
  };
  if (write.clear) {
    store.clear();
    return put();
  }
  const ids = [...new Set(write.deleteQuadIds)];
  let pending = ids.length;
  if (pending === 0) return put();
  const index = store.index("quad_id");
  for (const id of ids) {
    const request = index.getAllKeys(IDBKeyRange.only(id));
    request.onsuccess = () => {
      for (const key of request.result) store.delete(key);
      if (--pending === 0) put();
    };
  }
}
