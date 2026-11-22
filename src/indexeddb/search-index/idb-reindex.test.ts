import "fake-indexeddb/auto";
import type * as rdfjs from "@rdfjs/types";
import { assertEquals } from "@std/assert";
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
  Deno.test(`reindex with readPageSize ${pageSize} keeps counts and rows identical`, async () => {
    const s = await createIdbSubject({ embeddingService });
    await s.store.applyPatch({ insertions: quads, deletions: [] });
    assertEquals(await s.index.reindex({ readPageSize: pageSize }), {
      processedQuadCount: 6,
      chunkRowCount: 5,
    });
    const all = await stored(s);
    assertEquals(all.length, 5);
    assertEquals(await s.index.reindex({ ...scope, readPageSize: pageSize }), {
      processedQuadCount: 6,
      chunkRowCount: 3,
    });
    assertEquals(await stored(s), all);
  });
}

Deno.test("reindex over a store that is not an IndexeddbStore slices one read", async () => {
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
  assertEquals(await index.reindex({ readPageSize: 2 }), {
    processedQuadCount: 6,
    chunkRowCount: 5,
  });
  assertEquals((await stored(s)).length, 5);
});
