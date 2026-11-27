// The quad store and the chunk store share one database. Opening them used to
// hang (store first) or throw a VersionError (chunks first) because they asked
// for different versions; they now share one schema version.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataFactory } from "@wazoo/sparql-engine";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";
import { IdbChunkStore } from "@/indexeddb/search-index/idb-chunk-store.ts";
import { createIndexeddbWorldsSdk } from "@/indexeddb/sdk/create-indexeddb-sdk.ts";

const { namedNode, literal, defaultGraph, quad } = DataFactory;

/** within fails the test instead of hanging when `work` never settles. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`blocked for ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("quad store then chunk store open on one database", async () => {
  const dbName = `schema-${crypto.randomUUID()}`;
  const store = new IndexeddbStore({ dbName });
  const chunks = new IdbChunkStore({ dbName });
  await within(2000, store.openDb());
  await within(2000, chunks.openDb());
  await chunks.insertChunks([{
    quad_id: "q",
    subject: "s",
    predicate: "p",
    graph: "g",
    value: "v",
    fts_value: "v",
  }]);
  assert.deepStrictEqual(await chunks.countChunks(), 1);
});

test("chunk store then quad store open on one database", async () => {
  const dbName = `schema-${crypto.randomUUID()}`;
  await within(2000, new IdbChunkStore({ dbName }).openDb());
  const store = new IndexeddbStore({ dbName });
  await within(2000, store.openDb());
  assert.deepStrictEqual(await store.countQuads(), 0);
});

test("a version 1 database from an older release upgrades in place", async () => {
  const dbName = `schema-${crypto.randomUUID()}`;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const quads = request.result.createObjectStore("quads", {
        keyPath: "key",
      });
      for (const name of ["skey", "pkey", "okey", "gkey"]) {
        quads.createIndex(name, name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  const store = new IndexeddbStore({ dbName });
  await store.applyPatch({
    insertions: [
      quad(
        namedNode("urn:s"),
        namedNode("urn:p"),
        literal("kept"),
        defaultGraph(),
      ),
    ],
    deletions: [],
  });
  const chunks = new IdbChunkStore({ dbName });
  await within(2000, chunks.openDb());
  assert.deepStrictEqual(await store.countQuads(), 1);
  assert.deepStrictEqual(await chunks.countChunks(), 0);
});

test("createIndexeddbWorldsSdk opens with a textSplitter", async () => {
  const sdk = await within(
    2000,
    createIndexeddbWorldsSdk({
      dbName: `schema-${crypto.randomUUID()}`,
      textSplitter: {
        createDocuments: (texts) =>
          Promise.resolve(texts.map((pageContent) => ({ pageContent }))),
      },
    }),
  );
  assert(sdk);
});
