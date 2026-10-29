/**
 * js-search-engine implements JS-side keyword scoring (TF-IDF) and vector
 * similarity (cosine) for the IndexedDB search index. Since IndexedDB has no
 * built-in FTS or vector search, all scoring runs in JS over the chunk store.
 */

export type { SearchResultRow } from "./js-search-types.ts";
export { searchKeyword, tokenize } from "./js-keyword-search.ts";
export { cosineSimilarity, searchVector } from "./js-vector-search.ts";
export { fuseWithRrf, RRF_K } from "./js-rrf.ts";
