/**
 * IndexeddbStore — durable, zero-dependency RDF/JS Store over IndexedDB.
 *
 * The IndexedDB quad primitive for the Worlds ecosystem, packaged with the
 * worlds impl per the agreed pattern (`SqliteStore` in `@worlds/sqlite`,
 * `LibsqlRdfjsStore` in `@worlds/libsql`, `PostgresRdfjsStore` in
 * `@worlds/postgres`). The storage layout and match() access-path strategy
 * follow the decision recorded on sparql-engine#163 (map #162):
 *
 * - one object store (default name "quads") keyed by a composite quad key —
 *   the four position term keys joined by NUL (`quadKey`), exactly the shape
 *   of sqlite's composite primary key, so quads that differ only by graph
 *   never collide;
 * - per-position indexes on skey/pkey/okey/gkey (the hexastore positional
 *   mirror);
 * - match() selects the access path by index cardinality — count() each
 *   bound index, scan the smallest, filter the remaining positions with
 *   sameRdfTerm (System R access-path selection, the same idea the engine's
 *   probeQuadIndex uses);
 * - every write is atomic: commit() and applyPatch() run one IDB readwrite
 *   transaction, and a failed transaction (abort) leaves the dataset
 *   untouched.
 *
 * The engine remains store-agnostic and consumes this store through its
 * `createTransaction` hook:
 *
 *   const store = new IndexeddbStore({ dbName: "wazoo" });
 *   const engine = new WazooSparqlEngine({
 *     store,
 *     createTransaction: () => store.createTransaction(),
 *   });
 *
 * The SDK facade consumes it the same way (RdfjsQuadStore's commit handler
 * routes through applyPatch, one transaction per patch).
 *
 * IndexedDB is inherently asynchronous, so the read side diverges from
 * SqliteStore where the interface forces it: match() returns an async
 * cursor-backed stream (the engine and the SDK read async RDF/JS streams
 * already), and countQuads()/getQuads() return promises. `size` is a
 * synchronous approximation — the live count refreshed after every write
 * transaction — kept for the rdfjs.Store shape.
 */
import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import {
  fromQuadRow,
  quadKey,
  type QuadRow,
  toQuadRow,
} from "@/indexeddb/rdfjs-store/quad-record.ts";
import { IdbQuadStream } from "@/indexeddb/rdfjs-store/idb-stream.ts";
import { sameRdfTerm, termKey } from "@/indexeddb/term/term-key.ts";
import type { Patch } from "@worlds/sdk";

const INDEX_NAMES = ["skey", "pkey", "okey", "gkey"] as const;

/**
 * IndexeddbTransaction is the atomic patch contract a SPARQL update uses to
 * buffer writes. It is structurally identical to the engine's
 * `WazooSparqlTransaction` (and the worlds client's Transaction), so a store
 * producing it satisfies the engine's `createTransaction` hook with no
 * cross-package import.
 */
export interface IndexeddbTransaction {
  /** add buffers a single quad for insertion on the next commit. */
  add(quad: rdfjs.Quad): unknown;

  /** delete buffers a single quad for deletion on the next commit. */
  delete(quad: rdfjs.Quad): unknown;

  /** commit persists the buffered patch (one IndexedDB readwrite transaction). */
  commit(): Promise<void>;

  /** rollback discards any uncommitted insertions and deletions. */
  rollback(): void;
}

/** IndexeddbStoreOptions configures IndexeddbStore. */
export interface IndexeddbStoreOptions {
  /** IndexedDB database name. */
  dbName: string;

  /** Object store name for quads (defaults to "quads"). */
  storeName?: string;
}

/** IndexeddbTransactionImpl buffers a SPARQL update patch atomically. */
class IndexeddbTransactionImpl implements IndexeddbTransaction {
  /** quad key -> quad, for insert; a Map keeps the last insert of a key. */
  private readonly inserted = new Map<string, rdfjs.Quad>();
  /** quad key -> quad, buffered for deletion (net of any insert of the same key). */
  private readonly deleted = new Map<string, rdfjs.Quad>();

  public constructor(private readonly store: IndexeddbStore) {}

  public add(quad: rdfjs.Quad): void {
    this.deleted.delete(quadKey(quad));
    this.inserted.set(quadKey(quad), quad);
  }

  public delete(quad: rdfjs.Quad): void {
    if (this.inserted.delete(quadKey(quad))) {
      return; // add + delete of the same quad nets to nothing
    }
    // Deleting an absent quad is a no-op at commit (delete by key), so the
    // quad is retained here only for its key.
    this.deleted.set(quadKey(quad), quad);
  }

  public commit(): Promise<void> {
    return this.store.applyPatch({
      insertions: [...this.inserted.values()],
      deletions: [...this.deleted.values()],
    });
  }

