# Plan 9 — Test & stability quick wins

| | |
|---|---|
| **Priority** | P1 |
| **Status** | Done (2026-07-18) |
| **Theme** | The no-brainer half of the hardening work: fast unit tests for the pure core, crash-path fixes that only implement already-documented behavior, small scenario-coverage gaps, and trivial dedupes. Everything here is clearly right, fully offline, and needs no user decision — the decision-gated / bigger half lives in [Plan 10](../done/10-hardening-bigger-refactors.md). |

## Why

- **All coverage is scenario-level.** `test/e2e.mts` (one sequential,
  stateful scenario) and `test/proxy.mts` are the only tests. The pure core —
  `splitMarker`, `withMarker`, `kebabCase`, `sanitizeFilename`,
  `findNodeRefs`/`renameNodeRefs`, `stableWorkflowJson`,
  `workflowStructureHash`, `sanitizeForPut`, `driftProblems`, the whole
  validator — has no fast, isolated tests. Every regression must be caught by
  a full subprocess scenario run.
- **A real crash path contradicts PLAN.md.** `readState`
  (`lib/state.mts`) is a raw `JSON.parse`; `listWorkflowDirs` calls it while
  scanning, so **one corrupt `.decanter.json` anywhere under `root` throws a
  raw SyntaxError and breaks every command for every workflow** — pull, push,
  status, check alike. PLAN.md's guard spec lists "missing/corrupt
  `workflow.json` or `.decanter.json`" as a compliance *error*; only the
  workflow.json half is actually implemented (`lib/validate.mts` catches that
  parse, nothing catches the state parse). Fixing this implements documented
  behavior — no design latitude, hence this plan.
- **Documented behaviors are untested**: the true TS conflict branch in pull
  (both sides changed), node-deleted-remotely state cleanup, kebab-name
  collision suffixes, `status`'s remote-drift/CONFLICT/missing-file branches,
  the drift guard's unknown-remote-node case, the proxy's 502 and HEAD paths.
- **Some duplication is pure copy-paste** with no behavioral divergence —
  safe to dedupe mechanically: env parsing (`lib/config.mts` `loadEnv` vs
  `lib/init.mts` `parseEnvFile`), the four-level connection walk
  (`lib/validate.mts` integrity check vs `lib/rename.mts`
  `renameInConnections`), and `//@file:` placeholder slicing repeated in
  push, validate, run, and rename. (The *diverged* duplicates — kebab-rename
  machinery, the `code/`-parent lookup — need design care and moved to
  Plan 10.)

## Source

Direct user request (2026-07-18): "a plan for more tests, stability and
refactoring", split per follow-up into quick wins (this plan) and
decision-gated work ([Plan 10](../done/10-hardening-bigger-refactors.md)).
No Plan 0 entry graduates here. PLAN.md's compliance-guard spec
("Missing/corrupt `workflow.json` or `.decanter.json`") is the reference for
task B1.

## Tasks

### A — Unit-test layer (land before D so dedupes run under green tests)

1. **Adopt `node:test`** (built into Node ≥ 22, zero new deps) for unit
   tests: `test/unit/*.test.mts`, wired into `npm test` as
   `node --test test/unit/` alongside the existing suites. The e2e scenario
   file stays as-is (Plan 10 owns the optional later migration).
2. **`lib/util.mts`** — the highest-value target, all pure:
   - `splitMarker`: marker with trailing whitespace/newline variants, marker
     *not* on the last line must not match, body-keeps-bytes property
     (`hash(splitMarker(withMarker(x).jsCode).body)` equals `withMarker(x).hash`),
     missing trailing newline, marker-only input.
   - `kebabCase`: camelCase/acronym boundaries, Unicode letters, empty →
     `unnamed`; `sanitizeFilename`: reserved chars, control chars, trailing
     dots, empty.
   - `findNodeRefs`/`renameNodeRefs`: escaped quotes, all three quote styles
     preserved on rewrite, `${…}` template refs skipped, `$(var)`/multi-arg
     skipped.
   - `stableWorkflowJson` (stable key order, trailing newline),
     `workflowStructureHash` (key-order invariance, jsCode-stripping,
     insensitive to non-PUT fields), `sanitizeForPut` (settings whitelist,
     `staticData` null dropped).
3. **`driftProblems`** (`lib/push.mts`, pure): unknown remote node, per-node
   hash drift, structure-hash drift, `onlyNodeIds` scoping skips both the
   other nodes and the structure check.
