import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataFactory } from "@wazoo/sparql-engine";
import { IndexeddbStore } from "@/indexeddb/rdfjs-store/indexeddb-store.ts";
import { pageStoredQuads } from "@/indexeddb/rdfjs-store/page-quads.ts";

const { namedNode, literal, defaultGraph, quad } = DataFactory;

async function storeWith(count: number): Promise<IndexeddbStore> {
  const store = new IndexeddbStore({ dbName: `page-${crypto.randomUUID()}` });
  for (let i = 0; i < count; i++) {
    await store.applyPatch({
      insertions: [
        quad(
          namedNode(`urn:s${i}`),
          namedNode("urn:p"),
          literal(`v${i}`),
          defaultGraph(),
        ),
      ],
      deletions: [],
    });
  }
  return store;
}

/** walk pages through the store and returns each page's quad count. */
async function walk(store: IndexeddbStore, pageSize: number) {
  const sizes: number[] = [];
  const subjects: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await pageStoredQuads(store, { after, pageSize });
    sizes.push(page.quads.length);
    subjects.push(...page.quads.map((q) => q.subject.value));
    if (page.next === undefined) break;
    after = page.next;
  }
  return { sizes, subjects };
}

test("pageStoredQuads walks every quad once, in key order, one page at a time", async () => {
  const store = await storeWith(5);
  const all = (await store.getQuads()).map((q) => q.subject.value).sort();
  const { sizes, subjects } = await walk(store, 2);
  assert.deepStrictEqual(sizes, [2, 2, 1]);
  assert.deepStrictEqual([...subjects], [...subjects].sort());
  assert.deepStrictEqual(subjects, all);
});

test("pageStoredQuads ends on a full last page without an extra empty one", async () => {
  const store = await storeWith(4);
  assert.deepStrictEqual((await walk(store, 2)).sizes, [2, 2]);
  assert.deepStrictEqual((await walk(store, 4)).sizes, [4]);
  assert.deepStrictEqual((await walk(store, 100)).sizes, [4]);
});

test("pageStoredQuads on an empty store returns one empty last page", async () => {
  const store = await storeWith(0);
  assert.deepStrictEqual(await pageStoredQuads(store, { pageSize: 3 }), {
    quads: [],
  });
});
