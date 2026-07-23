# Plan 22 — Test suite depth: interactive coverage + Docker version matrix

| | |
|---|---|
| **Priority** | P2 |
| **Status** | Done (2026-07-20) — all six tasks landed; see "Outcome" below |
| **Theme** | Grow the automated suite where it's genuinely thin — the interactive surfaces no test drives today (picker terminal IO, watch conflict prompts, watch↔proxy wiring) and a handful of uncovered CLI branches — and make the Docker smoke suite actually prove the "n8n 2.x" claim across versions while flaking less. Reduce the monolithic e2e's coupling so adding tests doesn't compound its fragility. |
| **Model** | **Sonnet** — testability refactors (injectable streams/prompts) and test authoring against a clear spec; the fiddly parts (keypress/stream simulation, harness step-filtering, the Docker version matrix) are engineering, not research. High-volume, well-defined work where a strong coder is the efficient pick. |

## Why

The suite is strong but has shape problems and blind spots:

- **The e2e is one sequential, stateful scenario** (`test/e2e.mts`, ~54 steps /
  1240 lines against an in-process mock): each step builds on the previous, a
  mid-chain failure cascades into confusing downstream asserts, and no step
  runs in isolation (documented in `CLAUDE.md`). Every test added raises that
  maintenance tax.
- **Whole surfaces are untested by CI, by design.** The interactive picker's
  terminal IO (`runPicker` / `pickerLoop`) is marked "TTY only, untested by
  CI" in `lib/picker.mts` — only the pure state machine is unit-tested
  (`test/unit/picker.test.mts`). The watch **conflict prompt** branches
  (`[m]`/`[l]`/`[r]`/Enter in `resolveConflict`, `lib/watch.mts`) are exercised
  only in the *non-TTY skip* path (smoke) — never the interactive answers. The
  **watch↔proxy wiring** (watch booting `startProxy`, switching `editorOrigin`,
  a single-node push firing `notifyPushed` → SSE) is untested: `test/proxy.mts`
  covers the proxy in isolation, not watch driving it.
- **The Docker smoke suite is pinned to one n8n version** (`n8nio/n8n:2.30.7`
  in `test/smoke-n8n.mts`). `SMOKE_N8N_TAG` exists but CI runs a single tag, so
  the tool's "n8n 2.x only" contract is asserted against exactly one point
  release. The suite also leans on fixed `sleep()`s around webhook
  registration/activation — a flake source.

## Source

- User request (2026-07-20): "a plan for more e2e tests, also test including
  more of the embedded n8n in docker if that makes sense."
- Builds on [Plan 9](../done/9-tests-stability-refactoring.md) (unit tests +
  coverage gaps), [Plan 10](../done/10-hardening-bigger-refactors.md) (watch
  testability), [Plan 12](../done/12-structural-watch.md) (structural watch), and
  [Plan 15](../done/15-docker-n8n-smoke-suite.md) (Docker smoke).

## Design decision — what belongs where (mock e2e vs real-n8n smoke)

The user's "if that makes sense" for Docker deserves an explicit rule, so tests
don't drift to the wrong layer:

- **Mock e2e / pty (fast, in `npm test`):** decanter's *own* logic — CLI
  surface, data-model transforms, guard rules, error branches, and interactive
  keystroke handling. Deterministic; no Docker.
- **Docker smoke (opt-in, real engine):** anything whose truth only the real
  n8n knows — bundled code executing in the task-runner sandbox, PUT
  normalization, publish semantics, tags/pinData persistence, API response
  shapes, and **version-specific** behavior.
- **Rule of thumb:** *if the mock could lie about it, it's a smoke test; if
  it's decanter's own behavior, it's mock e2e.* New interactive tests are mock
  e2e/pty — a real n8n adds nothing to keystroke handling and only slows it.

## Tasks

