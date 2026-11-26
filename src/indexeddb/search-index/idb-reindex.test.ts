import "fake-indexeddb/auto";
import type * as rdfjs from "@rdfjs/types";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataFactory } from "@wazoo/sparql-engine";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { IndexeddbSearchIndex } from "./indexeddb-search-index.ts";
import { createIdbSubject, wholeLiteral } from "./idb-test-support.ts";

// reindexChunks pages the stored quads (a cursor over an IndexeddbStore, a
// sliced array otherwise); the page size must never change what is stored.

const { namedNode, literal, defaultGraph, quad } = DataFactory;
const embeddingService = new FakeEmbeddingService();
const quads = ["a", "b", "c", "d", "e"].map((name) =>
  quad(
    namedNode(`urn:${name}`),
    namedNode("urn:p"),
    literal(`text ${name}`),
    defaultGraph(),
  )
);
quads.push(
  quad(
    namedNode("urn:a"),
    namedNode("urn:n"),
    literal("42", namedNode("http://www.w3.org/2001/XMLSchema#integer")),
    defaultGraph(),
  ),
);
const scope = { include: { subjects: ["urn:a", "urn:c", "urn:e"] } };

async function stored(s: Awaited<ReturnType<typeof createIdbSubject>>) {
  return (await s.chunkedQuadIds()).sort();
}

for (const pageSize of [1, 2, 3, 6, 1000]) {
  test(`reindex with readPageSize ${pageSize} keeps counts and rows identical`, async () => {
    const s = await createIdbSubject({ embeddingService });
    await s.store.applyPatch({ insertions: quads, deletions: [] });
    assert.deepStrictEqual(await s.index.reindex({ readPageSize: pageSize }), {
      processedQuadCount: 6,
      chunkRowCount: 5,
    });
    const all = await stored(s);
    assert.deepStrictEqual(all.length, 5);
    assert.deepStrictEqual(
      await s.index.reindex({ ...scope, readPageSize: pageSize }),
      {
        processedQuadCount: 6,
        chunkRowCount: 3,
      },
    );
    assert.deepStrictEqual(await stored(s), all);
  });
}

test("reindex over a store that is not an IndexeddbStore slices one read", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.store.applyPatch({ insertions: quads, deletions: [] });
  const plain = {
    size: 0,
    match: (...args: Parameters<typeof s.store.match>) =>
      s.store.match(...args),
  } as unknown as rdfjs.Store & { size: number };
  const index = new IndexeddbSearchIndex({
    chunkStore: s.chunkStore,
    textSplitter: wholeLiteral,
    embeddingService,
    quadsStore: plain,
  });
  assert.deepStrictEqual(await index.reindex({ readPageSize: 2 }), {
    processedQuadCount: 6,
    chunkRowCount: 5,
  });
  assert.deepStrictEqual((await stored(s)).length, 5);
});

// A rebuild writes page by page, as the SQL backends do: each page is its own
// transaction, so a failure on page N leaves pages 1..N-1 written (and, with no
// scope, the old rows already cleared) and a rerun repairs it. Embedding runs
// before each page's write, so a failure on page 1 changes nothing.

const textual = quads.slice(0, 5);
const staleRow = (quad_id: string, value = "stale") => ({
  quad_id,
  subject: "urn:old",
  predicate: "urn:p",
  graph: "",
  value,
  fts_value: value,
});

const base = embeddingService;

/** probe wraps the embedder: it logs each embed, and throws on call `failAt`. */
function probe(log: string[]) {
  const state = { calls: 0, failAt: 0, texts: [] as string[][] };
  const service = {
    embed: (texts: string[]) => {
      state.calls++;
      log.push("embed");
      if (state.calls === state.failAt) {
        return Promise.reject(new Error("embedder down"));
      }
      state.texts.push(texts);
      return base.embed(texts);
    },
  };
  return { state, embeddingService: service };
}

/** seededPaged stores the textual quads and returns the probe and subject. */
async function seededPaged() {
  const log: string[] = [];
  const { state, embeddingService } = probe(log);
  const s = await createIdbSubject({ embeddingService });
  await s.store.applyPatch({ insertions: textual, deletions: [] });
  return { s, state, log };
}

const rowsOf = async (s: Awaited<ReturnType<typeof createIdbSubject>>) =>
  (await s.chunkStore.getAllChunks()).map((c) => [c.quad_id, c.value]).sort();

