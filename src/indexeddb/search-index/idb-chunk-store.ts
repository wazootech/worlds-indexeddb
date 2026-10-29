/**
 * IdbChunkStore manages a separate IndexedDB object store for search chunks.
 *
 * Each chunk holds the text extracted from an RDF literal, its originating
 * quad metadata (subject, predicate, graph), and an optional vector embedding.
 * The store is opened alongside the quad store's database so all Writes are
 * coordinated through the same IndexedDB version lifecycle.
 */

import type {
  IdbChunkStoreOptions,
  SearchChunkRecord,
} from "./idb-chunk-types.ts";
import { openChunkDatabase, txDone } from "./idb-chunk-open.ts";

export type { IdbChunkStoreOptions, SearchChunkRecord };

/**
 * IdbChunkStore is a lightweight IndexedDB-backed store for search chunks.
 * It supports bulk insert, delete-by-quad-id, and full scan for search.
 */
export class IdbChunkStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  public constructor(private readonly options: IdbChunkStoreOptions) {}

  /** chunkStoreName is the resolved object store name. */
  public get chunkStoreName(): string {
    return this.options.chunkStoreName ?? "search_chunks";
  }

  /**
   * openDb opens (or upgrades) the IndexedDB database, creating the chunks
   * object store on version upgrade. The version is bumped to 2 to add the
   * new store alongside the existing quad store (version 1).
   */
  public openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = openChunkDatabase(
      this.options.dbName,
      this.chunkStoreName,
    );
    return this.dbPromise;
  }

  /**
   * insertChunks writes one or more chunk records into the store in a single
   * readwrite transaction.
   */
  public async insertChunks(chunks: SearchChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction(this.chunkStoreName, "readwrite");
    const store = tx.objectStore(this.chunkStoreName);
    for (const chunk of chunks) {
      store.put(chunk);
    }
    await txDone(tx);
  }

  /**
   * deleteByQuadIds removes all chunks whose quad_id matches any of the given
   * ids. Returns the number of deleted records.
   */
  public async deleteByQuadIds(quadIds: string[]): Promise<number> {
    if (quadIds.length === 0) return 0;
    const db = await this.openDb();
    const quadIdSet = new Set(quadIds);
    let deletedCount = 0;

    const tx = db.transaction(this.chunkStoreName, "readwrite");
    const store = tx.objectStore(this.chunkStoreName);
    const index = store.index("quad_id");

    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (quadIdSet.has(String(cursor.value.quad_id))) {
          cursor.delete();
          deletedCount++;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await txDone(tx);
    return deletedCount;
  }

  /**
   * getAllChunks returns all chunk records from the store. Used for full-text
   * keyword scoring and vector similarity search in JS.
   */
  public async getAllChunks(): Promise<SearchChunkRecord[]> {
    const db = await this.openDb();
    const tx = db.transaction(this.chunkStoreName, "readonly");
    const store = tx.objectStore(this.chunkStoreName);

    return new Promise<SearchChunkRecord[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as SearchChunkRecord[]);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * getChunksByQuadIds returns all chunk records whose quad_id is in the given
   * set. Used for targeted reindex operations.
   */
  public async getChunksByQuadIds(
    quadIds: string[],
  ): Promise<SearchChunkRecord[]> {
    if (quadIds.length === 0) return [];
    const db = await this.openDb();
    const quadIdSet = new Set(quadIds);
    const results: SearchChunkRecord[] = [];

    const tx = db.transaction(this.chunkStoreName, "readonly");
    const store = tx.objectStore(this.chunkStoreName);
    const index = store.index("quad_id");

    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (quadIdSet.has(String(cursor.value.quad_id))) {
          results.push(cursor.value as SearchChunkRecord);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    return results;
  }

  /**
   * countChunks returns the total number of chunks in the store.
   */
  public async countChunks(): Promise<number> {
    const db = await this.openDb();
    const tx = db.transaction(this.chunkStoreName, "readonly");
    const store = tx.objectStore(this.chunkStoreName);

    return new Promise<number>((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * clear removes all chunk records from the store.
   */
  public async clear(): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(this.chunkStoreName, "readwrite");
    const store = tx.objectStore(this.chunkStoreName);
    store.clear();
    await txDone(tx);
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
