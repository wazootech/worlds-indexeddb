/**
 * IdbChunkStore manages a separate IndexedDB object store for search chunks.
 *
 * Each chunk holds the text extracted from an RDF literal, its originating
 * quad metadata (subject, predicate, graph), and an optional vector embedding.
 * The store is opened alongside the quad store's database so all Writes are
 * coordinated through the same IndexedDB version lifecycle.
 */
import { DB_VERSION, upgradeSchema } from "@/indexeddb/schema.ts";
import { writeChunks } from "@/indexeddb/rdfjs-store/chunk-write.ts";

/** SearchChunkRecord is one persisted search chunk in IndexedDB. */
export interface SearchChunkRecord {
  /** id is the auto-incrementing primary key. */
  id?: number;
  /** quad_id is the content-addressed hash of the originating quad. */
  quad_id: string;
  /** subject is the subject IRI of the originating quad. */
  subject: string;
  /** predicate is the predicate IRI of the originating quad. */
  predicate: string;
  /** graph is the graph IRI of the originating quad. */
  graph: string;
  /** value is the chunk's text content (object literal value or split portion). */
  value: string;
  /** fts_value is the lowercased, tokenized text for keyword scoring. */
  fts_value: string;
  /** vector is the optional Float32Array embedding stored as a plain number array. */
  vector?: number[];
}

/** IdbChunkStoreOptions configures the chunk store. */
export interface IdbChunkStoreOptions {
  /** dbName is the IndexedDB database name (shared with the quad store). */
  dbName: string;
  /** chunkStoreName is the object store name for chunks (defaults to "search_chunks"). */
  chunkStoreName?: string;
  /** storeName is the quad object store, created on upgrade if missing (defaults to "quads"). */
  storeName?: string;
}

/** txDone resolves when an IndexedDB transaction settles. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IDB transaction failed"));
  });
}

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
   * openDb opens (or upgrades) the IndexedDB database at DB_VERSION, creating any
   * missing object store through the schema shared with IndexeddbStore.
   */
  public openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
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
      const request = factory.open(this.options.dbName, DB_VERSION);
      request.onupgradeneeded = () =>
        upgradeSchema(request.result, {
          quadStoreName: this.options.storeName ?? "quads",
          chunkStoreName: this.chunkStoreName,
        });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          request.error ??
            new Error(`Failed to open IndexedDB ${this.options.dbName}`),
        );
    });
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

  /** replaceAll clears the store and writes `chunks` in one readwrite transaction. */
  public async replaceAll(chunks: SearchChunkRecord[]): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(this.chunkStoreName, "readwrite");
    const store = tx.objectStore(this.chunkStoreName);
    store.clear();
    for (const chunk of chunks) store.put(chunk);
    await txDone(tx);
  }

  /**
   * replaceForQuads is the scoped replace: in one readwrite transaction it drops
   * every chunk row of the quads in `quadIds`, then writes `chunks`. Rows of any
   * other quad are left alone, so nothing is cleared. Embed `chunks` before
   * calling, since a transaction cannot wait on a non-IndexedDB promise.
   */
  public async replaceForQuads(
    quadIds: string[],
    chunks: SearchChunkRecord[],
  ): Promise<void> {
    if (quadIds.length === 0 && chunks.length === 0) return;
    const db = await this.openDb();
    const tx = db.transaction(this.chunkStoreName, "readwrite");
    const done = txDone(tx);
    writeChunks(tx, {
      chunkStoreName: this.chunkStoreName,
      deleteQuadIds: quadIds,
      records: chunks,
    });
    await done;
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
