import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexeddbStore } from "./rdfjs-store/mod.ts";
import { createIndexeddbWorldsSdk } from "./sdk/mod.ts";

test("surface is exported and constructible", () => {
  assert.deepStrictEqual(typeof IndexeddbStore, "function");
  assert.deepStrictEqual(typeof createIndexeddbWorldsSdk, "function");
  const store = new IndexeddbStore({ dbName: "wazoo-playground" });
  assert.deepStrictEqual(store.options.dbName, "wazoo-playground");
});

test("createIndexeddbWorldsSdk imports, searches, and queries end to end", async () => {
  const sdk = await createIndexeddbWorldsSdk({
    dbName: `e2e-${crypto.randomUUID()}`,
  });
  await sdk.import({
    mode: "merge",
    source: {
      kind: "serialized",
      contentType: "application/n-quads",
      data: [
        '<urn:alice> <urn:name> "Alice" .',
        "<urn:alice> <urn:knows> <urn:bob> .",
        '<urn:bob> <urn:name> "Bob" <urn:g1> .',
      ].join("\n"),
    },
  });

  const search = await sdk.search({ query: "ali", topK: 10 });
  assert.deepStrictEqual(search.results?.length, 1);
  assert.deepStrictEqual(search.results![0]!.text, "Alice");

  const sparql = await sdk.sparql({
    query: "SELECT ?s WHERE { ?s <urn:knows> <urn:bob> }",
  });
  assert.deepStrictEqual(sparql.kind, "select");
  assert.deepStrictEqual(
    (sparql as { data: { results: { bindings: unknown[] } } }).data.results
      .bindings.length,
    1,
  );
});
