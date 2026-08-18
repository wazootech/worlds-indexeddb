<p align="center">
  <a href="https://docs.wazoo.dev">
    <img src="https://wazoo.dev/assets/wazoo.svg" alt="Wazoo Worlds" width="120" />
  </a>
  <br /><br />
  <em>IndexedDB durable backend for Worlds — RDF/JS quad store and SDK factory, browser-native.</em>
  <br /><br />
  <a href="https://jsr.io/@worlds/indexeddb"><img src="https://jsr.io/badges/@worlds/indexeddb" alt="JSR" /></a>
  <a href="https://github.com/wazootech/worlds-indexeddb"><img src="https://img.shields.io/badge/GitHub-black?logo=github" alt="GitHub" /></a>
</p>

**Status: scaffold.** The package skeleton compiles; `IndexedDbStore` and
`createIndexeddbSdk` are type-safe stubs whose methods throw. The design is
tracked by
[map #162 — local-first SPARQL playground](https://github.com/wazootech/sparql-engine/issues/162)
on the `wazootech/sparql-engine` tracker.

IndexedDB is the browser's durable, local-first backend for the
[`@worlds`](https://jsr.io/@worlds) ecosystem — the same role `@worlds/sqlite`
plays server-side, packaged per the per-backend convention (`@worlds/libsql`,
`@worlds/postgres`, `@worlds/sqlite`).

## Install

```bash
deno add jsr:@worlds/indexeddb
```

## Usage (once implemented)

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

Or through the SDK factory:

```typescript
import { createIndexeddbSdk } from "@worlds/indexeddb/sdk";

const sdk = await createIndexeddbSdk({ dbName: "wazoo-playground" });
await sdk.import({ format: "text/turtle", data: ttl });
```

## Development

```bash
deno task ci
```

## Design notes

- **Zero runtime dependencies** — the IndexedDB API is a browser builtin; the
  only npm/JSR imports are type-only (`@rdfjs/types`) and dev/test-only.
- **API parity** — the store surface mirrors `SqliteStore` 1:1 so the engine's
  `createTransaction` hook and the W3C parity suites apply unchanged.
- **True atomicity for free** — buffered patches apply inside a single IndexedDB
  readwrite transaction: crash-safe and durable by construction.
- **Term identity** — row keys use the engine's `termKey` scheme (currently
  re-exported; to be vendored in-repo with a parity test, like
  `@worlds/sqlite`).
