import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("a chunk write that fails after the quad puts aborts the whole commit", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [other], deletions: [] });
  s.failNextChunkWrite();
  await assert.rejects(() =>
    s.commit({ insertions: [hello], deletions: [other] })
  );
  // Neither the new quad, nor the deletion, nor the chunk changes landed.
  assert.deepStrictEqual((await s.storedQuads()).map((q) => q.subject.value), [
    "urn:b",
  ]);
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(other)]);
  // The failure is not sticky: the same commit now succeeds.
  await s.commit({ insertions: [hello], deletions: [other] });
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

test("a failed replace import keeps the old graph and its chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  s.failNextChunkWrite();
  await assert.rejects(
    () =>
      s.commit({ insertions: [other], deletions: [] }, {
        importMode: "replace",
      }),
    /injected chunk write failure/,
  );
  assert.deepStrictEqual((await s.storedQuads()).map((q) => q.subject.value), [
    "urn:a",
  ]);
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

test("the default mode is incremental: a commit writes quads and chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  assert.deepStrictEqual((await s.storedQuads()).length, 1);
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

test("disabled never touches chunks on commit; only reindex writes them", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "disabled",
    embeddingService,
  });
  await s.commit({ insertions: [hello], deletions: [] });
  assert.deepStrictEqual((await s.storedQuads()).length, 1);
  assert.deepStrictEqual((await s.chunkedQuadIds()).length, 0);
  await s.index.reindex();
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

test("a re-inserted quad keeps exactly one chunk row", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  await s.commit({ insertions: [hello], deletions: [hello] });
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

test("a replace import drops the chunks of the wiped graph", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService,
  });
  await s.commit({ insertions: [hello], deletions: [] });
  await s.commit({ insertions: [other], deletions: [] }, {
    importMode: "replace",
  });
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(other)]);
  assert.deepStrictEqual((await collectQuads(s.store)).length, 1);
});

test("deleting a quad drops its chunks", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService,
  });
  await s.commit({ insertions: [hello, other], deletions: [] });
  await s.commit({ insertions: [], deletions: [hello] });
  assert.deepStrictEqual(await s.chunkedQuadIds(), [hashQuad(other)]);
});

test("embeddings use the original text while keyword text is lowercased", async () => {
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
  assert.deepStrictEqual(seen, ["Hello World"]);
  const [chunk] = await s.chunkStore.getAllChunks();
  assert.deepStrictEqual(chunk?.fts_value, "hello world");
  assert.deepStrictEqual(chunk?.value, "Hello World");
  assert(chunk?.vector?.length === 32);
});

const failingEmbeddings: EmbeddingService = {
  embed: () => Promise.reject(new Error("embedding service unavailable")),
};

test("an embedding failure throws and writes nothing", async () => {
  const s = await createIdbSubject({ embeddingService: failingEmbeddings });
  await assert.rejects(
    () => s.commit({ insertions: [hello], deletions: [] }),
    /failed to vectorize/,
  );
  assert.deepStrictEqual((await s.storedQuads()).length, 0);
  assert.deepStrictEqual((await s.chunkedQuadIds()).length, 0);
});

test("a reindex whose embedding fails keeps the existing chunks", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  const broken = await createIdbSubject({
    embeddingService: failingEmbeddings,
  });
  await broken.store.applyPatch({ insertions: [hello], deletions: [] });
  await broken.chunkStore.insertChunks(await s.chunkStore.getAllChunks());
  await assert.rejects(
    () => broken.index.reindex(),
    /failed to vectorize/,
  );
  assert.deepStrictEqual(await broken.chunkedQuadIds(), [hashQuad(hello)]);
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

test("factory: with the option unset an import is searchable at once (incremental)", async () => {
  const sdk = await sdkWith();
  await sdk.import({
    source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
  });
  assert.deepStrictEqual(
    (await sdk.search({ query: "needle" })).results?.length,
    1,
  );
});

test("factory: disabled keeps an import unsearchable until reindex", async () => {
  const sdk = await sdkWith("disabled");
  await sdk.import({
    source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
  });
  assert.deepStrictEqual(
    (await sdk.search({ query: "needle" })).results?.length,
    0,
  );
  await sdk.reindex();
  assert.deepStrictEqual(
    (await sdk.search({ query: "needle" })).results?.length,
    1,
  );
});

test("factory: a failing embedding service rejects the import and stores nothing", async () => {
  const sdk = await createIndexeddbWorldsSdk({
    dbName: `factory-${crypto.randomUUID()}`,
    textSplitter: wholeLiteral,
    embeddingService: failingEmbeddings,
    vectorDimensions: 32,
  });
  await assert.rejects(() =>
    sdk.import({
      source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
    })
  );
  assert.deepStrictEqual(
    (await sdk.search({ query: "needle" })).results?.length,
    0,
  );
  const all = await sdk.sparql({ query: "SELECT * WHERE { ?s ?p ?o }" });
  assert(!JSON.stringify(all).includes("urn:a"), "no quad may be stored");
});

for (const mode of ["incremental", "deferred"] as const) {
  test(`factory: ${mode} makes an import and a SPARQL update searchable`, async () => {
    const sdk = await sdkWith(mode);
    await sdk.import({
      source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
    });
    assert.deepStrictEqual(
      (await sdk.search({ query: "needle" })).results?.length,
      1,
    );
    await sdk.sparql({
      query: `INSERT DATA { <urn:c> <urn:p> "Second needle here" }`,
    });
    assert.deepStrictEqual(
      (await sdk.search({ query: "needle" })).results?.length,
      2,
    );
  });
}
