import { assert } from "@std/assert";
import { IndexedDbStore } from "./rdfjs-store/mod.ts";
import { createIndexeddbSdk } from "./sdk/mod.ts";

Deno.test("stub surface is exported and constructible", () => {
  assert(typeof IndexedDbStore === "function");
  assert(typeof createIndexeddbSdk === "function");
  // The stub constructor is inert; methods throw until map #162 is resolved.
  const store = new IndexedDbStore({ dbName: "wazoo-playground" });
  assert(store.options.dbName === "wazoo-playground");
});
