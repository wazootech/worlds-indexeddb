// IndexeddbStore unit tests over fake-indexeddb (Deno has no native
// IndexedDB; the browser global is provided by the /auto entry).
import "fake-indexeddb/auto";
import type * as rdfjs from "@rdfjs/types";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataFactory } from "@wazoo/sparql-engine";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";

const { namedNode, literal, defaultGraph, quad, blankNode } = DataFactory;

const ex = (suffix: string) => namedNode(`http://example.org/${suffix}`);
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

function freshStore(): IndexeddbStore {
  const store = new IndexeddbStore({ dbName: `test-${crypto.randomUUID()}` });
  return store;
}

function quadOf(
  s: string,
  p: string,
  o: string,
  g?: string,
): ReturnType<typeof quad> {
  return quad(
    ex(s),
    ex(p),
    typeof o === "string" && /^[a-z]+$/.test(o) ? ex(o) : literal(o),
    g === undefined ? defaultGraph() : ex(g),
  );
}

async function collect(
  store: IndexeddbStore,
  s?: Parameters<IndexeddbStore["match"]>[0],
  p?: Parameters<IndexeddbStore["match"]>[1],
  o?: Parameters<IndexeddbStore["match"]>[2],
  g?: Parameters<IndexeddbStore["match"]>[3],
): Promise<ReturnType<typeof quad>[]> {
  const stream = store.match(s, p, o, g);
  const quads: ReturnType<typeof quad>[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (q) => quads.push(q));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return quads;
}

test("addQuad/removeQuad persist and size tracks the live count", async () => {
  const store = freshStore();
  store.addQuad(quadOf("alice", "knows", "bob"));
  store.addQuad(quadOf("alice", "name", "Alice", "urn:g1"));
  await store.flush();
  assert.deepStrictEqual(store.size, 2);
  assert.deepStrictEqual((await collect(store)).length, 2);

  store.removeQuad(quadOf("alice", "knows", "bob"));
  await store.flush();
  assert.deepStrictEqual(store.size, 1);
  assert.deepStrictEqual((await collect(store)).length, 1);
});

test("match filters on every bound position", async () => {
  const store = freshStore();
  store.addQuad(quadOf("alice", "knows", "bob"));
  store.addQuad(quadOf("alice", "knows", "carol"));
  store.addQuad(quadOf("bob", "knows", "alice"));
  store.addQuad(quadOf("alice", "name", "Alice", "urn:g1"));
  await store.flush();

  assert.deepStrictEqual((await collect(store, ex("alice"))).length, 3);
  assert.deepStrictEqual((await collect(store, null, ex("knows"))).length, 3);
  assert.deepStrictEqual(
    (await collect(store, null, null, ex("carol"))).length,
    1,
  );
  assert.deepStrictEqual(
    (await collect(store, ex("alice"), ex("knows"), ex("bob"))).length,
    1,
  );
  assert.deepStrictEqual(
    (await collect(store, null, null, null, ex("urn:g1"))).length,
    1,
  );
  // Graph-scoped: the default graph has 3, the named graph has 1.
  assert.deepStrictEqual(
    (await collect(store, null, null, null, defaultGraph())).length,
    3,
  );
});

test("countQuads and getQuads agree with match", async () => {
  const store = freshStore();
  store.addQuad(quadOf("alice", "knows", "bob"));
  store.addQuad(quadOf("alice", "knows", "carol"));
  await store.flush();
  assert.deepStrictEqual(await store.countQuads(ex("alice")), 2);
  assert.deepStrictEqual(await store.countQuads(null, ex("knows")), 2);
  assert.deepStrictEqual((await store.getQuads(ex("alice"))).length, 2);
});

test("literal language and datatype round-trip losslessly", async () => {
  const store = freshStore();
  const quads = [
    quad(ex("s"), ex("p"), literal("hola", "es")),
    quad(ex("s"), ex("p"), literal("42", namedNode(XSD_INTEGER))),
    quad(ex("s"), ex("p"), literal("plain")),
  ];
  for (const q of quads) {
    store.addQuad(q);
  }
  await store.flush();
  const out = await collect(store, ex("s"));
  assert.deepStrictEqual(out.length, 3);
  const byValue = new Map(out.map((q) => [q.object.value, q.object]));
  assert.deepStrictEqual((byValue.get("hola") as rdfjs.Literal).language, "es");
  assert.deepStrictEqual(
    (byValue.get("42") as rdfjs.Literal).datatype.value,
    XSD_INTEGER,
  );
  assert.deepStrictEqual(
    (byValue.get("plain") as rdfjs.Literal).datatype.value,
    "http://www.w3.org/2001/XMLSchema#string",
  );
});

