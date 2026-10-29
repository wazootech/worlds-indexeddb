/** CHUNK_STORE_VERSION must be >= the quad store version (1) to trigger onupgradeneeded when the chunk store is added. */
const CHUNK_STORE_VERSION = 2;

/** QUADS_STORE_NAME is the name of the quad store used by IndexeddbStore. */
const QUADS_STORE_NAME = "quads";

/** QUADS_INDEX_NAMES are the positional indexes created by IndexeddbStore. */
const QUADS_INDEX_NAMES = ["skey", "pkey", "okey", "gkey"] as const;

/** txDone resolves when an IndexedDB transaction settles. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IDB transaction failed"));
  });
}

/**
 * openChunkDatabase opens (or upgrades) the IndexedDB database, creating the
 * chunks object store on version upgrade.
 */
export function openChunkDatabase(
  dbName: string,
  chunkStoreName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(
        new Error(
          "IndexedDB is not available in this environment. " +
            "In Deno tests, import 'npm:fake-indexeddb/auto' first.",
        ),
      );
      return;
    }
    const request = factory.open(dbName, CHUNK_STORE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Create the quads store if it doesn't exist yet (handles the case
      // where the chunk store opens before IndexeddbStore).
      if (!db.objectStoreNames.contains(QUADS_STORE_NAME)) {
        const quadStore = db.createObjectStore(QUADS_STORE_NAME, {
          keyPath: "key",
        });
        for (const indexName of QUADS_INDEX_NAMES) {
          quadStore.createIndex(indexName, indexName);
        }
      }
      // Create the chunks store for search.
      if (!db.objectStoreNames.contains(chunkStoreName)) {
        const chunkStore = db.createObjectStore(chunkStoreName, {
          keyPath: "id",
          autoIncrement: true,
        });
        chunkStore.createIndex("quad_id", "quad_id");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error(`Failed to open IndexedDB ${dbName}`),
      );
  });
}
