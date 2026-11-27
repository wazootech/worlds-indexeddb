import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataFactory } from "@wazoo/sparql-engine";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { hashQuad } from "@worlds/sdk/quad-store";
import { createIndexeddbWorldsSdk } from "@/indexeddb/sdk/create-indexeddb-sdk.ts";
import {
  collectQuads,
  createIdbSubject,
  wholeLiteral,
} from "./idb-test-support.ts";

// Each case pins one behavior the SQL backends (the shared sql-core commit and
// rebuild) already have, so a drift in `@worlds/indexeddb` is a red test
// (wazootech/worlds-sdk-ts#265).

const { namedNode, literal, defaultGraph, quad } = DataFactory;
const g = defaultGraph();
const p = namedNode("urn:p");
const embeddingService = new FakeEmbeddingService();
const xsdInteger = namedNode("http://www.w3.org/2001/XMLSchema#integer");

const a1 = quad(namedNode("urn:a"), p, literal("alpha one"), g);
const a2 = quad(
  namedNode("urn:a"),
  namedNode("urn:q"),
  literal("alpha two"),
  g,
);
const b1 = quad(namedNode("urn:b"), p, literal("beta one"), g);
const bNumber = quad(namedNode("urn:b"), p, literal("42", xsdInteger), g);
const bIri = quad(namedNode("urn:b"), p, namedNode("urn:c"), g);

const scopeA = { include: { subjects: ["urn:a"] } };

/** seeded stores a1, a2, b1 and two non-textual quads, with chunks for the textual ones. */
async function seeded() {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({
    insertions: [a1, a2, b1, bNumber, bIri],
    deletions: [],
  });
  assert.deepStrictEqual((await s.chunkedQuadIds()).length, 3);
  return s;
}

const sorted = (ids: string[]) => [...ids].sort();

test("item 1: a scoped reindex replaces only in-scope chunks and keeps the rest", async () => {
  const s = await seeded();
  const before = sorted(await s.chunkedQuadIds());
  // A row of a quad that no longer exists: out of scope, so it must survive.
  await s.chunkStore.insertChunks([{
    quad_id: "orphan",
    subject: "urn:gone",
    predicate: "urn:p",
    graph: "",
    value: "orphan",
    fts_value: "orphan",
  }]);
  await s.index.reindex(scopeA);
  assert.deepStrictEqual(
    sorted(await s.chunkedQuadIds()),
    sorted([...before, "orphan"]),
    "a scoped reindex neither drops nor duplicates out-of-scope rows",
  );
});

test("item 1: a scoped reindex repairs a missing in-scope chunk", async () => {
  const s = await seeded();
  await s.chunkStore.deleteByQuadIds([hashQuad(a1)]);
  await s.index.reindex(scopeA);
  assert.deepStrictEqual(
    sorted(await s.chunkedQuadIds()),
    sorted([hashQuad(a1), hashQuad(a2), hashQuad(b1)]),
  );
});

test("item 1: an exclude scope rebuilds everything but the excluded quads", async () => {
  const s = await seeded();
  await s.chunkStore.deleteByQuadIds([hashQuad(a1), hashQuad(a2)]);
  await s.chunkStore.deleteByQuadIds([hashQuad(b1)]);
  await s.chunkStore.insertChunks([{
    quad_id: hashQuad(b1),
    subject: "urn:b",
    predicate: "urn:p",
    graph: "",
    value: "kept as is",
    fts_value: "kept as is",
  }]);
  await s.index.reindex({ exclude: { subjects: ["urn:b"] } });
  const chunks = await s.chunkStore.getAllChunks();
  assert.deepStrictEqual(
    sorted(chunks.map((c) => c.quad_id)),
    sorted([hashQuad(a1), hashQuad(a2), hashQuad(b1)]),
  );
  assert.deepStrictEqual(
    chunks.find((c) => c.quad_id === hashQuad(b1))?.value,
    "kept as is",
    "the excluded quad's row is untouched",
  );
});

test("item 1: an unscoped reindex clears every chunk, orphans included", async () => {
  const s = await seeded();
  await s.chunkStore.insertChunks([{
    quad_id: "orphan",
    subject: "urn:gone",
    predicate: "urn:p",
    graph: "",
    value: "orphan",
    fts_value: "orphan",
  }]);
  await s.index.reindex();
  assert.deepStrictEqual(
    sorted(await s.chunkedQuadIds()),
    sorted([hashQuad(a1), hashQuad(a2), hashQuad(b1)]),
  );
  // A scope with no criteria is not a scope (sql-core): it clears all too.
  await s.chunkStore.insertChunks([{
    quad_id: "orphan",
    subject: "urn:gone",
    predicate: "urn:p",
    graph: "",
    value: "orphan",
    fts_value: "orphan",
  }]);
  await s.index.reindex({ include: {} });
  assert.deepStrictEqual((await s.chunkedQuadIds()).length, 3);
});