test("unscoped: a failure on page 2 keeps page 1, clears the old rows, and a rerun repairs it", async () => {
  const { s, state } = await seededPaged();
  await s.chunkStore.insertChunks([staleRow("orphan")]);
  state.failAt = 2;
  await assert.rejects(() => s.index.reindex({ readPageSize: 2 }), Error);
  const partial = await s.chunkStore.getAllChunks();
  assert.deepStrictEqual(
    partial.length,
    2,
    "only page 1 is written; the orphan is gone",
  );
  assert.deepStrictEqual(
    partial.map((c) => c.value.toLowerCase()).sort(),
    state.texts[0].map((t) => t.toLowerCase()).sort(),
  );
  state.failAt = 0;
  assert.deepStrictEqual(await s.index.reindex({ readPageSize: 2 }), {
    processedQuadCount: 5,
    chunkRowCount: 5,
  });
  const clean = await seededPaged();
  await clean.s.index.reindex({ readPageSize: 2 });
  assert.deepStrictEqual(await rowsOf(s), await rowsOf(clean.s));
});

test("an embedding failure on page 1 changes nothing", async () => {
  const { s, state } = await seededPaged();
  await s.chunkStore.insertChunks([staleRow("orphan")]);
  state.failAt = 1;
  await assert.rejects(() => s.index.reindex({ readPageSize: 2 }), Error);
  assert.deepStrictEqual(await rowsOf(s), [["orphan", "stale"]]);
});

test("scoped: a failure on page 2 keeps page 1's replaced rows and leaves out-of-scope rows alone", async () => {
  const { s, state } = await seededPaged();
  await s.index.reindex();
  const inScope = ["urn:a", "urn:c", "urn:e"];
  const all = await s.chunkStore.getAllChunks();
  const mine = all.filter((c) => inScope.includes(c.subject));
  const others = all.filter((c) => !inScope.includes(c.subject));
  const staleIds = mine.map((c) => c.quad_id);
  await s.chunkStore.replaceForQuads(
    staleIds,
    staleIds.map((id) => staleRow(id)),
  );
  const outBefore = (await rowsOf(s)).filter(([id]) =>
    others.some((o) => o.quad_id === id)
  );
  state.calls = 0;
  state.texts = [];
  state.failAt = 2;
  await assert.rejects(
    () => s.index.reindex({ include: { subjects: inScope }, readPageSize: 1 }),
    Error,
  );
  const after = await s.chunkStore.getAllChunks();
  const replaced = after.filter((c) =>
    staleIds.includes(c.quad_id) && c.value !== "stale"
  );
  assert.deepStrictEqual(
    replaced.length,
    1,
    "page 1's in-scope row was replaced",
  );
  assert.deepStrictEqual(
    after.filter((c) => c.value === "stale").length,
    inScope.length - 1,
    "later in-scope rows are still stale",
  );
  assert.deepStrictEqual(
    (await rowsOf(s)).filter(([id]) => others.some((o) => o.quad_id === id)),
    outBefore,
  );
  state.failAt = 0;
  await s.index.reindex({ include: { subjects: inScope }, readPageSize: 1 });
  assert.deepStrictEqual(
    (await s.chunkStore.getAllChunks()).filter((c) => c.value === "stale"),
    [],
  );
});

test("each page is its own chunk-store transaction, written after its embedding", async () => {
  const { s, log } = await seededPaged();
  const proto = IDBDatabase.prototype;
  const original = proto.transaction;
  proto.transaction = function (this: IDBDatabase, names, mode, options) {
    const list = typeof names === "string" ? [names] : [...names];
    if (mode === "readwrite" && list.includes(s.chunkStore.chunkStoreName)) {
      log.push("tx");
    }
    return original.call(this, names, mode, options);
  };
  try {
    await s.index.reindex({ readPageSize: 2 });
    assert.deepStrictEqual(log, ["embed", "tx", "embed", "tx", "embed", "tx"]);
    log.length = 0;
    const inScope = { subjects: ["urn:a", "urn:c", "urn:e"] };
    await s.index.reindex({ include: inScope, readPageSize: 1 });
    assert.deepStrictEqual(log, ["embed", "tx", "embed", "tx", "embed", "tx"]);
  } finally {
    proto.transaction = original;
  }
});

test("an unscoped reindex of an empty store still clears the chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.chunkStore.insertChunks([staleRow("orphan")]);
  assert.deepStrictEqual(await s.index.reindex(), {
    processedQuadCount: 0,
    chunkRowCount: 0,
  });
  assert.deepStrictEqual(await rowsOf(s), []);
});
