import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CommitConformanceContract,
  runCommitConformanceSuite,
} from "@worlds/sdk/testing";
import {
  createIdbSubject,
  type IdbSubject,
  type IdbSubjectExtra,
} from "./idb-test-support.ts";

// The converged contract: the same defaults as the SQL backends, and an atomic
// commit because quads and chunks share one IndexedDB transaction.
const contract: CommitConformanceContract = {
  atomic: true,
  embeddingFailure: "throws",
  // applyPatch clears and writes in one readwrite transaction.
  replaceImportFailure: "keeps-old-graph",
  defaultSearchIndexOnImport: "incremental",
  // Atomic, so a failed later write restores the prior state by rollback.
  laterWriteFailure: "restores-prior-state",
};

const laterWriteCase = "later-write failure follows the contract";

for (const [label, extra] of [
  ["a rejected applyPatch", {}],
  [
    "a chunk write failing inside the transaction",
    {
      failInsideTransaction: true,
    },
  ],
] as [string, IdbSubjectExtra][]) {
  test(`IndexedDB commit path passes the shared conformance suite (${label})`, async () => {
    const subjects: IdbSubject[] = [];
    const report = await runCommitConformanceSuite({
      create: async (options) => {
        const subject = await createIdbSubject(options, extra);
        subjects.push(subject);
        return subject;
      },
      contract,
    });
    const failed = report.results.filter((r) => !r.ok);
    assert(
      report.ok,
      failed.map((r) => `${r.name}: ${r.failures.join("; ")}`).join("\n"),
    );

    // The later-write case must run (a skipped case leaves `results` and adds a
    // note), and its injected failure must follow the quad puts, or it is vacuous.
    assert(
      report.results.some((r) => r.name === laterWriteCase && r.ok),
      `the "${laterWriteCase}" case did not run: ${report.notes?.join("; ")}`,
    );
    assert.deepStrictEqual(report.notes, undefined);
    const failures = subjects.flatMap((subject) =>
      subject.laterWriteFailures.map((puts) => ({
        puts,
        quadStore: subject.store.storeName,
      })),
    );
    assert.deepStrictEqual(failures.length, 1);
    const { puts, quadStore } = failures[0]!;
    assert.deepStrictEqual(puts, [quadStore, quadStore]);
  });
}
