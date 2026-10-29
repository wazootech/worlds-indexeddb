import { openIndexeddb } from "@/indexeddb/rdfjs-store/indexeddb-open.ts";
import { countRecords } from "@/indexeddb/rdfjs-store/indexeddb-match.ts";
import type { IndexeddbStoreOptions } from "@/indexeddb/rdfjs-store/indexeddb-transaction.ts";
import { txDone } from "@/indexeddb/rdfjs-store/indexeddb-tx.ts";

/**
 * IndexeddbStoreBase owns the connection lifecycle and the serialized write
 * queue shared by IndexeddbStore.
 */
export abstract class IndexeddbStoreBase {
  /** serialized write queue: every mutation runs after the previous one. */
  protected mutationQueue: Promise<void> = Promise.resolve();
  /** lazily opened database connection. */
  protected dbPromise: Promise<IDBDatabase> | null = null;
  /** synchronous size approximation, refreshed after every write. */
  protected liveCount = 0;

  public constructor(public readonly options: IndexeddbStoreOptions) {}

  /** storeName is the resolved object store name. */
  public get storeName(): string {
    return this.options.storeName ?? "quads";
  }

  /** openDb opens (creating on first use) the IndexedDB database. */
  public openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = openIndexeddb(
      this.options.dbName,
      this.storeName,
      (count) => {
        this.liveCount = count;
      },
    );
    return this.dbPromise;
  }

  /** flush resolves once every queued write has committed. */
  public flush(): Promise<void> {
    return this.mutationQueue;
  }

  /**
   * enqueueWrite serializes a write transaction behind all prior writes and
   * refreshes the live count on completion.
   */
  protected enqueueWrite(
    work: (tx: IDBTransaction, store: IDBObjectStore) => void,
  ): Promise<void> {
    const next = this.mutationQueue.then(async () => {
      const db = await this.openDb();
      const tx = db.transaction(this.storeName, "readwrite");
      work(tx, tx.objectStore(this.storeName));
      await txDone(tx);
      this.liveCount = await countRecords(db, this.storeName);
    });
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * size is the synchronous count approximation — refreshed after every
   * write transaction and on connection open. IndexedDB has no synchronous
   * count; consumers needing the exact count await countQuads() instead.
   */
  public get size(): number {
    return this.liveCount;
  }

  /** close releases the underlying database connection (if open). */
  public close(): void {
    if (this.dbPromise) {
      void this.dbPromise.then((db) => {
        db.close();
      });
      this.dbPromise = null;
    }
  }
}
