import type { SparqlEngineInterface } from "@wazoo/sparql-engine";
import type { SdkInterface } from "@worlds/sdk";

/**
 * IndexeddbSdkOptions configures createIndexeddbSdk.
 *
 * The exact surface is pinned by "Pin the createIndexeddbSdk factory surface
 * and package layout" (map #162); this stub follows the org convention
 * (`createDenokvClient({ kv, keyPrefix, queryEngine })`, backends aligning on
 * the `*Sdk` suffix).
 */
export interface IndexeddbSdkOptions {
  /** IndexedDB database name backing the quad store. */
  dbName: string;

  /** Object store name for quads (defaults to "quads"). */
  storeName?: string;

  /**
   * SPARQL engine to wire as the SDK's sparqlEngine. Defaults to a
   * WazooSparqlEngine over the IndexedDbStore once the store is implemented.
   */
  queryEngine?: SparqlEngineInterface;
}

/**
 * createIndexeddbSdk assembles a Worlds SDK facade over an IndexedDB-backed
 * quad store.
 *
 * SCAFFOLD STUB — throws until the store exists (map #162). The real
 * implementation wires `Sdk` from `@worlds/sdk` with a quadStore (reusing the
 * SDK's import/export-via-transaction machinery) and the sparqlEngine
 * (WazooSparqlEngine over IndexedDbStore via its `createTransaction` hook).
 */
export function createIndexeddbSdk(
  _options: IndexeddbSdkOptions,
): Promise<SdkInterface> {
  throw new Error("createIndexeddbSdk: not implemented yet (map #162)");
}
