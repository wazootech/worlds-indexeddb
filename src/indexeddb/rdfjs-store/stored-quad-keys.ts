import type { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";

/**
 * findStoredQuadKeys returns which of `keys` (the composite keys from
 * `quadKey`) the quad store holds. It waits for queued writes first, then
 * reads every key in one readonly transaction.
 */
export async function findStoredQuadKeys(
  store: IndexeddbStore,
  keys: string[],
): Promise<Set<string>> {
  await store.flush();
  const db = await store.openDb();
  const objectStore = db.transaction(store.storeName).objectStore(
    store.storeName,
  );
  const found = new Set<string>();
  await Promise.all(
    [...new Set(keys)].map((key) =>
      new Promise<void>((resolve, reject) => {
        const request = objectStore.getKey(key);
        request.onsuccess = () => {
          if (request.result !== undefined) found.add(key);
          resolve();
        };
        request.onerror = () => reject(request.error);
      })
    ),
  );
  return found;
}