test("RDF-star triple terms round-trip structurally", async () => {
  const store = freshStore();
  const inner = quad(ex("a"), ex("b"), ex("c"));
  const outer = quad(ex("s"), ex("p"), inner);
  store.addQuad(outer);
  await store.flush();
  const out = await collect(store, ex("s"));
  assert.deepStrictEqual(out.length, 1);
  assert.deepStrictEqual(out[0]!.object.termType, "Quad");
  const decoded = out[0]!.object as ReturnType<typeof quad>;
  assert.deepStrictEqual(decoded.subject.value, "http://example.org/a");
  assert.deepStrictEqual(decoded.object.value, "http://example.org/c");
});

test("transaction commit is atomic and rollback discards", async () => {
  const store = freshStore();
  store.addQuad(quadOf("alice", "knows", "bob"));
  await store.flush();

  const tx = store.createTransaction();
  tx.add(quadOf("alice", "knows", "carol"));
  tx.delete(quadOf("alice", "knows", "bob"));
  await tx.commit();
  assert.deepStrictEqual((await collect(store)).length, 1);
  assert.deepStrictEqual(
    (await collect(store, null, null, ex("carol"))).length,
    1,
  );

  const tx2 = store.createTransaction();
  tx2.add(quadOf("alice", "knows", "dave"));
  tx2.rollback();
  assert.deepStrictEqual((await collect(store)).length, 1);
});

test("applyPatch replace mode clears the store first", async () => {
  const store = freshStore();
  await store.applyPatch({
    insertions: [quadOf("alice", "knows", "bob")],
    deletions: [],
  });
  await store.applyPatch(
    {
      insertions: [quadOf("carol", "knows", "dave")],
      deletions: [],
    },
    { importMode: "replace" },
  );
  const out = await collect(store);
  assert.deepStrictEqual(out.length, 1);
  assert.deepStrictEqual(out[0]!.subject.value, "http://example.org/carol");
});

test("removeMatches deletes matches and streams the removed quads", async () => {
  const store = freshStore();
  store.addQuad(quadOf("alice", "knows", "bob"));
  store.addQuad(quadOf("alice", "knows", "carol"));
  store.addQuad(quadOf("bob", "knows", "alice"));
  await store.flush();

  const stream = store.removeMatches(ex("alice"));
  const removed: ReturnType<typeof quad>[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (q) => removed.push(q));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  assert.deepStrictEqual(removed.length, 2);
  await store.flush();
  assert.deepStrictEqual((await collect(store)).length, 1);
});

test("deleteGraph removes a named graph only", async () => {
  const store = freshStore();
  store.addQuad(quadOf("alice", "knows", "bob"));
  store.addQuad(quadOf("alice", "name", "Alice", "urn:g1"));
  await store.flush();
  await new Promise<void>((resolve, reject) => {
    const stream = store.deleteGraph("http://example.org/urn:g1");
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  await store.flush();
  assert.deepStrictEqual((await collect(store)).length, 1);
  assert.deepStrictEqual(
    (await collect(store, null, null, null, defaultGraph())).length,
    1,
  );
});

test("persistence across store instances on the same database", async () => {
  const dbName = `persist-${crypto.randomUUID()}`;
  const first = new IndexeddbStore({ dbName });
  first.addQuad(quadOf("alice", "knows", "bob"));
  await first.flush();

  const second = new IndexeddbStore({ dbName });
  await second.openDb();
  assert.deepStrictEqual((await collect(second)).length, 1);
  assert.deepStrictEqual(second.size, 1);
  first.close();
  second.close();
});

test("blank nodes and quads differing only by graph never collide", async () => {
  const store = freshStore();
  const shared = quadOf("alice", "knows", "bob");
  store.addQuad(shared);
  store.addQuad(quad(ex("alice"), ex("knows"), ex("bob"), ex("g1")));
  store.addQuad(quad(blankNode("b1"), ex("p"), ex("o")));
  await store.flush();
  assert.deepStrictEqual(store.size, 3);
  assert.deepStrictEqual(
    (await collect(store, null, null, null, ex("g1"))).length,
    1,
  );
});
