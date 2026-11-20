import { assert } from "@std/assert";
import { runCommitConformanceSuite } from "@worlds/sdk/testing";
import { createIdbSubject } from "./idb-test-support.ts";

Deno.test("IndexedDB commit path passes the shared conformance suite", async () => {
  const report = await runCommitConformanceSuite({
    create: createIdbSubject,
    contract: {
      // Quads and chunks are separate IndexedDB transactions, so a failure
      // between them leaves quads without chunks (never the reverse).
      atomic: false,
      embeddingFailure: "degrades",
      // applyPatch clears and writes in one readwrite transaction.
      replaceImportFailure: "keeps-old-graph",
      // Commits never touch chunks unless searchIndexOnImport is set.
      defaultSearchIndexOnImport: "disabled",
    },
  });
  const failed = report.results.filter((r) => !r.ok);
  assert(
    report.ok,
    failed.map((r) => `${r.name}: ${r.failures.join("; ")}`).join("\n"),
  );
});
