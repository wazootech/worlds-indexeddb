import "fake-indexeddb/auto";
import { assertEquals } from "@std/assert";
import { IdbChunkStore, type SearchChunkRecord } from "./idb-chunk-store.ts";

function makeTestChunk(
  quadId: string,
  subject: string,
  value: string,
): SearchChunkRecord {
  return {
    quad_id: quadId,
    subject,
    predicate: "urn:p",
    graph: "urn:g",
    value,
    fts_value: value.toLowerCase(),
  };
}

Deno.test("IdbChunkStore - insert and retrieve chunks", async () => {
  const store = new IdbChunkStore({
    dbName: `chunk-test-${crypto.randomUUID()}`,
  });
  try {
    const chunk1 = makeTestChunk("q1", "urn:s1", "hello world");
    const chunk2 = makeTestChunk("q2", "urn:s2", "foo bar");

    await store.insertChunks([chunk1, chunk2]);

    const all = await store.getAllChunks();
    assertEquals(all.length, 2);

    const count = await store.countChunks();
    assertEquals(count, 2);
  } finally {
    store.close();
  }
});

Deno.test("IdbChunkStore - delete by quad ids", async () => {
  const store = new IdbChunkStore({
    dbName: `chunk-delete-test-${crypto.randomUUID()}`,
  });
  try {
    await store.insertChunks([
      makeTestChunk("q1", "urn:s1", "text1"),
      makeTestChunk("q2", "urn:s2", "text2"),
      makeTestChunk("q1", "urn:s1b", "text1b"), // same quad_id
    ]);

    const deleted = await store.deleteByQuadIds(["q1"]);
    assertEquals(deleted, 2);

    const remaining = await store.getAllChunks();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0]!.quad_id, "q2");
  } finally {
    store.close();
  }
});

Deno.test("IdbChunkStore - getChunksByQuadIds", async () => {
  const store = new IdbChunkStore({
    dbName: `chunk-get-test-${crypto.randomUUID()}`,
  });
  try {
    await store.insertChunks([
      makeTestChunk("q1", "urn:s1", "text1"),
      makeTestChunk("q2", "urn:s2", "text2"),
      makeTestChunk("q3", "urn:s3", "text3"),
    ]);

    const results = await store.getChunksByQuadIds(["q1", "q3"]);
    assertEquals(results.length, 2);
  } finally {
    store.close();
  }
});

Deno.test("IdbChunkStore - clear removes all chunks", async () => {
  const store = new IdbChunkStore({
    dbName: `chunk-clear-test-${crypto.randomUUID()}`,
  });
  try {
    await store.insertChunks([
      makeTestChunk("q1", "urn:s1", "text1"),
      makeTestChunk("q2", "urn:s2", "text2"),
    ]);

    await store.clear();
    const count = await store.countChunks();
    assertEquals(count, 0);
  } finally {
    store.close();
  }
});

Deno.test("IdbChunkStore - insertChunks with empty array is no-op", async () => {
  const store = new IdbChunkStore({
    dbName: `chunk-empty-test-${crypto.randomUUID()}`,
  });
  try {
    await store.insertChunks([]);
    const count = await store.countChunks();
    assertEquals(count, 0);
  } finally {
    store.close();
  }
});
