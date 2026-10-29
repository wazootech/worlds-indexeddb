const INDEX_NAMES = ["skey", "pkey", "okey", "gkey"] as const;

/**
 * openIndexeddb opens (creating on first use) the IndexedDB database and
 * reports the seeded record count through onCount.
 */
export function openIndexeddb(
  dbName: string,
  storeName: string,
  onCount: (count: number) => void,
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
    const request = factory.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        const store = db.createObjectStore(storeName, {
          keyPath: "key",
        });
        for (const indexName of INDEX_NAMES) {
          store.createIndex(indexName, indexName);
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Seed the live count once the connection is established.
      const countRequest = db.transaction(storeName).objectStore(
        storeName,
      ).count();
      countRequest.onsuccess = () => {
        onCount(countRequest.result);
      };
      resolve(db);
    };
    request.onerror = () => {
      reject(
        request.error ??
          new Error(`Failed to open IndexedDB ${dbName}`),
      );
    };
  });
}
