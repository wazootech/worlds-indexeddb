<p align="center">
  <a href="https://docs.wazoo.dev">
    <img src="https://wazoo.dev/assets/wazoo.svg" alt="Wazoo Worlds" width="120" />
  </a>
  <br /><br />
  <em>IndexedDB durable backend for Worlds — RDF/JS quad store, hybrid search, and SDK factory, browser-native.</em>
  <br /><br />
  <a href="https://jsr.io/@worlds/indexeddb"><img src="https://jsr.io/badges/@worlds/indexeddb" alt="JSR" /></a>
  <a href="https://github.com/wazootech/worlds-indexeddb"><img src="https://img.shields.io/badge/GitHub-black?logo=github" alt="GitHub" /></a>
</p>

**Status: parity-green, hybrid search.** `IndexedDbStore` is a real RDF/JS store
over IndexedDB (cursor-streamed `match()`, atomic transactions) and
`createIndexeddbSdk` wires the full Worlds SDK facade. When a `textSplitter` is
provided, the SDK uses `IndexedDbSearchIndex` for JS-side hybrid search (TF-IDF
keyword scoring + cosine vector similarity, fused with RRF k=60). The phase-4
parity suite passes the shared corpus against the in-memory reference
(`@worlds/sdk/memory`). The storage layout and match() access-path strategy are
recorded on
[sparql-engine#163](https://github.com/wazootech/sparql-engine/issues/163) (map
#162); the corpus/parity definition lives on
[workspace#72](https://github.com/wazootech/workspace/issues/72).

IndexedDB is the browser's durable, local-first backend for the
[`@worlds`](https://jsr.io/@worlds) ecosystem — the same role `@worlds/sqlite`
plays server-side, packaged per the per-backend convention (`@worlds/libsql`,
`@worlds/postgres`, `@worlds/sqlite`).

## Install

```bash
deno add jsr:@worlds/indexeddb
```

## Usage

### Basic: quad store + SPARQL

```typescript
import { IndexedDbStore } from "@worlds/indexeddb/rdfjs-store";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";

const store = new IndexedDbStore({ dbName: "wazoo-playground" });
const engine = new WazooSparqlEngine({
  store,
  createTransaction: () => store.createTransaction(),
});

const result = await engine.execute({
  query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
});
```

### Full client: quad store + hybrid search + SPARQL

```typescript
import { createIndexeddbSdk } from "@worlds/indexeddb/sdk";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// Pass a textSplitter to enable hybrid search (TF-IDF + cosine, RRF k=60).
// Without textSplitter, falls back to scan-based keyword search.
const sdk = await createIndexeddbSdk({
  dbName: "wazoo-playground",
  textSplitter: new RecursiveCharacterTextSplitter({ chunkSize: 1000 }),
});

await sdk.import({
  source: {
    kind: "serialized",
    data:
      `<http://example.com/alice> <http://example.com/knows> <http://example.com/bob> .`,
    contentType: "text/turtle",
  },
});

const { search, sparql } = await Promise.all([
  sdk.search({ query: "alice" }),
  sdk.sparql({
    query:
      `SELECT ?o WHERE { <http://example.com/alice> <http://example.com/knows> ?o }`,
  }),
]);
```

## Development

```bash
deno task ci
```

## Design notes

- **Zero runtime dependencies** — the IndexedDB API is a browser builtin; the
  only npm/JSR imports are type-only (`@rdfjs/types`) and dev/test-only
  (`fake-indexeddb` powers the test substrate — Deno has no native IndexedDB).
- **Storage layout (sparql-engine#163)** — one object store keyed by a composite
  quad key (the four position term keys joined by NUL), with per-position
  indexes; quads differing only by graph never collide.
- **match() access-path selection** — each bound position index is counted and
  the smallest is scanned, with the remaining positions filtered by
  `sameRdfTerm` (System R selection, the engine's `probeQuadIndex` idea).
- **True atomicity for free** — buffered patches (SPARQL updates, SDK imports)
  apply inside a single IndexedDB readwrite transaction: crash-safe and durable
  by construction; `applyPatch` clears first for replace-mode imports.
- **Term identity** — row keys use the engine's `termKey` scheme, vendored
  in-repo and pinned by `term-key-parity.test.ts`, like `@worlds/sqlite`.
- **Hybrid search (phase 2)** — when a `textSplitter` is provided,
  `createIndexeddbSdk` uses `IndexedDbSearchIndex` for JS-side TF-IDF keyword
  scoring + cosine vector similarity, fused with Reciprocal Rank Fusion (k=60,
  matching the libsql reference). Without a `textSplitter`, falls back to the
  scan-based `RdfjsSearchIndex`.
- **Async surface** — IndexedDB is inherently asynchronous: `match()` returns an
  async cursor-backed RDF/JS stream (the engine and SDK already read async
  streams), `countQuads()`/`getQuads()` return promises, and `size` is a live
  count refreshed after each write transaction.
