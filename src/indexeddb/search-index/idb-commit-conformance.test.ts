import { assert } from "@std/assert";
import {
  type CommitConformanceContract,
  runCommitConformanceSuite,
} from "@worlds/sdk/testing";
import { createIdbSubject, type IdbSubjectExtra } from "./idb-test-support.ts";

// The converged contract: the same defaults as the SQL backends, and an atomic
// commit because quads and chunks share one IndexedDB transaction.
const contract: CommitConformanceContract = {
  atomic: true,
  embeddingFailure: "throws",
  // applyPatch clears and writes in one readwrite transaction.
  replaceImportFailure: "keeps-old-graph",
  defaultSearchIndexOnImport: "incremental",
};

for (
  const [label, extra] of [
    ["a rejected applyPatch", {}],
    ["a chunk write failing inside the transaction", {
      failInsideTransaction: true,
    }],
  ] as [string, IdbSubjectExtra][]
) {
  Deno.test(`IndexedDB commit path passes the shared conformance suite (${label})`, async () => {
    const report = await runCommitConformanceSuite({
      create: (options) => createIdbSubject(options, extra),
      contract,
    });
    const failed = report.results.filter((r) => !r.ok);
    assert(
      report.ok,
      failed.map((r) => `${r.name}: ${r.failures.join("; ")}`).join("\n"),
    );
  });
}
