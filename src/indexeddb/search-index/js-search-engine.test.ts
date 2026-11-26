import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cosineSimilarity,
  fuseWithRrf,
  RRF_K,
  searchKeyword,
  searchVector,
  tokenize,
} from "./js-search-engine.ts";
import type { SearchChunkRecord } from "./idb-chunk-store.ts";

function assertAlmostEquals(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) <= 1e-10,
    `expected ${actual} to be within 1e-10 of ${expected}`,
  );
}

test("tokenize - splits text into lowercase tokens without stopwords", () => {
  const tokens = tokenize("The quick brown fox jumps over the lazy dog");
  // "the" and "over" are stopwords in the sqlite/libsql reference
  assert.deepStrictEqual(tokens.includes("the"), false);
  assert.deepStrictEqual(tokens.includes("quick"), true);
  assert.deepStrictEqual(tokens.includes("brown"), true);
  assert.deepStrictEqual(tokens.includes("fox"), true);
  assert.deepStrictEqual(tokens.includes("jumps"), true);
  assert.deepStrictEqual(tokens.includes("over"), true);
  assert.deepStrictEqual(tokens.includes("lazy"), true);
  assert.deepStrictEqual(tokens.includes("dog"), true);
});

test("tokenize - handles empty string", () => {
  const tokens = tokenize("");
  assert.deepStrictEqual(tokens.length, 0);
});

test("tokenize - strips punctuation", () => {
  const tokens = tokenize("hello, world! how's it going?");
  assert.deepStrictEqual(tokens.includes("hello"), true);
  assert.deepStrictEqual(tokens.includes("world"), true);
  assert.deepStrictEqual(tokens.includes("going"), true);
});

test("cosineSimilarity - identical vectors returns 1.0", () => {
  const v = [1, 2, 3];
  assertAlmostEquals(cosineSimilarity(v, v), 1.0);
});

test("cosineSimilarity - orthogonal vectors returns 0.0", () => {
  assertAlmostEquals(cosineSimilarity([1, 0], [0, 1]), 0.0);
});

test("cosineSimilarity - zero vector returns 0.0", () => {
  assert.deepStrictEqual(cosineSimilarity([0, 0], [1, 2]), 0.0);
});

test("cosineSimilarity - different length vectors returns 0.0", () => {
  assert.deepStrictEqual(cosineSimilarity([1, 2], [1, 2, 3]), 0.0);
});

function makeChunk(
  id: number,
  quadId: string,
  subject: string,
  predicate: string,
  graph: string,
  value: string,
  vector?: number[],
): SearchChunkRecord {
  return {
    id,
    quad_id: quadId,
    subject,
    predicate,
    graph,
    value,
    fts_value: value.toLowerCase(),
    vector,
  };
}

test("searchKeyword - finds matching chunks by term frequency", () => {
  const chunks = [
    makeChunk(1, "q1", "urn:s1", "urn:p1", "urn:g1", "The quick brown fox"),
    makeChunk(2, "q2", "urn:s2", "urn:p2", "urn:g1", "A lazy brown dog"),
    makeChunk(3, "q3", "urn:s3", "urn:p3", "urn:g1", "A red car drives"),
  ];

  const results = searchKeyword("brown", chunks, 10);
  assert.deepStrictEqual(results.length, 2);
  // Both "brown" chunks should appear
  const subjects = results.map((r) => r.subject);
  assert.deepStrictEqual(subjects.includes("urn:s1"), true);
  assert.deepStrictEqual(subjects.includes("urn:s2"), true);
});

test("searchKeyword - returns empty for no matches", () => {
  const chunks = [
    makeChunk(1, "q1", "urn:s1", "urn:p1", "urn:g1", "hello world"),
  ];
  const results = searchKeyword("xyz", chunks, 10);
  assert.deepStrictEqual(results.length, 0);
});

test("searchKeyword - respects limit", () => {
  const chunks = Array.from({ length: 20 }, (_, i) =>
    makeChunk(i + 1, `q${i}`, `urn:s${i}`, "urn:p", "urn:g", "test query word"),
  );
  const results = searchKeyword("test", chunks, 5);
  assert.deepStrictEqual(results.length, 5);
});

