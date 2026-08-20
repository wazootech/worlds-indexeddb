/**
 * Hello World — basic quad store + SPARQL over IndexedDB.
 *
 * Run:
 *   deno task ci          # from the repo root (runs all tests including examples)
 *   deno run --allow-all examples/hello-world/main.ts
 */
import "fake-indexeddb/auto";
import { IndexedDbStore } from "../../src/indexeddb/rdfjs-store/mod.ts";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { DataFactory } from "@wazoo/sparql-engine";

const { namedNode, literal, quad } = DataFactory;

// Create a fresh store backed by IndexedDB.
const store = new IndexedDbStore({ dbName: "hello-world" });

// Wire a SPARQL engine over the store.
const engine = new WazooSparqlEngine({
  store,
  createTransaction: () => store.createTransaction(),
});

// Import some quads.
const triples = [
  quad(
    namedNode("http://example.com/alice"),
    namedNode("http://example.com/knows"),
    namedNode("http://example.com/bob"),
  ),
  quad(
    namedNode("http://example.com/bob"),
    namedNode("http://example.com/name"),
    literal("Bob"),
  ),
];

for (const q of triples) {
  store.addQuad(q);
}
await store.flush();

console.log(`Imported ${store.size} quads.`); // Imported 2 quads.

// Query with SPARQL.
const result = await engine.execute({
  query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
});

console.log("SPARQL results:"); // SPARQL results:
if (result.kind === "select") {
  for (const row of result.data.results.bindings) {
    console.log(`  ${row.s.value} ${row.p.value} ${row.o.value}`);
    //   http://example.com/alice http://example.com/knows http://example.com/bob
    //   http://example.com/bob http://example.com/name "Bob"
  }
}

// Clean up the database.
const dbReq = indexedDB.deleteDatabase("hello-world");
await new Promise<void>((resolve, reject) => {
  dbReq.onsuccess = () => resolve();
  dbReq.onerror = () => reject(dbReq.error);
});

console.log("Done."); // Done.
