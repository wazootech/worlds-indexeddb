/**
 * IdbChunkStore manages a separate IndexedDB object store for search chunks.
 *
 * Each chunk holds the text extracted from an RDF literal, its originating
 * quad metadata (subject, predicate, graph), and an optional vector embedding.
 * The store is opened alongside the quad store's database so all Writes are
 * coordinated through the same IndexedDB version lifecycle.
 */

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
}

/** CHUNK_STORE_VERSION must be >= the quad store version (1) to trigger onupgradeneeded when the chunk store is added. */
const CHUNK_STORE_VERSION = 2;

/** QUADS_STORE_NAME is the name of the quad store used by IndexedDbStore. */
const QUADS_STORE_NAME = "quads";

/** QUADS_INDEX_NAMES are the positional indexes created by IndexedDbStore. */
const QUADS_INDEX_NAMES = ["skey", "pkey", "okey", "gkey"] as const;

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
   * openDb opens (or upgrades) the IndexedDB database, creating the chunks
   * object store on version upgrade. The version is bumped to 2 to add the
   * new store alongside the existing quad store (version 1).
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
      const request = factory.open(this.options.dbName, CHUNK_STORE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Create the quads store if it doesn't exist yet (handles the case
        // where the chunk store opens before IndexedDbStore).
        if (!db.objectStoreNames.contains(QUADS_STORE_NAME)) {
          const quadStore = db.createObjectStore(QUADS_STORE_NAME, {
            keyPath: "key",
          });
          for (const indexName of QUADS_INDEX_NAMES) {
            quadStore.createIndex(indexName, indexName);
          }
        }
        // Create the chunks store for search.
        if (!db.objectStoreNames.contains(this.chunkStoreName)) {
          const chunkStore = db.createObjectStore(this.chunkStoreName, {
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
