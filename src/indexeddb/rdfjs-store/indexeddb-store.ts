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
import { quadKey, toQuadRow } from "@/indexeddb/rdfjs-store/quad-record.ts";
import type { IdbQuadStream } from "@/indexeddb/rdfjs-store/idb-stream.ts";
import {
  bindPattern,
  createMatchStream,
} from "@/indexeddb/rdfjs-store/indexeddb-match.ts";
import {
  type IndexeddbStoreOptions,
  type IndexeddbTransaction,
  IndexeddbTransactionImpl,
} from "@/indexeddb/rdfjs-store/indexeddb-transaction.ts";
import {
  buildQuad,
  collectQuads,
} from "@/indexeddb/rdfjs-store/indexeddb-quads.ts";
import { IndexeddbStoreBase } from "@/indexeddb/rdfjs-store/indexeddb-store-base.ts";
import type { Patch } from "@worlds/sdk";

export type { IndexeddbStoreOptions, IndexeddbTransaction };

/**
 * IndexeddbStore is a durable RDF/JS Store over IndexedDB. It implements the
 * read side of rdfjs.Store plus addQuad/removeQuad, and offers
 * createTransaction() for atomic SPARQL updates and applyPatch() for atomic
 * bulk patches (the SDK's replace-import path).
 */
export class IndexeddbStore extends IndexeddbStoreBase
  implements rdfjs.Store<rdfjs.Quad> {
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
    const quad = buildQuad(quadOrSubject, predicate, object, graph);
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
    return createMatchStream(
      this,
      bindPattern(subject, predicate, object, graph),
      false,
    );
  }

  /** getQuads collects the matching quads into an array. */
  public async getQuads(
    subject?: rdfjs.Term | null,
    predicate?: rdfjs.Term | null,
    object?: rdfjs.Term | null,
    graph?: rdfjs.Term | null,
  ): Promise<rdfjs.Quad[]> {
    return await collectQuads(this.match(subject, predicate, object, graph));
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
    const stream = createMatchStream(
      this,
      bindPattern(subject, predicate, object, graph),
      true,
      (cursor) => {
        cursor.delete();
      },
    );
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
}
