import "fake-indexeddb/auto";
import { assertEquals } from "@std/assert";
import { IndexeddbStore } from "./rdfjs-store/mod.ts";
import { createIndexeddbWorldsSdk } from "./sdk/mod.ts";

Deno.test("surface is exported and constructible", () => {
  assertEquals(typeof IndexeddbStore, "function");
  assertEquals(typeof createIndexeddbWorldsSdk, "function");
  const store = new IndexeddbStore({ dbName: "wazoo-playground" });
  assertEquals(store.options.dbName, "wazoo-playground");
});

Deno.test(
  "createIndexeddbWorldsSdk imports, searches, and queries end to end",
  async () => {
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
    assertEquals(search.results?.length, 1);
    assertEquals(search.results![0]!.text, "Alice");

    const sparql = await sdk.sparql({
      query: "SELECT ?s WHERE { ?s <urn:knows> <urn:bob> }",
    });
    assertEquals(sparql.kind, "select");
    assertEquals(
      (sparql as { data: { results: { bindings: unknown[] } } }).data.results
        .bindings.length,
      1,
    );
  },
);
