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

Deno.test("a chunk write that fails after the quads are stored leaves quads without chunks, and reindex repairs it", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService,
  });
  s.failNextChunkWrite();
  await assertRejects(
    () => s.commit({ insertions: [hello], deletions: [] }),
    Error,
    "injected chunk write failure",
  );
  assertEquals((await s.storedQuads()).length, 1);
  assertEquals((await s.chunkedQuadIds()).length, 0);
  await s.index.reindex();
  assertEquals(await s.chunkedQuadIds(), [hashQuad(hello)]);
});

Deno.test("the default mode never touches chunks on commit", async () => {
  const s = await createIdbSubject({ embeddingService });
  await s.commit({ insertions: [hello], deletions: [] });
  assertEquals((await s.storedQuads()).length, 1);
  assertEquals((await s.chunkedQuadIds()).length, 0);
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

Deno.test("an embedding failure stores keyword-only chunks", async () => {
  const s = await createIdbSubject({
    searchIndexOnImport: "incremental",
    embeddingService: {
      embed: () => Promise.reject(new Error("embedding service unavailable")),
    },
  });
  await s.commit({ insertions: [hello], deletions: [] });
  const [chunk] = await s.chunkStore.getAllChunks();
  assertEquals(chunk?.vector, undefined);
  assertEquals(chunk?.fts_value, "hello world");
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

Deno.test("factory: with the option unset an import is not searchable until reindex", async () => {
  const sdk = await sdkWith();
  await sdk.import({
    source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
  });
  assertEquals((await sdk.search({ query: "needle" })).results?.length, 0);
  await sdk.reindex();
  assertEquals((await sdk.search({ query: "needle" })).results?.length, 1);
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
