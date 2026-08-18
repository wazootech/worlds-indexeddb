// Stub: re-export the engine's term-key scheme while an in-repo copy is
// pending. Worlds' convention (see `@worlds/sqlite`) is to vendor termKey
// in-repo and parity-test it against the published engine so row keys never
// diverge between packages; until this package has a real store, re-exporting
// the canonical implementation keeps the surface type-safe and behaviorally
// identical. TODO(map #162): vendor `src/indexeddb/term/term-key.ts` and add
// the term-key parity suite once "Validate IndexedDbStore transaction and
// update semantics against the W3C parity suites" lands.
export { sameRdfTerm, termKey } from "@wazoo/sparql-engine/term";