test("searchKeyword - applies subject filter", () => {
  const chunks = [
    makeChunk(1, "q1", "urn:allowed", "urn:p", "urn:g", "test content"),
    makeChunk(2, "q2", "urn:blocked", "urn:p", "urn:g", "test content"),
  ];
  const results = searchKeyword("test", chunks, 10, {
    subjects: ["urn:allowed"],
  });
  assert.deepStrictEqual(results.length, 1);
  assert.deepStrictEqual(results[0]!.subject, "urn:allowed");
});

test("searchVector - finds nearest chunks by cosine similarity", () => {
  const chunks = [
    makeChunk(1, "q1", "urn:s1", "urn:p", "urn:g", "text1", [1, 0, 0]),
    makeChunk(2, "q2", "urn:s2", "urn:p", "urn:g", "text2", [0, 1, 0]),
    makeChunk(3, "q3", "urn:s3", "urn:p", "urn:g", "text3", [0.9, 0.1, 0]),
  ];

  const results = searchVector([1, 0, 0], chunks, 10);
  // Chunk 2 ([0,1,0]) is orthogonal to [1,0,0] → similarity 0 → filtered out
  assert.deepStrictEqual(results.length, 2);
  // Closest to [1,0,0] is chunk 1 (exact match), then chunk 3
  assert.deepStrictEqual(results[0]!.subject, "urn:s1");
  assert.deepStrictEqual(results[1]!.subject, "urn:s3");
});

test("searchVector - skips chunks without vectors", () => {
  const chunks = [
    makeChunk(1, "q1", "urn:s1", "urn:p", "urn:g", "text1", [1, 0]),
    makeChunk(2, "q2", "urn:s2", "urn:p", "urn:g", "text2"), // no vector
  ];
  const results = searchVector([1, 0], chunks, 10);
  assert.deepStrictEqual(results.length, 1);
  assert.deepStrictEqual(results[0]!.subject, "urn:s1");
});

test("searchVector - returns empty for empty query vector", () => {
  const chunks = [
    makeChunk(1, "q1", "urn:s1", "urn:p", "urn:g", "text", [1, 0]),
  ];
  const results = searchVector([], chunks, 10);
  assert.deepStrictEqual(results.length, 0);
});

test("fuseWithRrf - combines keyword and vector results with RRF", () => {
  const keywordResults = [
    {
      chunkId: 1,
      subject: "urn:s1",
      predicate: "urn:p",
      graph: "urn:g",
      value: "text1",
      keywordRank: 1,
    },
    {
      chunkId: 2,
      subject: "urn:s2",
      predicate: "urn:p",
      graph: "urn:g",
      value: "text2",
      keywordRank: 2,
    },
  ];
  const vectorResults = [
    {
      chunkId: 2,
      subject: "urn:s2",
      predicate: "urn:p",
      graph: "urn:g",
      value: "text2",
      vectorRank: 1,
    },
    {
      chunkId: 3,
      subject: "urn:s3",
      predicate: "urn:p",
      graph: "urn:g",
      value: "text3",
      vectorRank: 1,
    },
  ];

  const fused = fuseWithRrf(keywordResults, vectorResults, 10);
  assert.deepStrictEqual(fused.length, 3);

  // Chunk 2 appears in both branches, so its score should be highest
  const chunk2 = fused.find((r) => r.chunkId === 2);
  const chunk1 = fused.find((r) => r.chunkId === 1);
  const chunk3 = fused.find((r) => r.chunkId === 3);
  assert.deepStrictEqual(!!chunk2, true);
  assert.deepStrictEqual(!!chunk1, true);
  assert.deepStrictEqual(!!chunk3, true);

  // Chunk 2 (in both) should have highest score
  assert.deepStrictEqual(chunk2!.keywordScore! > chunk1!.keywordScore!, true);
  assert.deepStrictEqual(chunk2!.keywordScore! > chunk3!.keywordScore!, true);
});

test("fuseWithRrf - RRF_K constant is 60", () => {
  assert.deepStrictEqual(RRF_K, 60);
});
