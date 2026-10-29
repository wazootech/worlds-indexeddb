# AI agent coding guidelines

## Code health

Family-wide rules live in the
[wazootech workspace constitution](https://github.com/wazootech/workspace/blob/main/AGENTS.md#code-health-standards);
this repo's specifics:

- Before pushing, run `deno task ci` (fmt check, lint, type check, tests).
- Deno type checking is strict by default; do not weaken it.
- The single `deno-lint-ignore no-explicit-any` in
  `src/indexeddb/rdfjs-store/idb-event-emitter.ts` covers a commented
  EventEmitter listener type; keep its explanatory comment and add no new `any`
  without one.
- Actions in `.github/workflows/` are pinned to full commit SHAs, CI pins Deno
  to `v2.9.8`, and installs are frozen (`deno ci`).
- `secret-scan.yml` runs gitleaks on every PR and push to `main`; report
  findings, never suppress them.
- `code-health.yml` enforces the file-length limit (120 lines of code per file,
  300 for tests; a failing step) and warns on TODO/FIXME without an issue link
  without failing the build. Exceptions go in the workflow's allowlist, which
  may only shrink.
- `.github/CODEOWNERS` and `renovate.json` are present; Renovate only acts where
  the org has the Renovate GitHub App installed.