1. **Harness: selective execution + legible cascades** (`test/harness.mts`).
   - Add a name filter to `createStepRunner` (e.g. a `STEP=<substring>` env or
     argv) so one step/scenario runs in isolation while debugging; the suite
     still runs everything by default.
   - Track failures so steps depending on the shared-state chain print
     `skipped (prerequisite "<name>" failed)` instead of cascading opaque
     asserts. Keep the single shared mock (it's what makes e2e fast) — this is
     legibility + runnability, **not** a rewrite into per-test isolation.

2. **pty-free interactive picker tests** (new `test/interactive.mts`, added to
   the `npm test` command). Biggest untested surface.
   - **Refactor:** make `runPicker` accept injectable `{ input, output }`
     streams, defaulting to `process.stdin`/`process.stdout` (no behavior
     change — the CLI path is untouched). This is what lets a test drive it
     without a real pty or a new dependency (the project's zero-dep rule).
   - **Drive it** with in-memory streams: push synthetic keypress sequences
     through `emitKeypressEvents` on a `PassThrough`, capture the writable's
     output. Cover the loop the unit tests skip: filter → up/down → Enter into
     the verb menu → Enter runs; Esc-back, Esc-quit, Ctrl-C interrupt (exit
     130), stdin-EOF quit, raw-mode/cursor restore on every exit, the remote
     promise appending rows, and `resume` re-opening a workflow's menu.
   - Optionally extract `pickerLoop` from `n8n-decanter.mts` into `lib/` so the
     session loop (remote cache, per-verb dispatch, exit code) is testable too.

3. **Watch conflict-prompt branches** (extend the mock e2e watch coverage).
   - **Refactor:** let `watchWorkflow` take an optional prompt factory
     (defaulting to `createPrompt`) so a test supplies canned answers — same
     injectability idea as task 2, no new dep.
   - Assert the three resolutions against the mock: `[m]` writes
     `workflow.remote.json` with `//@file:` placeholders substituted only where
     remote code still matches the last sync; `[l]` force-pushes over remote;
     `[r]` pulls over the local file; Enter skips and re-prompts on the next
     save. Pure decanter behavior → mock is authoritative, no Docker.

4. **Watch↔proxy integration** (mock, offline).
   - Start `watchWorkflow` with `browserReload: "proxy"` against the mock,
     connect an SSE client to the proxy, save a `code/` file, and assert a
     `pushed` event with the right `workflowId` arrives and the deep-link log
     uses `http://127.0.0.1:<port>/workflow/<id>`. Closes the seam between
     `test/proxy.mts` (proxy alone) and the watch push path.

5. **Fill remaining mock-e2e branch gaps.** Each grounded in existing code:
   - `init` credential-probe outcomes: ok / non-2xx / unreachable-timeout →
     the three distinct log lines (`lib/init.mts`).
   - Multi-workflow partial failure: push/pull/status over several ids where
     one fails → `[i/n]` progress, per-item error, overall exit 1, the rest
     still processed (`n8n-decanter.mts` dispatch loop).
   - `resolveRef` remote fallback for `pull` (unknown name resolved via `GET
     /workflows`) and the ambiguous-name error.
   - `executions`: numeric-arg-as-execution-id routing and `--limit`/`--status`
     bound validation.

6. **Docker smoke: version matrix + de-flake** (extends Plan 15).
   - **Version matrix:** run the existing suite over a small list of 2.x tags
     (an oldest-supported, a middle, and latest) via `SMOKE_N8N_TAG`; the CI
     `smoke` job (cron + dispatch only) becomes a matrix over those tags.
     Record the passing set in the suite header. **This is what actually tests
     the "n8n 2.x only" claim** and the highest-value smoke item.
   - **De-flake:** replace the fixed `sleep()`s around webhook
     registration/activation with bounded polling (the suite already polls for
     health/readiness — extend that pattern). Cuts wall time and spurious
     failures.
   - **Diagnosable bootstrap:** the owner-setup/login/api-key bootstrap is the
     version-fragile part (already flagged in-code). On a new version where its
     shape changed, fail with a version-specific message so it's obvious the
     *bootstrap*, not decanter, broke.
   - Stays opt-in and off the merge gate (unchanged).

## Non-goals (answering "if it makes sense" for Docker)

- **Dockerizing keystroke/TTY handling** (picker, prompts) — a real n8n adds
  nothing and only slows it; mock + injected streams is correct.
- **Dockerizing guard/validation/rename/JSON-transform logic** — decanter's own
  code; the mock is authoritative and deterministic.
- **Putting Docker on the PR merge gate** — too heavy/slow/flaky; the weekly
  cron + manual dispatch stays the model.
- **A full per-test-isolation rewrite of `test/e2e.mts`** — the shared mock is
  a feature (speed); task 1 fixes legibility, not the architecture.

## Acceptance / verification

- `npm test` gains `test/interactive.mts` (picker) plus watch-conflict and
  watch↔proxy steps; all green **offline** (localhost port bind + injected
  streams; no Docker, no pty dependency).
- A single step runs in isolation via the filter; a mid-chain failure reports
  skipped dependents instead of an opaque cascade.
- `npm run test:smoke` passes against **≥2** pinned 2.x tags; the CI smoke job
  runs the matrix; activation waits are polled, not slept.
- The previously-untested `runPicker` loop, watch conflict prompts, and
  watch↔proxy wiring are demonstrably covered.

## Notes

- **No new runtime or test dependencies, no pty dep** — the interactive tests
  work by making `runPicker`/`watchWorkflow` stream/prompt **injectable**
  (defaults unchanged). Injectability is a testability refactor, not a behavior
  change → no CHANGELOG entry (internal), except any user-visible flag.
- The step filter and skip-on-prerequisite are harness-internal → no CHANGELOG.
- **PLAN.md:** the "e2e is one sequential scenario" note and the smoke suite's
  version-matrix scope are test-infrastructure facts — update them when this
  lands (unasked, per `CLAUDE.md`'s PLAN.md rule). A new user-facing config
  field or flag would need raising with the user first.
- **Ordering:** tasks 1–5 are offline and independent of task 6 (Docker), which
  can run in parallel. Task 2 (picker) is the single highest-value item — the
  largest surface with zero CI coverage today.
- **Ties in:** when [Plan 20](../done/20-cli-publish-lifecycle.md)'s
  publish/unpublish verbs land, add their activate/deactivate assertions to the
  smoke suite; [Plan 7](../done/7-engine-true-simulation-suite.md)'s `simulate`
  keeps its own `test:sim` — don't fold it in here.

## Outcome (2026-07-20)

All six tasks landed in one PR (following the Plan 9/10 convention of one PR
per plan batch), `npm test` green (63 e2e + 10 proxy + 12 interactive + 151
unit), typecheck green, and the Docker smoke suite verified locally against
all three matrix tags before landing.

1. **Harness** — `STEP=<substring>` (env or `--step=`) filter, plus
   skip-on-prerequisite-failure (a mid-chain failure no longer
   `process.exit()`s immediately; every step after it is marked `skip
   ... (prerequisite "<name>" failed)`, and the run still reaches its
   `finally`/cleanup code with the process exiting via `process.exitCode`).
   Verified both mechanisms directly and against the real suite.
2. **Picker terminal IO** — `runPicker` takes injectable `input`/`output`
   streams (`PickerInputStream`/`PickerOutputStream`, defaults unchanged);
   `test/interactive.mts` (12 checks) drives it via `PassThrough` +
   `emitKeypressEvents` — filter/arrows/enter into the verb menu, unpulled-entry
   direct pull, esc-back/esc-quit, ctrl-c, stdin EOF, raw-mode/cursor restore
   on every exit path, the remote promise resolving/rejecting, resume, and the
   notice line. **Deferred**: extracting `pickerLoop` out of
   `n8n-decanter.mts` into `lib/` was explicitly optional in this plan and
   was skipped — `runPicker` (the untested surface this plan targeted) is
   fully covered without it.
3. **Watch conflict prompt** — `watchWorkflow` takes an optional
   `promptFactory` (default `createPrompt`; `lib/prompt.mts` now exports the
   `Prompt` type). Passing one explicitly also bypasses the
   `!process.stdin.isTTY` skip, since a test deliberately supplying answers
   isn't the "no one is there to answer" case that skip guards. Four new
   `test/e2e.mts` steps assert `[m]`/`[l]`/`[r]`/Enter against real structural
   conflicts on the mock.
4. **Watch↔proxy** — one `test/e2e.mts` step: `browserReload: "proxy"`
   against the mock, a raw SSE client on the proxy, a `code/` save, asserting
   the `pushed` event (with `workflowId`) and that the logged editor deep-link
   uses the proxy's port, not the raw upstream host.
5. **Branch gaps** — init's non-2xx and unreachable credential-probe outcomes
   (the "verified" case already had coverage); a multi-workflow partial
   failure ([i/n] progress, per-item error, exit 1, rest still processed);
   `resolveRef`'s remote-list fallback for `pull` plus the ambiguous-prefix
   error; `executions --limit`'s upper bound (250). `--status` has no bound
   validation in the code (arbitrary pass-through filter) — nothing to add there.
6. **Docker smoke** — `webhook()` now polls (12 × 750ms, ~9s budget) instead
   of a fixed pre-sleep at every call site; the bootstrap step (owner
   setup/login/api-key — the version-fragile, undocumented-REST-endpoint
   part) names the image tag in every assertion so a version-bump failure
   reads as "this version's bootstrap shape changed", not "decanter broke".
   `.github/workflows/ci.yml`'s `smoke` job (still cron + dispatch only, off
   the merge gate) is now a matrix over three tags — **verified locally
   against real containers**: `n8nio/n8n:2.30.7` (oldest supported — the
   floor Plan 18's pinData seeding needs), `2.31.0` (middle), `2.31.4`
   (latest at verification time, from the n8n GitHub releases list). Passing
   set recorded in `test/smoke-n8n.mts`'s header comment.
