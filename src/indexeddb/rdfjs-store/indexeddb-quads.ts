import type * as rdfjs from "@rdfjs/types";
import { DataFactory } from "@wazoo/sparql-engine";

/** buildQuad resolves the addQuad overloads into a single quad. */
export function buildQuad(
  quadOrSubject: rdfjs.Quad | rdfjs.Term,
  predicate?: rdfjs.Term,
  object?: rdfjs.Term,
  graph?: rdfjs.Term,
): rdfjs.Quad {
  return predicate !== undefined && object !== undefined
    ? DataFactory.quad(
      // RDF 1.2 allows any term in any position (literal subjects in
      // quoted triples); the engine's position types are narrower, so cast.
      quadOrSubject as rdfjs.Quad_Subject,
      predicate as rdfjs.Quad_Predicate,
      object as rdfjs.Quad_Object,
      graph as rdfjs.Quad_Graph,
    )
    : quadOrSubject as rdfjs.Quad;
}

/** collectQuads drains a quad stream into an array. */
export async function collectQuads(
  stream: rdfjs.Stream<rdfjs.Quad>,
): Promise<rdfjs.Quad[]> {
  const quads: rdfjs.Quad[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (q: rdfjs.Quad) => quads.push(q));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return quads;
}
