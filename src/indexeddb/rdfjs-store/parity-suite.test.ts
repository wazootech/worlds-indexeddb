/**
 * Phase-4 parity suite (workspace#69/#70, #72) — consumes the shared
 * @worlds/sdk/testing harness with the zero-dependency in-memory reference
 * (@worlds/sdk/memory's createMemoryWorldsSdk) against the indexeddb SDK facade
 * (createIndexeddbWorldsSdk over the real IndexeddbStore).
 *
 * Every candidate factory call uses a fresh, uniquely-named database so no
 * state leaks between cases or between the round-trip's two stores.
 *
 * Search ordering is compared set-wise (strictSearchOrder: false):
 * scan-based keyword search order is a store implementation detail, not a
 * parity contract.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parityCorpus, runParitySuite } from "@worlds/sdk/testing";
import { createMemoryWorldsSdk } from "@worlds/sdk/memory";
import type { WorldsSdkInterface } from "@worlds/sdk";
import { createIndexeddbWorldsSdk } from "@/indexeddb/sdk/mod.ts";

let dbCounter = 0;
function createFreshIndexeddbWorldsSdk(): Promise<WorldsSdkInterface> {
  return createIndexeddbWorldsSdk({
    dbName: `parity-${crypto.randomUUID()}-${dbCounter++}`,
  });
}

test(
  "parity suite - @worlds/indexeddb agrees with the in-memory reference on the full corpus",
  async () => {
    const report = await runParitySuite({
      reference: () => createMemoryWorldsSdk(),
      candidate: () => createFreshIndexeddbWorldsSdk(),
      strictSearchOrder: false,
    });

    assert.deepStrictEqual(
      report.results.length,
      parityCorpus.fixtures.length + parityCorpus.replaceCases.length,
      "every corpus fixture and replace case runs on both stores",
    );
    assert.deepStrictEqual(
      report.ok,
      true,
      report.results
        .map(
          (r) =>
            `${r.name}: ${r.failures.join("; ")}` +
            `${r.notes ? ` [notes: ${r.notes.join("; ")}]` : ""}`,
        )
        .join("\n"),
    );

    // The reference-gated fixtures must be clean on both stores — any
    // divergence there is a real parity break, not a declared-category note.
    const referenceGated = report.results.filter(
      (r) => r.name !== "rdfStarWorld",
    );
    for (const result of referenceGated) {
      assert.deepStrictEqual(
        result.ok,
        true,
        `${result.name}: ${result.failures.join("; ")}`,
      );
      assert.deepStrictEqual(
        result.notes,
        undefined,
        `${result.name} must have no notes`,
      );
    }
  },
);
