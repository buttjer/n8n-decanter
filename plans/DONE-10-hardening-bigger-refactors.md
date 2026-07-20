# Plan 10 — Hardening: bigger refactors & decision-gated work

| | |
|---|---|
| **Priority** | P2 (task 7: P3) |
| **Status** | Done (2026-07-18; task 7 deferred by user decision) |
| **Theme** | The half of the tests/stability/refactoring work that changes user-visible behavior, needs design care because existing copies deliberately diverge, or needs a user decision / real-world checking before starting. The no-brainer half is [Plan 9](DONE-9-tests-stability-refactoring.md), which should land first — its unit tests are the safety net for the refactors here. |

## Why

Plan 9 covers everything that is clearly right as-is. What remains falls into
three buckets that shouldn't be rushed:

- **Behavior changes**: request timeouts can abort legitimately slow pushes;
  `status` exit-code semantics affect scripts that call it; a debug/verbose
  switch adds CLI surface.
- **Diverged duplicates**: the kebab-rename machinery (`lib/pull.mts`
  `resolveNodeFile` vs `lib/rename.mts` `renameNodeFile`) and the
  `code/`-parent context lookup (`lib/watch.mts`, `lib/run.mts`,
  `scripts/typecheck.mts`) are *near*-copies whose differences are partly
  intentional — unifying them is a small design task, not a mechanical move.
- **Decisions / prerequisites**: CI needs a "do we want GitHub Actions?"
  answer; the watch refactor should coordinate with Plan 5's in-flight
  proxy/watch work; the e2e harness migration only makes sense after Plan 9's
  `node:test` experience.

## Source

Split out of [Plan 9](DONE-9-tests-stability-refactoring.md) (2026-07-18,
same user request: "more tests, stability and refactoring" — this file holds
the "bigger things / decision making / checking beforehand" part). No Plan 0
entry graduates here.

## Tasks

1. **Network timeouts** — `AbortSignal.timeout` on the two fetch sites:
   `N8nApi.#request` (`lib/api.mts`) and init's credential probe
   (`lib/init.mts`), so a hung instance can't hang the CLI forever.
   **Check beforehand**: how long a PUT of a large real-world workflow takes
   (live instance) — a too-tight default would abort legitimate pushes.
   **Decide**: default value, and whether it's fixed or a config knob (a knob
   changes the config surface → PLAN.md, raise first). CHANGELOG: Added.
2. **`status` exit codes** — today `status` always exits 0 unless the command
   itself fails, even on CONFLICT. **Decide with the user**: should
   drift/CONFLICT exit non-zero (CI-friendly, like `check`)? Scripts calling
   `status` would see the change. CHANGELOG: Changed (possibly Breaking).
3. **Debug switch for error output** — `main().catch` (`n8n-decanter.mts`)
   prints one line and swallows the stack, which hurts exactly when an
   unexpected TypeError escapes. **Decide**: `DEBUG=1` env vs a `--verbose`
   flag (new CLI surface either way). CHANGELOG: Added.
4. **Unify the kebab-rename machinery** — one helper for "wanted kebab name +
   collision suffix + rename file and `.remote.js` sibling, never across
   extensions", shared by `resolveNodeFile` (`lib/pull.mts`) and
   `renameNodeFile` (`lib/rename.mts`). The copies already diverge: pull
   silently keeps an existing target (remote is authoritative), rename throws
   on a double collision (user must resolve). Unify deliberately, preserving
   each caller's documented behavior — Plan 9's A-tests plus the existing e2e
   rename/migration steps are the net.
5. **Testable `watch` + node-file context resolver** (one work package —
   both reshape the same call sites):
   - `watchFile` (`lib/watch.mts`) returns a handle (`{ close() }`) that
     closes the `fs.watch`, timers, and (Plan 5) proxy; the CLI entry awaits
     forever as before. Today it awaits a never-resolving promise and is
     untestable.
   - Shared "locate `.decanter.json` / `workflow.json` for a node file,
     looking one level above `code/`" resolver (in `lib/state.mts`) adopted
     by watch, `lib/run.mts` `findNode`, and `scripts/typecheck.mts`
     `isNodeFile`. The three lookups have slightly different semantics
     (extension filters, state vs workflow.json resolution) — needs a small
     design pass, not a copy-paste move.
   - Then add the missing tests: watch debounce coalescing and the
     queued-while-running re-push (real file writes against a stub api), and
     the proxy's WebSocket-upgrade round-trip (raw TCP echo upstream).
   - **Coordinate with [Plan 5](DONE-5-browser-refresh-after-push.md)**: its
     in-flight watch/proxy integration touches the same code.
