import type { SparqlEngineInterface } from "@wazoo/sparql-engine";
import { WazooSparqlEngine } from "@wazoo/sparql-engine";
import { Sdk, type SdkInterface } from "@worlds/sdk";
import { RdfjsQuadStore } from "@worlds/sdk/rdfjs";
import { RdfjsSearchIndex } from "@worlds/sdk/rdfjs";
import { IndexedDbStore } from "@/indexeddb/rdfjs-store/mod.ts";

/**
 * IndexeddbSdkOptions configures createIndexeddbSdk.
 *
 * The exact surface follows the org convention (`createSqliteSdk` precedent,
 * backends aligning on the `*Sdk` suffix): the store's options plus an
 * optional pre-wired SPARQL engine.
 */
export interface IndexeddbSdkOptions {
  /** IndexedDB database name backing the quad store. */
  dbName: string;

  /** Object store name for quads (defaults to "quads"). */
  storeName?: string;

  /**
   * SPARQL engine to wire as the SDK's sparqlEngine. Defaults to a
   * WazooSparqlEngine over the IndexedDbStore with its `createTransaction`
   * hook, so SPARQL updates commit atomically (one IDB readwrite
   * transaction per update).
   */
  queryEngine?: SparqlEngineInterface;
}

/**
 * createIndexeddbSdk assembles a Worlds SDK facade over an IndexedDB-backed
 * quad store: the SDK's RdfjsQuadStore (imports route through the store's
 * applyPatch, one readwrite transaction per patch), a scan-based
 * RdfjsSearchIndex over the store, and a WazooSparqlEngine wired through
 * the store's createTransaction hook.
 */
export async function createIndexeddbSdk(
  options: IndexeddbSdkOptions,
): Promise<SdkInterface> {
  const store = new IndexedDbStore({
    dbName: options.dbName,
    storeName: options.storeName,
  });
  // Open the database up front so the returned Sdk is ready to use and the
  // factory settles only once the store exists.
  await store.openDb();
  return new Sdk({
    quadStore: new RdfjsQuadStore({ store }),
    sparqlEngine: options.queryEngine ??
      new WazooSparqlEngine({
        store,
        createTransaction: () => store.createTransaction(),
      }),
    searchIndex: new RdfjsSearchIndex(store),
  });
}
