import "fake-indexeddb/auto";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DataFactory } from "@wazoo/sparql-engine";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { FakeEmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { hashQuad } from "@worlds/sdk/quad-store";
import { createIndexeddbWorldsSdk } from "@/indexeddb/sdk/create-indexeddb-sdk.ts";
import {
  collectQuads,
  createIdbSubject,
  wholeLiteral,
} from "./idb-test-support.ts";

const { namedNode, literal, defaultGraph, quad } = DataFactory;
const g = defaultGraph();
const p = namedNode("urn:p");
const hello = quad(namedNode("urn:a"), p, literal("Hello World"), g);
const other = quad(namedNode("urn:b"), p, literal("Other Text"), g);
const embeddingService = new FakeEmbeddingService();

Deno.test("a chunk write that fails after the quad puts aborts the whole commit", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [other], deletions: [] });
  s.failNextChunkWrite();
  await assertRejects(() =>
    s.commit({ insertions: [hello], deletions: [other] })
  );
  // Neither the new quad, nor the deletion, nor the chunk changes landed.
  assertEquals((await s.storedQuads()).map((q) => q.subject.value), ["urn:b"]);
  assertEquals(await s.chunkedQuadIds(), [hashQuad(other)]);
  // The failure is not sticky: the same commit now succeeds.
  await s.commit({ insertions: [hello], deletions: [other] });
  assertEquals(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

Deno.test("a failed replace import keeps the old graph and its chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  s.failNextChunkWrite();
  await assertRejects(
    () =>
      s.commit({ insertions: [other], deletions: [] }, {
        importMode: "replace",
      }),
    Error,
    "injected chunk write failure",
  );
  assertEquals((await s.storedQuads()).map((q) => q.subject.value), ["urn:a"]);
  assertEquals(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

Deno.test("the default mode is incremental: a commit writes quads and chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  assertEquals((await s.storedQuads()).length, 1);
  assertEquals(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

Deno.test("disabled never touches chunks on commit; only reindex writes them", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "disabled",
    embeddingService,
  });
  await s.commit({ insertions: [hello], deletions: [] });
  assertEquals((await s.storedQuads()).length, 1);
  assertEquals((await s.chunkedQuadIds()).length, 0);
  await s.index.reindex();
  assertEquals(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

Deno.test("a re-inserted quad keeps exactly one chunk row", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  await s.commit({ insertions: [hello], deletions: [hello] });
  assertEquals(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

Deno.test("a replace import drops the chunks of the wiped graph", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService,
  });
  await s.commit({ insertions: [hello], deletions: [] });
  await s.commit({ insertions: [other], deletions: [] }, {
    importMode: "replace",
  });
  assertEquals(await s.chunkedQuadIds(), [hashQuad(other)]);
  assertEquals((await collectQuads(s.store)).length, 1);
});

Deno.test("deleting a quad drops its chunks", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService,
  });
  await s.commit({ insertions: [hello, other], deletions: [] });
  await s.commit({ insertions: [], deletions: [hello] });
  assertEquals(await s.chunkedQuadIds(), [hashQuad(other)]);
});

Deno.test("embeddings use the original text while keyword text is lowercased", async () => {
  const seen: string[] = [];
  const spy: EmbeddingService = {
    embed: (texts) => {
      seen.push(...texts);
      return embeddingService.embed(texts);
    },
  };
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService: spy,
  });
  await s.commit({ insertions: [hello], deletions: [] });
  assertEquals(seen, ["Hello World"]);
  const [chunk] = await s.chunkStore.getAllChunks();
  assertEquals(chunk?.fts_value, "hello world");
  assertEquals(chunk?.value, "Hello World");
  assert(chunk?.vector?.length === 32);
});

const failingEmbeddings: EmbeddingService = {
  embed: () => Promise.reject(new Error("embedding service unavailable")),
};

Deno.test("an embedding failure throws and writes nothing", async () => {
  const s = await createIdbSubject({ embeddingService: failingEmbeddings });
  await assertRejects(
    () => s.commit({ insertions: [hello], deletions: [] }),
    Error,
    "failed to vectorize",
  );
  assertEquals((await s.storedQuads()).length, 0);
  assertEquals((await s.chunkedQuadIds()).length, 0);
});

Deno.test("a reindex whose embedding fails keeps the existing chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  const broken = await createIdbSubject({
    embeddingService: failingEmbeddings,
  });
  await broken.store.applyPatch({ insertions: [hello], deletions: [] });
  await broken.chunkStore.insertChunks(await s.chunkStore.getAllChunks());
  await assertRejects(
    () => broken.index.reindex(),
    Error,
    "failed to vectorize",
  );
  assertEquals(await broken.chunkedQuadIds(), [hashQuad(hello)]);
});

const turtle =
  `<urn:a> <urn:p> "Needle in a haystack" .\n<urn:b> <urn:p> "Other text" .`;

async function sdkWith(mode?: "incremental" | "deferred" | "disabled") {
  return await createIndexeddbWorldsSdk({
    dbName: `factory-${crypto.randomUUID()}`,
    textSplitter: wholeLiteral,
    // Keyword-only, so a search returns only chunks that contain the word.
    searchIndexOnImport: mode,
  });
}

Deno.test("factory: with the option unset an import is searchable at once (incremental)", async () => {
  const sdk = await sdkWith();
  await sdk.import({
    source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
  });
  assertEquals((await sdk.search({ query: "needle" })).results?.length, 1);
});

Deno.test("factory: disabled keeps an import unsearchable until reindex", async () => {
  const sdk = await sdkWith("disabled");
  await sdk.import({
    source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
  });
  assertEquals((await sdk.search({ query: "needle" })).results?.length, 0);
  await sdk.reindex();
  assertEquals((await sdk.search({ query: "needle" })).results?.length, 1);
});

Deno.test("factory: a failing embedding service rejects the import and stores nothing", async () => {
  const sdk = await createIndexeddbWorldsSdk({
    dbName: `factory-${crypto.randomUUID()}`,
    textSplitter: wholeLiteral,
    embeddingService: failingEmbeddings,
    vectorDimensions: 32,
  });
  await assertRejects(() =>
    sdk.import({
      source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
    })
  );
  assertEquals((await sdk.search({ query: "needle" })).results?.length, 0);
  const all = await sdk.sparql({ query: "SELECT * WHERE { ?s ?p ?o }" });
  assert(!JSON.stringify(all).includes("urn:a"), "no quad may be stored");
});

for (const mode of ["incremental", "deferred"] as const) {
  Deno.test(`factory: ${mode} makes an import and a SPARQL update searchable`, async () => {
    const sdk = await sdkWith(mode);
    await sdk.import({
      source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
    });
    assertEquals((await sdk.search({ query: "needle" })).results?.length, 1);
    await sdk.sparql({
      query: `INSERT DATA { <urn:c> <urn:p> "Second needle here" }`,
    });
    assertEquals((await sdk.search({ query: "needle" })).results?.length, 2);
  });
}
