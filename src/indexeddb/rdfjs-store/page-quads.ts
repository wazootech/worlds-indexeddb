import type * as rdfjs from "@rdfjs/types";
import type { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";
import {
  fromQuadRow,
  type QuadRow,
} from "@/indexeddb/rdfjs-store/quad-record.ts";

/** QuadPage is one keyset page of stored quads and the cursor of the next one. */
export interface QuadPage {
  /** quads are up to `pageSize` stored quads, in primary-key order. */
  quads: rdfjs.Quad[];

  /** next is the key to pass as `after` for the next page; `undefined` on the last page. */
  next?: string;
}

/**
 * pageStoredQuads reads up to `pageSize` quads whose composite primary key sorts
 * after `after` (all of them from the start when omitted), in key order. It is
 * keyset paging over the quad store's primary key: each page is its own short
 * readonly transaction that opens an `IDBKeyRange.lowerBound(after, true)`
 * cursor and stops after the page, so no more than one page is ever in memory
 * and a page costs the same however deep it is (an offset would rescan). `next`
 * is set only when a further quad exists, so the last page ends the walk.
 */
export async function pageStoredQuads(
  store: IndexeddbStore,
  request: { after?: string; pageSize: number },
): Promise<QuadPage> {
  const pageSize = Math.max(1, request.pageSize);
  const db = await store.openDb();
  const objectStore = db
    .transaction(store.storeName)
    .objectStore(store.storeName);
  const range =
    request.after === undefined
      ? undefined
      : IDBKeyRange.lowerBound(request.after, true);
  return await new Promise<QuadPage>((resolve, reject) => {
    const quads: rdfjs.Quad[] = [];
    let lastKey: string | undefined;
    const cursorRequest = objectStore.openCursor(range);
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return resolve({ quads });
      if (quads.length === pageSize) {
        return resolve({ quads, next: lastKey });
      }
      quads.push(fromQuadRow(cursor.value as QuadRow));
      lastKey = cursor.key as string;
      cursor.continue();
    };
  });
}
