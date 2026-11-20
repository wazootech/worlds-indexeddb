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

/** createIdbSubject wires the real IndexedDB commit path with the suite's hooks. */
/** IdbSubject is the conformance subject plus the parts a test may break or inspect. */
export type IdbSubject = CommitConformanceSubject & {
  store: IndexeddbStore;
  chunkStore: IdbChunkStore;
  index: IndexeddbSearchIndex;
  /** failNextChunkWrite makes the next chunk insert fail once, after the quads are stored. */
  failNextChunkWrite(): void;
};

export async function createIdbSubject(
  options: CommitConformanceCreateOptions,
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
  store.applyPatch = (patch, context) => {
    if (failArmed) {
      failArmed = false;
      return Promise.reject(new Error("injected write failure"));
    }
    return applyPatch(patch, context);
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
  let chunkFailArmed = false;
  const insertChunks = chunkStore.insertChunks.bind(chunkStore);
  chunkStore.insertChunks = (records) => {
    if (chunkFailArmed) {
      chunkFailArmed = false;
      return Promise.reject(new Error("injected chunk write failure"));
    }
    return insertChunks(records);
  };
  return {
    store,
    chunkStore,
    index,
    failNextChunkWrite: () => {
      chunkFailArmed = true;
    },
    commit,
    storedQuads: () => collectQuads(store),
    chunkedQuadIds: async () =>
      (await chunkStore.getAllChunks()).map((chunk) => chunk.quad_id),
    failNextWrite: () => {
      failArmed = true;
    },
    fullRebuildCount: () => rebuilds,
  };
}
