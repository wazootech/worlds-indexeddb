/**
 * Hybrid Search — TF-IDF keyword search + cosine vector similarity over IndexedDB.
 *
 * Run:
 *   deno task ci          # from the repo root (runs all tests including examples)
 *   deno run --allow-all examples/hybrid-search/main.ts
 */
import "fake-indexeddb/auto";
import { createIndexeddbSdk } from "../../src/indexeddb/sdk/mod.ts";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// USE lite runs entirely in-browser via TF.js — no API key, no server.
// The model (~6 MB) downloads from TF Hub on first use and is cached.
import { UniversalSentenceEncoderEmbeddingService } from "./vendor/universal-sentence-encoder-embedding-service.ts";

const embeddingService = new UniversalSentenceEncoderEmbeddingService();

// textSplitter enables TF-IDF keyword search over chunked literals.
// embeddingService adds 512-d cosine vector similarity — both together
// give hybrid search fused with Reciprocal Rank Fusion (k=60).
// Without either, falls back to scan-based keyword search.
const sdk = await createIndexeddbSdk({
  dbName: `hybrid-search-${crypto.randomUUID()}`,
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
  embeddingService,
  vectorDimensions: 512,
});

// Import some triples.
await sdk.import({
  source: {
    kind: "serialized",
    data:
      `<http://example.com/alice> <http://example.com/knows> <http://example.com/bob> .
<http://example.com/bob> <http://example.com/name> "Bob" .
<http://example.com/carol> <http://example.com/knows> <http://example.com/dave> .
<http://example.com/dave> <http://example.com/name> "Dave" .`,
    contentType: "text/turtle",
  },
});

// Search for "alice" — combines TF-IDF keyword scoring + cosine vector similarity.
const searchResult = await sdk.search({ query: "alice" });
console.log("Search results for 'alice':"); // Search results for 'alice':
for (const r of searchResult.results ?? []) {
  console.log(`  [${r.score?.toFixed(3)}] ${r.text}`);
  //  [0.xxx] <http://example.com/alice> <http://example.com/knows> <http://example.com/bob> .
}

// SPARQL query.
const sparqlResult = await sdk.sparql({
  query:
    `SELECT ?o WHERE { <http://example.com/alice> <http://example.com/knows> ?o }`,
});
console.log("\nSPARQL results:"); // SPARQL results:
if (sparqlResult.kind === "select") {
  for (const row of sparqlResult.data.results.bindings) {
    console.log(`  ${row.o.value}`); //   http://example.com/bob
  }
}

console.log("\nDone."); // Done.