test("item 2: processedQuadCount counts every stored quad scanned, in scope or not", async () => {
  const s = await seeded();
  assert.deepStrictEqual(await s.index.reindex(scopeA), {
    processedQuadCount: 5,
    chunkRowCount: 2,
  });
  assert.deepStrictEqual(await s.index.reindex(), {
    processedQuadCount: 5,
    chunkRowCount: 3,
  });
});

test("item 3: a commit applies the include/exclude filter, as a reindex does", async () => {
  const s = await createIdbSubject({ embeddingService }, scopeA);
  await s.commit({ insertions: [a1, b1], deletions: [] });
  // Out-of-scope quads are not stored (SQL: preparePatch with options.filter)...
  assert.deepStrictEqual(
    (await collectQuads(s.store)).map((q) => q.subject.value),
    [
      "urn:a",
    ],
  );
  // ...nor projected, so the commit and a reindex agree on the chunks.
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(a1)]);
  await s.index.reindex();
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(a1)]);
});

test("item 3: a commit applies an exclude filter to its deletions too", async () => {
  const s = await createIdbSubject({ embeddingService }, {
    exclude: { subjects: ["urn:a"] },
  });
  await s.store.applyPatch({ insertions: [a1, b1], deletions: [] });
  await s.commit({ insertions: [], deletions: [a1, b1] });
  // a1 is excluded, so the filtered commit never sees its deletion.
  assert.deepStrictEqual((await s.storedQuads()).map((q) => q.subject.value), [
    "urn:a",
  ]);
});

test("item 3: the factory takes include/exclude for imports and reindex", async () => {
  const sdk = await createIndexeddbWorldsSdk({
    dbName: `factory-${crypto.randomUUID()}`,
    textSplitter: wholeLiteral,
    include: { subjects: ["urn:kept"] },
  });
  await sdk.import({
    source: {
      kind: "serialized",
      data:
        `<urn:kept> <urn:p> "kept needle" .\n<urn:drop> <urn:p> "dropped needle" .`,
      contentType: "text/turtle",
    },
  });
  const all = JSON.stringify(
    await sdk.sparql({ query: "SELECT * WHERE { ?s ?p ?o }" }),
  );
  assert.deepStrictEqual(all.includes("urn:kept"), true);
  assert.deepStrictEqual(all.includes("urn:drop"), false);
  const found = (await sdk.search({ query: "needle" })).results ?? [];
  assert.deepStrictEqual(found.map((r) => r.subject), ["urn:kept"]);
});

const turtle =
  `<urn:a> <urn:p> "Needle in a haystack" .\n<urn:b> <urn:p> "Other text" .`;
const replacement = `<urn:c> <urn:p> "Replacement text" .`;

for (const mode of ["disabled", "incremental"] as const) {
  test(`item 4: ${mode}: deleting a quad drops its chunk rows`, async () => {
    const sdk = await createIndexeddbWorldsSdk({
      dbName: `factory-${crypto.randomUUID()}`,
      textSplitter: wholeLiteral,
      searchIndexOnImport: mode,
    });
    await sdk.import({
      source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
    });
    await sdk.reindex();
    assert.deepStrictEqual(
      (await sdk.search({ query: "needle" })).results?.length,
      1,
    );
    await sdk.sparql({
      query: `DELETE DATA { <urn:a> <urn:p> "Needle in a haystack" }`,
    });
    assert.deepStrictEqual(
      (await sdk.search({ query: "needle" })).results?.length,
      0,
    );
  });

  test(`item 4: ${mode}: a replace import drops the old chunk rows`, async () => {
    const sdk = await createIndexeddbWorldsSdk({
      dbName: `factory-${crypto.randomUUID()}`,
      textSplitter: wholeLiteral,
      searchIndexOnImport: mode,
    });
    await sdk.import({
      source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
    });
    await sdk.reindex();
    await sdk.import({
      source: {
        kind: "serialized",
        data: replacement,
        contentType: "text/turtle",
      },
      mode: "replace",
    });
    assert.deepStrictEqual(
      (await sdk.search({ query: "needle" })).results?.length,
      0,
    );
  });
}

test("item 5: a reindex over non-textual literals and IRIs chunks only the text", async () => {
  const s = await seeded();
  await s.index.reindex();
  const chunks = await s.chunkStore.getAllChunks();
  assert.deepStrictEqual(
    sorted(chunks.map((c) => c.value)),
    ["alpha one", "alpha two", "beta one"],
  );
  assert.deepStrictEqual(
    sorted(chunks.map((c) => c.quad_id)),
    sorted([hashQuad(a1), hashQuad(a2), hashQuad(b1)]),
    "each chunk carries the hash of its own quad, not a neighbor's",
  );
});
