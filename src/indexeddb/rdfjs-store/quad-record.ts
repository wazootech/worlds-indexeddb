import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";
import { termKey } from "@/indexeddb/term/term-key.ts";

/**
 * Lossless, JSON-serializable term encoding — the same scheme
 * `@worlds/sqlite`'s SqliteStore uses for its payload column. Every term is
 * reconstructed exactly: literal language, direction, and datatype are
 * preserved, and RDF-star triple terms (including nested ones) round-trip
 * structurally.
 */
export type TermRecord =
  | { t: "N"; v: string } // NamedNode
  | { t: "B"; v: string } // BlankNode
  | { t: "V"; v: string } // Variable
  | { t: "D" } // DefaultGraph
  | { t: "L"; v: string; lang: string; dir: string; dt: string } // Literal
  | { t: "Q"; s: TermRecord; p: TermRecord; o: TermRecord }; // RDF-star triple term

export function toTermRecord(term: rdfjs.Term): TermRecord {
  switch (term.termType) {
    case "NamedNode":
      return { t: "N", v: term.value };
    case "BlankNode":
      return { t: "B", v: term.value };
    case "Variable":
      return { t: "V", v: term.value };
    case "DefaultGraph":
      return { t: "D" };
    case "Literal":
      return {
        t: "L",
        v: term.value,
        lang: term.language,
        dir: term.direction ?? "",
        dt: term.datatype.value,
      };
    case "Quad":
      return {
        t: "Q",
        s: toTermRecord(term.subject),
        p: toTermRecord(term.predicate),
        o: toTermRecord(term.object),
      };
  }
}

export function fromTermRecord(rec: TermRecord): rdfjs.Term {
  switch (rec.t) {
    case "N":
      return DataFactory.namedNode(rec.v);
    case "B":
      return DataFactory.blankNode(rec.v);
    case "V":
      return DataFactory.variable(rec.v);
    case "D":
      return DataFactory.defaultGraph();
    case "L": {
      // Reconstruct the literal with its datatype; language-tagged strings
      // carry their language (and optional direction for RDF 1.2).
      if (rec.lang) {
        return rec.dir
          ? DataFactory.literal(rec.v, {
            language: rec.lang,
            direction: rec.dir as "ltr" | "rtl",
          })
          : DataFactory.literal(rec.v, rec.lang);
      }
      return DataFactory.literal(rec.v, DataFactory.namedNode(rec.dt));
    }
    case "Q":
      // The engine's quad() types are strict about positions, but RDF 1.2
      // triple terms allow any term in any position (literal subjects
      // included) — cast to the position types, which is always sound here.
      return DataFactory.quad(
        fromTermRecord(rec.s) as rdfjs.Quad_Subject,
        fromTermRecord(rec.p) as rdfjs.Quad_Predicate,
        fromTermRecord(rec.o) as rdfjs.Quad_Object,
      );
  }
}

export function toQuadRecord(quad: rdfjs.Quad): QuadRecord {
  return {
    s: toTermRecord(quad.subject),
    p: toTermRecord(quad.predicate),
    o: toTermRecord(quad.object),
    g: toTermRecord(quad.graph),
  };
}

export function fromQuadRecord(rec: QuadRecord): rdfjs.Quad {
  // Reconstructed positions may be any term (RDF 1.2 quoted triples allow
  // literal subjects); the engine's position types are narrower, so cast.
  return DataFactory.quad(
    fromTermRecord(rec.s) as rdfjs.Quad_Subject,
    fromTermRecord(rec.p) as rdfjs.Quad_Predicate,
    fromTermRecord(rec.o) as rdfjs.Quad_Object,
    fromTermRecord(rec.g) as rdfjs.Quad_Graph,
  );
}

export type QuadRecord = {
  s: TermRecord;
  p: TermRecord;
  o: TermRecord;
  g: TermRecord;
};

/**
 * quadKey renders the composite row key for a quad: the four position term
 * keys joined by NUL. IndexedDB string keys sort lexicographically, so the
 * primary key uniquely identifies the quad exactly as the sqlite store's
 * composite primary key does — quads that differ only by graph never
 * collide.
 */
export function quadKey(quad: rdfjs.Quad): string {
  return [
    termKey(quad.subject),
    termKey(quad.predicate),
    termKey(quad.object),
    termKey(quad.graph),
  ].join("\u0000");
}

/**
 * splitQuadKey reverses quadKey back into the four position keys, mirroring
 * the sqlite store's removeQuadByKey. Position keys cannot contain the NUL
 * separator (termKey never emits one).
 */
export function splitQuadKey(key: string): [string, string, string, string] {
  const parts = key.split("\u0000");
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/** The row shape stored in the IndexedDB object store. */
export interface QuadRow {
  /** composite primary key — quadKey(quad). */
  key: string;
  /** position keys, indexed for match() access-path selection. */
  skey: string;
  pkey: string;
  okey: string;
  gkey: string;
  /** lossless term payload (JSON-serialized QuadRecord). */
  payload: string;
}

export function toQuadRow(quad: rdfjs.Quad): QuadRow {
  return {
    key: quadKey(quad),
    skey: termKey(quad.subject),
    pkey: termKey(quad.predicate),
    okey: termKey(quad.object),
    gkey: termKey(quad.graph),
    payload: JSON.stringify(toQuadRecord(quad)),
  };
}

export function fromQuadRow(row: QuadRow): rdfjs.Quad {
  return fromQuadRecord(JSON.parse(row.payload) as QuadRecord);
}
