/**
 * IndexedDbStore — durable, zero-dependency RDF/JS Store over IndexedDB.
 *
 * SCAFFOLD STUB — see map #162 (wazootech/sparql-engine). The public surface
 * mirrors `SqliteStore` in `@worlds/sqlite` 1:1 so the engine's
 * `createTransaction` hook works unchanged once implemented:
 *
 *   const store = new IndexedDbStore({ dbName: "wazoo-playground" });
 *   const engine = new WazooSparqlEngine({
 *     store,
 *     createTransaction: () => store.createTransaction(),
 *   });
 *
 * Every method throws until the storage layout and transaction semantics are
 * decided — "Decide the IndexedDB quad storage layout and match()
 * index-selection strategy" and "Validate IndexedDbStore transaction and
 * update semantics against the W3C parity suites". The real `match()` is
 * expected to return an async stream backed by an IDB cursor (the engine
 * consumes async RDF/JS streams already), so the stub types it as
 * `rdfjs.Stream` rather than the concrete `MemoryStream` SqliteStore returns.
 */
import type * as rdfjs from "@rdfjs/types";

/**
 * IndexedDbTransaction is the atomic patch contract a SPARQL update uses to
 * buffer writes. It is structurally identical to the engine's
 * `WazooSparqlTransaction` (and the worlds client's Transaction), so a store
 * producing it satisfies the engine's `createTransaction` hook with no
 * cross-package import.
 */
export interface IndexedDbTransaction {
  /** add buffers a single quad for insertion on the next commit. */
  add(quad: rdfjs.Quad): unknown;

  /** delete buffers a single quad for deletion on the next commit. */
  delete(quad: rdfjs.Quad): unknown;

  /** commit persists the buffered patch (one IndexedDB readwrite transaction). */
  commit(): Promise<void>;

  /** rollback discards any uncommitted insertions and deletions. */
  rollback(): void;
}

/** IndexedDbStoreOptions configures IndexedDbStore. */
export interface IndexedDbStoreOptions {
  /** IndexedDB database name. */
  dbName: string;

  /** Object store name for quads (defaults to "quads"). */
  storeName?: string;
}

function notImplemented(): never {
  throw new Error("IndexedDbStore: not implemented yet (map #162)");
}

/**
 * IndexedDbStore is a durable RDF/JS Store. It implements the read side of
 * rdfjs.Store plus addQuad/removeQuad, and offers createTransaction() for
 * atomic, reload-safe SPARQL updates.
 */
export class IndexedDbStore implements rdfjs.Store<rdfjs.Quad> {
  public constructor(public readonly options: IndexedDbStoreOptions) {}

  /** createTransaction returns a fresh transaction over this store. */
  public createTransaction(): IndexedDbTransaction {
    return notImplemented();
  }

  public addQuad(quad: rdfjs.Quad): this;
  public addQuad(
    subject: rdfjs.Term,
    predicate: rdfjs.Term,
    object: rdfjs.Term,
    graph?: rdfjs.Term,
  ): this;
  public addQuad(
    _quadOrSubject: rdfjs.Quad | rdfjs.Term,
    _predicate?: rdfjs.Term,
    _object?: rdfjs.Term,
    _graph?: rdfjs.Term,
  ): this {
    return notImplemented();
  }

  public removeQuad(_quad: rdfjs.Quad): this {
    return notImplemented();
  }

  public remove(_stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    return notImplemented();
  }

  public import(_stream: rdfjs.Stream<rdfjs.Quad>): rdfjs.Stream<rdfjs.Quad> {
    return notImplemented();
  }

  public match(
    _subject?: rdfjs.Term | null,
    _predicate?: rdfjs.Term | null,
    _object?: rdfjs.Term | null,
    _graph?: rdfjs.Term | null,
  ): rdfjs.Stream<rdfjs.Quad> {
    return notImplemented();
  }

  public getQuads(
    _subject?: rdfjs.Term | null,
    _predicate?: rdfjs.Term | null,
    _object?: rdfjs.Term | null,
    _graph?: rdfjs.Term | null,
  ): rdfjs.Quad[] {
    return notImplemented();
  }

  public countQuads(
    _subject?: rdfjs.Term | null,
    _predicate?: rdfjs.Term | null,
    _object?: rdfjs.Term | null,
    _graph?: rdfjs.Term | null,
  ): number {
    return notImplemented();
  }

  public removeMatches(
    _subject?: rdfjs.Term | null,
    _predicate?: rdfjs.Term | null,
    _object?: rdfjs.Term | null,
    _graph?: rdfjs.Term | null,
  ): rdfjs.Stream<rdfjs.Quad> {
    return notImplemented();
  }

  public deleteGraph(
    _graph: rdfjs.Quad_Graph | string,
  ): rdfjs.Stream<rdfjs.Quad> {
    return notImplemented();
  }

  public get size(): number {
    return notImplemented();
  }

  /** close releases the underlying IndexedDB handle (if any is held). */
  public close(): void {
    return notImplemented();
  }
}