  public rollback(): void {
    this.inserted.clear();
    this.deleted.clear();
  }
}

/**
 * txDone resolves when an IndexedDB transaction settles — resolves on
 * `complete`, rejects on `abort`/`error`.
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ?? new Error("IndexedDB transaction aborted"),
      );
    tx.onerror = () =>
      reject(
        tx.error ?? new Error("IndexedDB transaction failed"),
      );
  });
}

/**
 * IndexeddbStore is a durable RDF/JS Store over IndexedDB. It implements the
 * read side of rdfjs.Store plus addQuad/removeQuad, and offers
 * createTransaction() for atomic SPARQL updates and applyPatch() for atomic
 * bulk patches (the SDK's replace-import path).
 */
export class IndexeddbStore implements rdfjs.Store<rdfjs.Quad> {
  /** serialized write queue: every mutation runs after the previous one. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** lazily opened database connection. */
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** synchronous size approximation, refreshed after every write. */
  private liveCount = 0;

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
      const request = factory.open(this.options.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
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
        const countRequest = db.transaction(this.storeName).objectStore(
          this.storeName,
        ).count();
        countRequest.onsuccess = () => {
          this.liveCount = countRequest.result;
        };
        resolve(db);
      };
      request.onerror = () => {
        reject(
          request.error ??
            new Error(`Failed to open IndexedDB ${this.options.dbName}`),
        );
      };
    });
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
  private enqueueWrite(
    work: (tx: IDBTransaction, store: IDBObjectStore) => void,
  ): Promise<void> {
    const next = this.mutationQueue.then(async () => {
      const db = await this.openDb();
      const tx = db.transaction(this.storeName, "readwrite");
      work(tx, tx.objectStore(this.storeName));
      await txDone(tx);
      const countRequest = db.transaction(this.storeName).objectStore(
        this.storeName,
      ).count();
      await new Promise<void>((resolve, reject) => {
        countRequest.onsuccess = () => {
          this.liveCount = countRequest.result;
          resolve();
        };
        countRequest.onerror = () => reject(countRequest.error);
      });
    });
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * applyPatch persists a patch atomically — one readwrite transaction.
   * context.importMode === "replace" clears the store first (the SDK's
   * replace-import contract).
   */
  public applyPatch(
    patch: Patch,
    context?: { importMode?: "replace" | "merge" },
  ): Promise<void> {
    return this.enqueueWrite((_tx, store) => {
      if (context?.importMode === "replace") {
        store.clear();
      }
      for (const quad of patch.deletions) {
        store.delete(quadKey(quad));
      }
      for (const quad of patch.insertions) {
        store.put(toQuadRow(quad));
      }
    });
  }

  /** createTransaction returns a fresh transaction over this store. */
  public createTransaction(): IndexeddbTransaction {
    return new IndexeddbTransactionImpl(this);
  }

  public addQuad(quad: rdfjs.Quad): this;
  public addQuad(
    subject: rdfjs.Term,
    predicate: rdfjs.Term,
    object: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this;
  public addQuad(
    quadOrSubject: rdfjs.Quad | rdfjs.Term,
    predicate?: rdfjs.Term,
    object?: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this {
    const quad = predicate !== undefined && object !== undefined
      ? DataFactory.quad(
        // RDF 1.2 allows any term in any position (literal subjects in
        // quoted triples); the engine's position types are narrower, so cast.
        quadOrSubject as rdfjs.Quad_Subject,
        predicate as rdfjs.Quad_Predicate,
        object as rdfjs.Quad_Object,
        graph as rdfjs.Quad_Graph,
      )
      : quadOrSubject as rdfjs.Quad;
    // IndexedDB writes are asynchronous; the rdfjs.Store interface types
    // addQuad as synchronous, so the write is queued and the caller can
    // await it via flush() or a later read. The SDK and engine never use
    // this path (they route through applyPatch / createTransaction).
    void this.enqueueWrite((_tx, store) => {
      store.put(toQuadRow(quad));
    });
    return this;
  }

  public removeQuad(quad: rdfjs.Quad): this {
    void this.enqueueWrite((_tx, store) => {
      store.delete(quadKey(quad));
    });
    return this;
  }

  public remove(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (q: rdfjs.Quad) => this.removeQuad(q));
    return stream;
  }

  public import(stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    stream.on("data", (q: rdfjs.Quad) => this.addQuad(q));
    return stream;
  }

  /**
   * openMatchCursor opens the cursor for a match pattern on a fresh
   * transaction. Access-path selection follows the decision recorded on
   * sparql-engine#163 (map #162): each bound position index is counted, the
   * smallest is scanned, and unindexed positions are filtered by the caller.
   *
   * The cursor request is created synchronously inside the last count's
   * onsuccess — awaiting across a task boundary would let the transaction
   * auto-commit with no pending requests (TransactionInactiveError).
   */
  private openMatchCursor(
    db: IDBDatabase,
    bound: Array<{ index: string; key: string }>,
    readwrite: boolean,
  ): Promise<IDBRequest<IDBCursorWithValue | null>> {
    const tx = db.transaction(
      this.storeName,
      readwrite ? "readwrite" : "readonly",
    );
    const store = tx.objectStore(this.storeName);
    if (bound.length === 0) {
      return Promise.resolve(store.openCursor());
    }
    return new Promise<IDBRequest<IDBCursorWithValue | null>>(
      (resolve, reject) => {
        let remaining = bound.length;
        let best = -1;
        let bestCount = Infinity;
        for (let i = 0; i < bound.length; i++) {
          const { index, key } = bound[i]!;
          const request = store.index(index).count(IDBKeyRange.only(key));
          request.onsuccess = () => {
            if (request.result < bestCount) {
              bestCount = request.result;
              best = i;
            }
            if (--remaining === 0) {
              const chosen = bound[best]!;
              resolve(
                store.index(chosen.index).openCursor(
                  IDBKeyRange.only(chosen.key),
                ),
              );
            }
          };
          request.onerror = () => reject(request.error);
        }
      },
    );
  }

  /**
   * match returns an async cursor-backed stream of the matching quads. The
   * cursor access path is selected by index cardinality: each bound position
   * is counted, the smallest index is scanned, and the remaining positions
   * are filtered with sameRdfTerm.
   */
  public match(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): IdbQuadStream {
    const bound: Array<{ index: string; key: string; term: rdfjs.Term }> = [];
    const bind = (
      index: string,
      term: rdfjs.Term | null | undefined,
    ): void => {
      if (term != null) {
        bound.push({ index, key: termKey(term), term });
      }
    };
    bind("skey", subject);
    bind("pkey", predicate);
    bind("okey", object);
    bind("gkey", graph);

    const remaining = bound.map(({ index, term }) => ({ index, term }));
    const selection = bound.map(({ index, key }) => ({ index, key }));

    return new IdbQuadStream(async () => {
      const db = await this.openDb();
      return this.openMatchCursor(db, selection, false);
    }, {
      accept: (quad) =>
        remaining.every(({ index, term }) => {
          const actual = index === "skey"
            ? quad.subject
            : index === "pkey"
            ? quad.predicate
            : index === "okey"
            ? quad.object
            : quad.graph;
          return sameRdfTerm(actual, term);
        }),
      decode: (value) => fromQuadRow(value as QuadRow),
    });
  }

  /** getQuads collects the matching quads into an array. */
  public async getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]> {
    const stream = this.match(subject, predicate, object, graph);
    const quads: rdfjs.Quad[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (q: rdfjs.Quad) => quads.push(q));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return quads;
  }

  /** countQuads returns the number of quads matching the pattern. */
  public async countQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<number> {
    return (await this.getQuads(subject, predicate, object, graph)).length;
  }

  /**
   * removeMatches deletes every matching quad in one readwrite transaction
   * and streams the removed quads (the cursor deletes each record as it
   * advances).
   */
  public removeMatches(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): IdbQuadStream {
    const bound: Array<{ index: string; key: string; term: rdfjs.Term }> = [];
    const bind = (
      index: string,
      term: rdfjs.Term | null | undefined,
    ): void => {
      if (term != null) {
        bound.push({ index, key: termKey(term), term });
      }
    };
    bind("skey", subject);
    bind("pkey", predicate);
    bind("okey", object);
    bind("gkey", graph);
    const remaining = bound.map(({ index, term }) => ({ index, term }));
    const selection = bound.map(({ index, key }) => ({ index, key }));

    const stream = new IdbQuadStream(async () => {
      const db = await this.openDb();
      return this.openMatchCursor(db, selection, true);
    }, {
      accept: (quad) =>
        remaining.every(({ index, term }) => {
          const actual = index === "skey"
            ? quad.subject
            : index === "pkey"
            ? quad.predicate
            : index === "okey"
            ? quad.object
            : quad.graph;
          return sameRdfTerm(actual, term);
        }),
      onRecord: (cursor) => {
        cursor.delete();
      },
      decode: (value) => fromQuadRow(value as QuadRow),
    });
    // The live count refreshes once the deletion cursor completes.
    stream.on("end", () => {
      void this.enqueueWrite(() => {});
    });
    return stream;
  }

  /** deleteGraph removes every quad in the named graph. */
  public deleteGraph(
    graph: rdfjs.Quad_Graph | string,
  ): IdbQuadStream {
    const graphTerm = typeof graph === "string"
      ? DataFactory.namedNode(graph)
      : graph;
    return this.removeMatches(null, null, null, graphTerm);
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
