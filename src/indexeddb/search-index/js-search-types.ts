/** SearchResultRow is an intermediate search result before RRF fusion. */
export interface SearchResultRow {
  chunkId: number;
  subject: string;
  predicate: string;
  graph: string;
  value: string;
  keywordRank?: number;
  vectorRank?: number;
  keywordScore?: number;
  vectorScore?: number;
}
