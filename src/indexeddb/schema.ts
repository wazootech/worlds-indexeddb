/** DB_VERSION is the one schema version both stores open the database at. */
export const DB_VERSION = 2;

/** QUADS_INDEX_NAMES are the positional indexes on the quad object store. */
const QUADS_INDEX_NAMES = ["skey", "pkey", "okey", "gkey"] as const;

/** SchemaNames names the two object stores the database holds. */
export interface SchemaNames {
  /** quadStoreName is the object store of quads (default "quads"). */
  quadStoreName: string;

  /** chunkStoreName is the object store of search chunks (default "search_chunks"). */
  chunkStoreName: string;
}

/**
 * upgradeSchema creates whichever object stores are missing. IndexeddbStore and
 * IdbChunkStore both call it from `onupgradeneeded` at DB_VERSION, so either can
 * open the database first. Opening them at different versions (quads at 1,
 * chunks at 2) left the second open blocked behind the first one's connection,
 * or failing with a VersionError in the other order.
 */
export function upgradeSchema(db: IDBDatabase, names: SchemaNames): void {
  if (!db.objectStoreNames.contains(names.quadStoreName)) {
    const quads = db.createObjectStore(names.quadStoreName, { keyPath: "key" });
    for (const indexName of QUADS_INDEX_NAMES) {
      quads.createIndex(indexName, indexName);
    }
  }
  if (!db.objectStoreNames.contains(names.chunkStoreName)) {
    const chunks = db.createObjectStore(names.chunkStoreName, {
      keyPath: "id",
      autoIncrement: true,
    });
    chunks.createIndex("quad_id", "quad_id");
  }
}