6. **CI workflow** — GitHub Actions running `npm run typecheck` + `npm test`
   on push/PR. The e2e suite binds a localhost port, which GH runners allow.
   **Decide with the user first**: the repo has no `.github/` today — is
   GitHub Actions wanted, or is CI hosted elsewhere / unwanted?
7. **(P3) e2e migration to `node:test`** — sequential subtests in the same
   single stateful file for better reporting and `--test-name-pattern`,
   without pretending steps are independent (they aren't, by design). Only if
   Plan 9's `node:test` harness proves pleasant; the `CLAUDE.md` testing
   notes (sequential stateful scenario, async exec) stay true either way.

## Acceptance / verification

- Each behavior change (1–3) ships with its CHANGELOG entry and an e2e or
  unit test pinning the new behavior; decisions recorded in this plan (and
  PLAN.md where the config surface or documented flows change).
- Refactors (4–5) keep `npm test` green with no assertion changes beyond
  deliberately moved message strings; watch/WebSocket gain their first tests.
- CI (6), if wanted, runs green on a fresh clone.

## Notes

- **CHANGELOG**: 1 & 3 → Added; 2 → Changed (flag **Breaking:** if scripts
  plausibly rely on exit 0); 4/5/7 internal/test-only → no entries; 6 → no
  entry (infra).
- **PLAN.md**: a timeout config knob (1) or new `status` exit semantics (2)
  touch documented surfaces → raise before implementing, per `CLAUDE.md`.
  4/5 don't alter the data model or flows.
- **Ordering**: land after (or interleaved behind) Plan 9 — its unit tests
  are the safety net here. Task 5 should sequence with Plan 5's remaining
  work to avoid churning `lib/watch.mts` twice.

## Decisions & outcome (2026-07-18)

All decisions taken with the user in one round; implemented same day.

1. **Timeouts: 30 s default + `requestTimeoutMs` config knob** (no live
   measurement was possible, so conservative-default-plus-knob won).
   Implemented in `N8nApi.#request` via `AbortSignal.timeout` (also covers
   body streaming); timeout errors name the knob. Init's credential probe is
   fixed at 10 s — no config exists at init time, and the probe is non-fatal.
2. **`status` exits 1 on conflict/remote drift** — CONFLICT, remote-only
   structure/code changes, remote nodes unknown locally or deleted remotely,
   and not-pulled-yet all count; local-only "push pending" and a missing
   local file do not (normal dev state / local problem). `statusWorkflow`
   returns `{ remoteDrift }`; the dispatcher maps it to the exit code.
   CHANGELOG carries the **Breaking:** entry.
3. **Debug switch: `DEBUG=1` env var** (no new CLI surface) — `main().catch`
   prints `err.stack` when set, the one-line message otherwise.
4. **Kebab-rename unified** as `renameNodeFilePair` in `lib/state.mts`; the
   deliberate divergences stayed at the callers: pull keeps its per-pull
   `usedNames` collision set (remote is authoritative, skipped renames are
   silent), rename keeps its on-disk collision check with the double-collision
   throw.
5. **Watch returns a `WatchHandle`** (`close()` shuts watchers, debounce
   timer, and proxy; the CLI keeps awaiting forever). Shared
   `nodeFileContextDir(filePath, marker)` in `lib/state.mts` adopted by
   `run.mts findNode` (marker `workflow.json`) and `scripts/typecheck.mts
   isNodeFile` (marker `.decanter.json`); watch's own lookup is inverse
   (id → dir) and stayed. New tests: e2e watch step (debounce coalescing,
   queued-while-running re-push, close()), proxy WebSocket-upgrade
   round-trip against a raw TCP echo upstream.
6. **CI** — already satisfied by Plan 13's `.github/workflows/ci.yml`
   (typecheck + tests, Node 22/24 matrix); nothing to do here.
7. **e2e `node:test` migration deferred** by user decision — the custom step
   runner stays.