4. **`validateWorkflowDir`/`validateNodeFile`** (`lib/validate.mts`) against
   throwaway temp dirs — one test per error/warning string. Fast (no server,
   no subprocess), and it pins the guard's messages, which push/check/rename
   all surface verbatim.
5. **`loadConfig`/`loadEnv`** (`lib/config.mts`): upward search stops at the
   first config, `.env` never overrides real environment vars, quote
   stripping, defaults (`commitOnPush` true, `proxyPort` 5679,
   `browserReload` off), missing-config error message.

### B — Stability fixes

1. **Corrupt `.decanter.json` must be a guard error, not a crash.**
   - `readState` (`lib/state.mts`) distinguishes *missing* (null) from
     *corrupt* (clear, file-naming error).
   - `listWorkflowDirs`/`findWorkflowDir` tolerate a corrupt state file
     (skip + warn) so **one broken folder can't take down commands for every
     other workflow**.
   - `validateWorkflowDir` reports "corrupt .decanter.json (…)" as an error,
     mirroring its existing corrupt-`workflow.json` handling. Covered by an
     A4 unit test plus one e2e step (C1).
2. **Friendly parse errors elsewhere**: malformed `decanter.config.json`
   (`lib/config.mts` raw `JSON.parse`) and `rename`'s `loadWorkflow`
   (`lib/rename.mts`) should name the offending file instead of leaking a
   bare SyntaxError.
3. **`pushSingleNode`** (`lib/push.mts`): explicit error when `nodeId` has no
   entry in `state.nodes` (today: TypeError on `nodeState.file`).

### C — Coverage gaps in the scenario suites

1. **e2e steps** (`test/e2e.mts`): true TS conflict (local `.ts` *and*
   remote changed → CONFLICT warning + `.remote.js`), node deleted remotely
   (state entry dropped with warning, file kept), kebab collision → second
   node gets the `-<id8>` suffix, push aborts on a remote Code node unknown
   locally, `ensureWorkflowDir`'s rename-target-already-exists warning,
   corrupt `.decanter.json` (B1: scoped guard error, other workflows still
   sync).
2. **`status` branches** (`lib/status.mts`): changed remotely → pull,
   CONFLICT, local file missing, node deleted remotely.
3. **`rename`**: collision fallback filename (`-<id8>`), `.remote.js`
   *content* untouched by ref-rewriting (the sibling rename is covered; the
   content invariant isn't asserted).
4. **Proxy suite** (`test/proxy.mts`): upstream request failure → 502
   plain-text body, HTML without `</body>` → tag appended, HEAD passthrough
   (no injection). (WebSocket-upgrade and watch-loop tests need Plan 10's
   watch refactor and live there.)

### D — Mechanical dedupes (behavior-preserving, under A's green tests)

1. **One env-file parser** shared by `loadEnv` (`lib/config.mts`) and
   `parseEnvFile` (`lib/init.mts`) — same regex today, two copies.
2. **Placeholder helper** — `placeholderFile(node)` (the
   `startsWith`/`slice`/`trim` dance) used by push, validate, run, rename.
3. **Connection iterator** — `forEachConnectionTarget(connections, cb)`
   shared by the validator's integrity check and `renameInConnections`; both
   hand-roll the same four-level nested walk.
4. **Shared step-runner** for the test files — e2e and proxy each hand-roll
   `step()`/counters/exit handling.

## Acceptance / verification

- `npm test` runs unit + e2e + proxy suites, all green; `npm run typecheck`
  green.
- The B1 scenario passes: with one corrupted `.decanter.json` under `root`,
  `check` reports a scoped error for that folder and `pull`/`push`/`status`
  of *other* workflows still work.
- D dedupes are behavior-preserving: no e2e assertion changes except where
  an error-message string deliberately moves (and then the assertion moves
  with it).
- B1/B2/B3 get CHANGELOG entries (Fixed); A/C/D are test/internal-only and
  get none.

## Notes

- **CHANGELOG**: B1/B2/B3 → Fixed. Nothing else.
- **PLAN.md**: B1 implements what PLAN.md already documents — no PLAN.md
  change. D dedupes don't touch the data model or flows.
- **Cross-links**: the decision-gated / bigger siblings live in
  [Plan 10](../done/10-hardening-bigger-refactors.md); C4's proxy additions
  extend [Plan 5](../done/5-browser-refresh-after-push.md)'s in-flight
  `lib/proxy.mts` / `test/proxy.mts`.
