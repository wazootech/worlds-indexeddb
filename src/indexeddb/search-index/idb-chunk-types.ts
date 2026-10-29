/** SearchChunkRecord is one persisted search chunk in IndexedDB. */
export interface SearchChunkRecord {
  /** id is the auto-incrementing primary key. */
  id?: number;
  /** quad_id is the content-addressed hash of the originating quad. */
  quad_id: string;
  /** subject is the subject IRI of the originating quad. */
  subject: string;
  /** predicate is the predicate IRI of the originating quad. */
  predicate: string;
  /** graph is the graph IRI of the originating quad. */
  graph: string;
  /** value is the chunk's text content (object literal value or split portion). */
  value: string;
  /** fts_value is the lowercased, tokenized text for keyword scoring. */
  fts_value: string;
  /** vector is the optional Float32Array embedding stored as a plain number array. */
  vector?: number[];
}

/** IdbChunkStoreOptions configures the chunk store. */
export interface IdbChunkStoreOptions {
  /** dbName is the IndexedDB database name (shared with the quad store). */
  dbName: string;
  /** chunkStoreName is the object store name for chunks (defaults to "search_chunks"). */
  chunkStoreName?: string;
}
