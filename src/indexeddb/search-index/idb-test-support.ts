import "fake-indexeddb/auto";
import type * as rdfjs from "@rdfjs/types";
import type {
  CommitConformanceCreateOptions,
  CommitConformanceSubject,
} from "@worlds/sdk/testing";
import type { TextSplitterInterface } from "@worlds/sdk/search-index/quad-chunker";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";
import { IdbChunkStore } from "./idb-chunk-store.ts";
import { createProjectingCommit } from "./idb-projecting-commit.ts";
import { IndexeddbSearchIndex } from "./indexeddb-search-index.ts";

/** wholeLiteral keeps each literal as one chunk, as the suite requires. */
export const wholeLiteral: TextSplitterInterface = {
  createDocuments: (texts, metadatas) =>
    Promise.resolve(
      texts.map((pageContent, i) => ({
        pageContent,
        metadata: metadatas?.[i],
      })),
    ),
};

/** collectQuads reads every quad in a store. */
export async function collectQuads(
  store: IndexeddbStore,
): Promise<rdfjs.Quad[]> {
  const quads: rdfjs.Quad[] = [];
  const stream = store.match(null, null, null, null);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (quad: rdfjs.Quad) => quads.push(quad));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return quads;
}

/**
 * failNextChunkPut makes the next `put` into the chunk object store throw once.
 * Inside a commit's transaction that is a LATER write than the quad puts, so it
 * tells an atomic commit from one that stored the quads first.
 */
function failNextChunkPut(chunkStoreName: string): void {
  const proto = IDBObjectStore.prototype;
  const put = proto.put;
  proto.put = function (this: IDBObjectStore, ...args) {
    if (this.name !== chunkStoreName) return put.apply(this, args);
    proto.put = put;
    throw new Error("injected chunk write failure");
  };
}

/** IdbSubject is the conformance subject plus the parts a test may break or inspect. */
export type IdbSubject = CommitConformanceSubject & {
  store: IndexeddbStore;
  chunkStore: IdbChunkStore;
  index: IndexeddbSearchIndex;
  /** failNextChunkWrite makes the next chunk put fail once, after the quad puts in the same transaction. */
  failNextChunkWrite(): void;
};

/** IdbSubjectExtra tunes a subject beyond what the conformance suite configures. */
export interface IdbSubjectExtra {
  /**
   * failInsideTransaction makes `failNextWrite` fail a chunk put inside the
   * commit's transaction (after the quad puts) instead of rejecting `applyPatch`
   * up front, so the suite exercises a failure in a later write.
   */
  failInsideTransaction?: boolean;
}

/** createIdbSubject wires the real IndexedDB commit path with the suite's hooks. */
export async function createIdbSubject(
  options: CommitConformanceCreateOptions,
  extra: IdbSubjectExtra = {},
): Promise<IdbSubject> {
  const dbName = `conformance-${crypto.randomUUID()}`;
  const store = new IndexeddbStore({ dbName });
  await store.openDb();
  const chunkStore = new IdbChunkStore({ dbName });
  await chunkStore.openDb();
  const projector = {
    chunkStore,
    textSplitter: wholeLiteral,
    embeddingService: options.embeddingService,
  };
  const index = new IndexeddbSearchIndex({
    ...projector,
    vectorDimensions: 32,
    quadsStore: store,
  });
  let rebuilds = 0;
  let failArmed = false;
  const applyPatch = store.applyPatch.bind(store);
  store.applyPatch = (patch, context, chunks) => {
    if (failArmed) {
      failArmed = false;
      return Promise.reject(new Error("injected write failure"));
    }
    return applyPatch(patch, context, chunks);
  };
  const commit = createProjectingCommit({
    store,
    chunkStore,
    projector,
    searchIndexOnImport: options.searchIndexOnImport,
    reindex: () => {
      rebuilds++;
      return index.reindex();
    },
  });
  return {
    store,
    chunkStore,
    index,
    failNextChunkWrite: () => failNextChunkPut(chunkStore.chunkStoreName),
    commit,
    storedQuads: () => collectQuads(store),
    chunkedQuadIds: async () =>
      (await chunkStore.getAllChunks()).map((chunk) => chunk.quad_id),
    failNextWrite: () => {
      if (extra.failInsideTransaction) {
        failNextChunkPut(chunkStore.chunkStoreName);
      } else {
        failArmed = true;
      }
    },
    fullRebuildCount: () => rebuilds,
  };
}
