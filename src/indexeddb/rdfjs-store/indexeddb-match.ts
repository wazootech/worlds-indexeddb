import type * as rdfjs from "@rdfjs/types";
import {
  fromQuadRow,
  type QuadRow,
} from "@/indexeddb/rdfjs-store/quad-record.ts";
import { IdbQuadStream } from "@/indexeddb/rdfjs-store/idb-stream.ts";
import { sameRdfTerm, termKey } from "@/indexeddb/term/term-key.ts";

/** BoundPattern is one bound match position with its index and term key. */
export interface BoundPattern {
  index: string;
  key: string;
  term: rdfjs.Term;
}

/** bindPattern collects the bound positions of a match pattern. */
export function bindPattern(
  subject?: rdfjs.Term | null,
  predicate?: rdfjs.Term | null,
  object?: rdfjs.Term | null,
  graph?: rdfjs.Term | null,
): BoundPattern[] {
  const bound: BoundPattern[] = [];
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
  return bound;
}

/** acceptsQuad filters the positions not covered by the scanned index. */
export function acceptsQuad(
  remaining: Array<{ index: string; term: rdfjs.Term }>,
  quad: rdfjs.Quad,
): boolean {
  return remaining.every(({ index, term }) => {
    const actual = index === "skey"
      ? quad.subject
      : index === "pkey"
      ? quad.predicate
      : index === "okey"
      ? quad.object
      : quad.graph;
    return sameRdfTerm(actual, term);
  });
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
function openMatchCursor(
  storeName: string,
  db: IDBDatabase,
  bound: Array<{ index: string; key: string }>,
  readwrite: boolean,
): Promise<IDBRequest<IDBCursorWithValue | null>> {
  const tx = db.transaction(
    storeName,
    readwrite ? "readwrite" : "readonly",
  );
  const store = tx.objectStore(storeName);
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

/** MatchContext is the slice of IndexeddbStore a match stream reads through. */
export interface MatchContext {
  storeName: string;
  openDb(): Promise<IDBDatabase>;
}

/** createMatchStream builds the cursor-backed stream for a bound pattern. */
export function createMatchStream(
  ctx: MatchContext,
  bound: BoundPattern[],
  readwrite: boolean,
  onRecord?: (cursor: IDBCursorWithValue) => void,
): IdbQuadStream {
  const remaining = bound.map(({ index, term }) => ({ index, term }));
  const selection = bound.map(({ index, key }) => ({ index, key }));

  return new IdbQuadStream(async () => {
    const db = await ctx.openDb();
    return openMatchCursor(ctx.storeName, db, selection, readwrite);
  }, {
    accept: (quad) => acceptsQuad(remaining, quad),
    ...(onRecord ? { onRecord } : {}),
    decode: (value) => fromQuadRow(value as QuadRow),
  });
}

/** countRecords reads the record count of an object store. */
export async function countRecords(
  db: IDBDatabase,
  storeName: string,
): Promise<number> {
  const countRequest = db.transaction(storeName).objectStore(storeName)
    .count();
  return await new Promise<number>((resolve, reject) => {
    countRequest.onsuccess = () => resolve(countRequest.result);
    countRequest.onerror = () => reject(countRequest.error);
  });
}
