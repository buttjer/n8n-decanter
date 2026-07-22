# Plan 33 — Post-MCP-pivot wave: PR #97 review results, triage ratification, `test` verb, guard-proxy stack

**Priority:** P1 (Tasks 1–3) / P2 (Tasks 4–7)
**Status:** In progress (execution started 2026-07-22) — unblocked 2026-07-22:
the gate (**PR #97**,
`feat/plan-32-mcp-native-code-layer`, the Plan 32 execution) merged to main as
`3c77f2a`. The execution **review is DONE** (2026-07-22, 16-agent audit+verify
pass over the PR diff — see Notes → Review method); its results are folded into
the tasks below. Plan 32 / [DONE-32](DONE-32-mcp-native-code-layer.md) itself
stays untouched.
**Theme:** Everything queued behind the MCP pivot, now grounded in the *actual*
execution: re-express the lifecycle verbs the execution kept on REST
(**decided**: `archive` replaces `delete`; `duplicate` dropped — revised
2026-07-22 from "goes MCP"), fix the
defects and close the test debts the review found, then ship the follow-up
wave — the `test` verb, the guard-proxy stack, and the `simulate` keep/drop
decision.
**Model:** Opus for the proxy/`test` design and the refresh-race fix; Sonnet for
the mechanical hardening + docs/test passes.

## Why

Plan 32 executed as PR #97 (56 files, +3820/−2576). A full multi-agent review of
the diff (each finding adversarially re-verified) answered the review-gate
questions this plan originally carried, so the gate is replaced by its
**outcome** (below). What remains is: the maintainer's override of the two
places the execution stayed on REST (decided 2026-07-22: MCP `archive`
replaces `delete`; `duplicate` dropped — Task 1), a set of
verified defects/debts, and the follow-up features that only make sense on
the MCP foundation.

## Source

- Session 2026-07-22 (Plan 32 review with the maintainer; memory note
  `plan32-execution-review-checklist` — superseded by this file).
- **PR #97** — the Plan 32 execution under review (merged 2026-07-22 →
  [DONE-32](DONE-32-mcp-native-code-layer.md)).
- [Plan 30](OPEN-30-agent-llm-working-ergonomics.md) — precedence-override
  lineage (Task 4 rewrites it proxy-first) and "override, not fork".
- [Plan 0](BACKLOG.md) — decanter-native code-node authoring skill (deferred,
  distinctive-features group); Python `pythonCode` loophole relates to
  [Plan 28](OPEN-28-python-code-nodes.md).

## Review outcome (PR #97, 2026-07-22) — the former "review gate", now answered

**Verified satisfied** (all claims re-derived from the diff by an independent
verifier; not repeated as tasks):

- **Push guards carried over intact.** `lib/validate.mts` + `lib/compile.mts`
  are byte-identical to main; missing-file / marker-in-`.js` / import-in-`.js`
  are hard errors via `assertCompliant` before any network write; TS
  compile-failure aborts; the typecheck gate still runs pre-push; the per-node
  drift guard survives with `--force` as the only bypass. A `//@file:`
  placeholder **cannot** reach the instance through push — payloads are built
  from files only, and the MCP op vocabulary has no full-workflow write. Sync
  hashes are recorded from a post-write confirming **read**.
- **Pull/snapshot invariant holds.** `workflow.json` is a read-only snapshot;
  every JS Code node's `jsCode` is placeholdered on every pull path. The
  `.remote.js` conflict flow is deleted wholesale: plain-`.js` divergence is
  overwritten with a "recover via git" warning; TS conflicts warn and point at
  `status --diff`; pull still re-baselines (next push overwrites surfaced
  remote edits by design).
- **`node create` / `node rename` / `rename` re-expressed** as MCP
  `addNode` / `renameNode` / `setWorkflowMetadata` + embedded pull; node ids
  stay the identity anchor (unicode rename with stable id smoke-verified on
  the real container).
- **API-optional landed.** OAuth-first `init` (browser consent →
  `.decanter-auth.json`, gitignored, 0600, rotated), `N8N_MCP_TOKEN` paste
  fallback for non-TTY, `N8N_API_KEY` optional with verb-naming
  `requireApiKey` errors. Verb→backend table verified: MCP = pull, push
  (+`--publish`), status, watch, publish/unpublish, create, rename,
  node create/rename, list `--remote`, picker; API-only = executions fetch,
  data-tables fetch, delete; **both** = duplicate (REST clone + MCP pull-back).
- **Process held.** PLAN.md rewritten (not patched); README / docs site /
  CHANGELOG **Breaking** entries consistent with the code (one small gap in
  Task 6); template `AGENTS.md.example` carries the boundary contract
  (files+push for Code-node source; structure via MCP/skills; knowledge skills
  recommended, build skills subordinated) — **assuming direct instance MCP
  access**, which Task 4 rewrites proxy-first.
- **MCP smoke tests EXIST and are real:** 28 steps against the pinned
  n8n 2.30.7 container — availability gate (refusal + `toggle-access` admit),
  draft-first push (activeVersionId untouched), `push --force --publish`
  against a genuine second client with a webhook proving the forced code live,
  unicode `node rename` id-stability, watch-to-draft, full
  create→push→publish→unpublish→delete lifecycle. (~8 of the 28 are REST-side
  steps — executions/data-tables/tags/pinData.)

**Diverged from the maintainer's standing decisions** — `delete` stayed a REST
hard delete; `duplicate` stayed the lossless REST clone; `create` skips
`validate_workflow`. The maintainer **overrode** all three on 2026-07-22 →
Task 1 (MCP re-expression; no hard delete in decanter).

**Defects/debts found** → Tasks 2–3.

## Tasks

1. **Re-express lifecycle on MCP — DECIDED (maintainer 2026-07-22, overriding
   the execution's counter-rationales): `archive` replaces `delete`; `duplicate`
   ~~moves to the MCP SDK-code path~~ **dropped** (revised mid-execution, see
   its bullet). No hard delete in decanter.** *(Done 2026-07-22.)*
   - **`archive` replaces `delete` (Breaking: verb removed).** Drop the REST
     hard-delete verb entirely; new `archive` verb on MCP `archive_workflow`
     (same confirmation gate: TTY y/N naming workflow+id, non-TTY refuses
     without `--force`; local folder kept, stale `decanter.config.json` entry
     flagged — carry the executed `delete` UX over). Permanent removal is
     deliberately **out of decanter's surface** — docs point at the n8n UI for
     hard deletion. Touches: dispatcher + completion, `lib/lifecycle.mts`
     (replace `api.deleteWorkflow` + its "Plan 32 decision" rationale block),
     `docs/cli/delete.md` → `docs/cli/archive.md`, README, overview,
     **Breaking:** changelog entries (removed `delete`, added `archive`),
     PLAN.md decision update. Side effect: the `docs/cli/overview.md`
     draft-acts grouping nit resolves itself (`archive` genuinely isn't a
     draft act either — give it its own annotation).
   - **`duplicate`: DROPPED entirely (decision revised mid-execution,
     maintainer 2026-07-22).** The original re-base plan (generate SDK code →
     `validate_workflow` loop → `create_workflow_from_code`, fidelity gate on
     pull-back) hit a fork at execution time: the only faithful generator is
     n8n's own `@n8n/workflow-sdk` npm package (`generateWorkflowCode`,
     verified working) — but it is Sustainable-Use-licensed and drags a
     ~20 MB dependency tree (incl. `n8n-workflow`) into the MIT CLI for one
     verb, while a hand-rolled emitter risks silently-wrong wiring (the
     restricted DSL has no documented explicit-connection syntax). Since a
     **full JSON copy is impossible over MCP** (no full-JSON create tool),
     the maintainer chose to drop the verb rather than keep the API
     dependency or accept either bridge. The n8n UI duplicates natively;
     decanter pulls the copy. Same win stands: the API-only surface shrinks
     to `executions` + `data-tables` fetches.
   - **Route `create` through `validate_workflow`** — done standalone (the
     duplicate loop it was meant to reuse no longer exists): the minimal
     `workflow('<slug>','<name>')` expression passes the server gate before
     `create_workflow_from_code`; errors + `hint` surface verbatim. Makes
     AGENTS.md's "must pass validate_workflow first" spike claim true —
     adjust Task 7 accordingly.
2. **Hardening fixes from the review** (each verified in the diff;
   file:line refs are PR-head):
   - **HIGH — refresh-token race (single-use rotation):** no in-process mutex
     on `#accessToken` and no cross-process coordination — two parallel
     `callTool()`s, or `watch` + a manual `push` sharing `.decanter-auth.json`,
     can both redeem the refresh token; the loser gets `invalid_grant` →
     forced re-`init` (`lib/mcp.mts:369-388`). Fix: shared in-flight refresh
     promise; re-read the auth file before refreshing and prefer a newer
     token; on `invalid_grant` re-read once and retry before surfacing
     re-init; make persists atomic (`.tmp` + `renameSync`, both writers).
   - **Client robustness batch** (`lib/mcp.mts`): guard `tokensFromResponse`
     against a missing `refresh_token` (`:164` — `String(undefined)` today);
     reset `#initialized` when the handshake promise rejects (`:359` — a
     transient failure currently replays for workflows 2..n of a multi-ref run
     and forever in git-less `watch`); try/catch the bare `JSON.parse` on
     non-SSE 200 bodies (`:464` — captive portals surface as raw
     SyntaxError); warn when `search_workflows` returns exactly the limit
     (200, `:492` — silent truncation); map body-read timeouts to the friendly
     message; cap numeric Retry-After; consider a one-shot session
     re-initialize on 404-with-session-id.
   - **Push/pull semantics polish:** fix or implement the dangling
     "`.ts` verified via marker hash below" claim (`lib/push.mts:190` — no
     such check exists; `verifyRoundTrip` skips `.ts`, and the watch path
     never verifies at all — also weakens name-TOCTOU detection); decide the
     `codeDrift` relaxation (undefined `lastPushedHash` and
     remote==local now push/re-baseline unguarded where base flagged drift —
     document or restore); PLAN.md claims "push also sends a body-equal node
     when the remote lacks the marker" but `collectOps` skips on hash equality
     (`push.mts:108`) — the recurring pull warning "the next push overwrites"
     is self-contradicting in that state; either implement or strike both.
   - **UX/guard gaps:** `node rename`'s embedded pull overwrites unpushed
     local `.js` edits on *other* nodes (dirty-check or document "commit
     before node rename"); route node create/rename + rename through the
     `ENABLE_MCP_HINT` path (today they rely on n8n's verbatim server text);
     `init` should append `.decanter-auth.json` to a pre-existing
     `.gitignore` (warn-only today) and the repo root `.gitignore` should
     list it; template/`.env.example` still presents the API key as primary
     with a stale scope list — rewrite for the OAuth-first model.
   - **Snapshot-invariant loopholes (pre-existing, now load-bearing):**
     git-tracked `mocks/<slug>.json` embeds raw executions whose
     `workflowData` carries inline `jsCode` — strip/placeholder it in
     `writeMock` and/or scan `mocks/` in the compliance guard; Python Code
     nodes' `pythonCode` stays inline in `workflow.json` with no placeholder
     and no guard error — at minimum make the guard flag it honestly (full
     extraction is [Plan 28](OPEN-28-python-code-nodes.md)).
   - **Changelog gap:** add the `[Unreleased]` entry for the rewritten
     template contents (AGENTS.md.example contract + `.cursor` rules) — the
     changelog rule names template contents as user-facing.
3. **Close the test debts** (suite verdict: *sufficient to ship the Breaking
   release, with named debts* — three sound layers: unit client coverage, 73
   e2e steps over a faithful dual REST+MCP mock incl. both SSE and plain-JSON
   parser branches, 28 smoke steps on the real container). Priority order:
   *(Items 1–8 done 2026-07-22 except the one sub-item noted in 1; item 9
   decided + implemented — see below.)*
   1. **OAuth consent flow** — the headline TTY auth path ships on **zero
      coverage** (`runOAuthConsent` referenced only by `init`); scripted
      `/mcp-oauth/register|authorize|token` server + the injectable
      `openBrowser` hook (built for tests, used by none): success,
      state-mismatch, error-redirect, consent-timeout, init's
      fall-back-to-paste branch. *(Done except the init fall-back-to-paste
      branch: `createPrompt` binds `process.stdin` directly, so that 4-line
      catch needs a prompt-injection seam in init — deferred as the one
      remaining Task 3 debt rather than refactoring init mid-plan.)*
   2. **429 backoff unit test** — with/without Retry-After then 200; retry
      count, delay source, 5-retry cap. No test at any level sends a 429; the
      code ships on a "verified live" comment.
   3. **Concurrent-refresh test** — two parallel `callTool()`s on an expired
      token (drives the Task 2 HIGH fix).
   4. **401→forceRefresh retry** — server 401s a timestamp-valid cached token;
      assert exactly one refresh then success.
   5. **`requireApiKey` at the CLI surface** — e2e: unset `N8N_API_KEY`, run
      `executions`, assert exit 1 + the verb-naming guidance (unit-covered
      only today).
   6. **Picker red state IO** — an `available:false` entry in
      `test/interactive.mts` (red row, Enter → enable-mcp guidance) + the
      `pickerLoop` warn branch.
   7. **`#rpc` edge branches** — malformed `data:` SSE line, JSON-RPC
      `message.error`, no-response-message, non-401/404/429 status.
   8. **Two cheap smoke assertions** the review found missing: activeVersionId
      is null *after* unpublish on the real container (only the born-unpublished
      case is asserted today), and "workflow.json save pushes nothing" at smoke
      level (only the warning text is asserted; the no-push half lives in e2e).
   9. Decide + pin the ts→js reverse re-pointing story (js→ts is tested twice;
      the reverse is neither tested nor documented — support it or refuse it
      in the guard). *(Decided 2026-07-22: SUPPORTED symmetrically — a
      body-equal push with a stray remote marker still writes, clearing the
      marker; e2e-tested + documented with a "push before pulling again"
      caveat.)* Optional: drive the OAuth kind once against the real
      container via the spike's headless consent, or record bearer-only smoke
      as the accepted contract. *(Optional half not taken: bearer-only smoke
      remains the accepted contract.)*
4. **Guard-proxy stack** — technical enforcement of the Code-node boundary
   (decided 2026-07-22; the landed contract is instructions-only). Three
   layers, shipped together: *(Done 2026-07-22 — hosted as a dedicated
   `mcp serve` verb rather than inside `watch` (single-purpose long-running
   process; watch users run both); per-session secret + gitignored
   `.decanter-proxy.json` discovery file; 10-check `test/guardproxy.mts`
   suite. Smoke coverage on the pinned container is still owed — see
   Acceptance.)*
   - **(a) Local MCP guard-proxy** — decanter as sole token holder; agent MCP
     config points at a localhost proxy forwarding JSON-RPC to
     `POST /mcp-server/http`. Parse **requests only** (`tools/call` →
     `update_workflow`); responses incl. SSE pipe through untouched. Don't
     enumerate op types (the surface churns): flag any `update_workflow` args
     containing a `jsCode` key, fail closed on parse failure. Bind
     `127.0.0.1`; per-session secret; body-size cap. Blast radius is
     availability, not integrity (decanter's own sync never routes through
     it). Host in `watch` or an `mcp serve` mode. Precedent: `lib/proxy.mts`.
     Token custody improves (agent never sees an n8n credential); caveat:
     guardrail-not-jail while credentials live in workspace files —
     OS-keychain storage is the optional hardening.
   - **(b) Slim config-drift detector hooks** — NOT op-inspectors: detect an
     n8n MCP server configured that isn't the decanter proxy → "route through
     the proxy". One shared script (model: `verify.mjs.example`) + thin
     per-harness wiring, same agent variety as n8n-io/skills.
   - **(c) Rewrite the landed template `AGENTS.md.example` override
     proxy-first:** "wire n8n MCP access through the decanter proxy, never the
     instance directly; Code-node source is files + decanter push" — serves
     hook-less harnesses and points agents at the proxy URL.
5. **`test` verb** — instance-side pinned-data run (decided 2026-07-22):
   `n8n-decanter test [workflow…]` wrapping MCP `test_workflow` (synchronous,
   draft, 5-min timeout; trigger/credentialed/HTTP nodes pinned via `pinData`,
   logic nodes run for real). *(Done 2026-07-22 — `lib/testrun.mts` +
   e2e scenario. Deviations: exactly ONE workflow ref per run (simulate
   parity; the selector flags are per-workflow anyway);
   `prepare_test_pin_data` evaluated and NOT used — client-built pins from
   local captures/mocks are reproducible/reviewable, server-generated
   synthetic data is neither; `fixtures/` overrides not consulted (captures
   and mocks only, per this task's own source list). Smoke coverage on the
   real container still owed — see Acceptance.)*
   - **Interface mirrors `simulate`:** pinData from captures
     (`--execution <id>`, default newest) or committed mocks
     (`--mock <slug>`); `--trigger <node>` → `triggerNodeName`. Client-side
     diff vs. capture, exit 1 on divergence; surface the timeout. Evaluate
     `prepare_test_pin_data` for gap scaffolding (à la `mock create`).
   - **Flow:** 1) `status` — drift + publication state; capture `versionId`
     (+ `activeVersionId`) and a per-node jsCode snapshot (byte-exact read).
     2) If local is newer, prompt "What do you want to test?" — *your local
     code* (draft push first — the same op the executed push/watch does;
     drift-guarded, never activates) or *what's on n8n now* (dynamic wording:
     draft==published → "the live workflow"; diverged → "the current n8n
     draft"; `test_workflow` always runs the draft tip). Unpublished → skip
     the prompt, just push (TTY only). 3) Run + diff + result. 4) If pushed:
     keep, or restore via `restore_workflow_version(step-1 versionId)`
     (undocumented on the docs site but real — n8n-io/skills + spike;
     n8n 2.29.0+; re-applies as draft, new history entry, live untouched);
     fallback below 2.29/on failure: write the jsCode snapshot back
     (persisted to a gitignored file, crash-safe; re-check the draft hash
     before reverting). Output states the live version was never affected.
     Note the executed `push --publish` already publishes on a no-op push
     (documented) — `test`'s "keep" branch composes with it.
   - **Non-TTY/agents — NO choice flags:** one flow, two renderings. Non-TTY
     never mutates: tests the draft tip as-is; on local≠draft prints "local
     differs from the draft — tested the draft, not your local code; run
     `n8n-decanter push` first". Choices are verb composition. Selector flags
     (`--execution`/`--mock`/`--trigger`) mirror `simulate` and stay.
   - **Docs:** taxonomy table — `check` = static/offline, `test` =
     instance-side runtime (**the recommended default**, per Task 6),
     `simulate` = local/offline runtime (pre-push/CI/isolation/
     version-rehearsal). Requirements: MCP-backed (OAuth, `availableInMCP`,
     version floor). Docs trio + backlog distinctive-features entry.
6. *(Done 2026-07-22 — the split is documented everywhere simulate appears:
   taxonomy table in docs/cli/test.md, simulate docs + README recommend
   `test` first, template AGENTS.md gained the runtime-checks section.)*
   **`simulate`/Docker: KEEP — DECIDED (maintainer 2026-07-22). `test` becomes
   the primary/recommended way; `simulate` stays as a differentiator
   (potential USP).** The functional case that carried it (legacy ruled out as
   a reason): pre-push verification of uncommitted local state (`test` can
   only run what's on the draft); CI without
   instance/credentials/opt-in/timeout; `--network-none` isolation +
   engine-version rehearsal. Work: document the split everywhere `simulate`
   is introduced — **recommend `test` first** (no Docker, instance-exact
   engine incl. community nodes), reach for `simulate` for
   pre-push/offline/CI/isolation/version-rehearsal — via Task 5's taxonomy
   table, `docs/cli/simulate.md`, the agents docs, and the template
   `AGENTS.md` loop guidance. Keeping it as a USP strengthens the case for
   [Plan 26](OPEN-26-npx-engine-backend.md) (npx backend — drops `simulate`'s
   Docker dependency), which stays independent.
7. **AGENTS.md MCP-facts + docs update pass:** the `validate_workflow` spike
   claim ("must pass validate_workflow first") becomes TRUE once Task 1 routes
   create/duplicate through the loop — verify the wording then, instead of
   softening it; fold in the re-verified
   tooling facts (docs tool reference is NOT exhaustive — version-history
   tools `get_workflow_history`/`get_workflow_version`/
   `restore_workflow_version` are undocumented-but-real, n8n 2.29.0+;
   execution reads `get_execution`/`search_executions`;
   `prepare_test_pin_data`; `publish_workflow(versionId)` = publish a past
   version straight to live — future `publish --version`?; docs count 41 vs.
   the spike's 33). *(Post-merge link hygiene — this file's OPEN-32 refs →
   DONE-32, `plans/README.md` entry 32's stale "awaiting go/no-go" clause —
   done 2026-07-22 with the unblock.)* Minor docs nits from the review: `docs/cli/overview.md`
   groups `delete` under the draft-acts annotation (it's a hard remove);
   README's `check` line lacks `[--no-typecheck]`; `init [dir]` vs
   `init [dir] [--force]` asymmetry.

## Acceptance / verification

- Task 1: `delete` gone, `archive` present (MCP `archive_workflow`), both with
  **Breaking:** changelog entries and the full docs trio; `duplicate` gone
  (**revised decision** — dropped entirely, Breaking changelog entry, docs
  page removed); the API-only surface = `executions` + `data-tables` fetches;
  `create` gated by `validate_workflow`; no surface (code, README, docs,
  PLAN.md, template) left contradicting the decisions.
- Task 2 HIGH fix verified by the Task 3.3 concurrent-refresh test; the
  remaining hardening items each land with a unit/e2e assertion where
  testable.
- Task 3 items 1–8 exist and are green in CI; smoke additions green against
  the pinned container.
- Proxy: an agent wired to it cannot land a `jsCode` write (blocked with an
  instructive error) while structure ops pass; decanter's own sync is
  independent of proxy availability; smoke coverage on the pinned container.
- `test`: full flow verified at the CLI surface (mock MCP server per the
  AGENTS.md recipe + smoke); non-TTY runs provably read-only; restore path
  verified incl. the <2.29 snapshot fallback.
- Docs trio for every user-facing change; **Breaking:** entries where
  applicable; PLAN.md stays truthful (incl. striking or implementing the
  marker-less body-equal push claim).

## Non-goals

- Amending Plan 32/DONE-32 — it executed; this plan reviews and builds on it.
- Forking n8n-io/skills ("override, not fork" stands).
- The decanter-native code-node authoring skill — deferred to
  [Plan 0](BACKLOG.md) (distinctive-features group).
- Full op-inspecting harness hooks — superseded by proxy + slim detectors.
- Python Code-node extraction — [Plan 28](OPEN-28-python-code-nodes.md); only
  the guard-honesty half is in scope here (Task 2).

## Notes

- **Review method (2026-07-22):** 16-agent workflow over the PR #97 diff —
  8 auditors (push gates, pull/snapshot, node verbs, credentials, triage
  conformance, process/docs, `lib/mcp.mts` deep review, test sufficiency),
  each adversarially re-verified by an independent agent re-deriving every
  claim from the code (all 8 audits confirmed, 39 corrections applied to
  their claims — corrections folded into this file's statements).
- **Test-suite verdict (Task 3 context):** sufficient for the Breaking
  release with the named debts. MCP smoke coverage is real: 28 steps on the
  pinned 2.30.7 container, cross-checked through an independent public-API
  second client (the `--force` step edits jsCode via REST PUT and proves the
  forced MCP push wins via webhook execution).
- **Standing MCP facts** (for Tasks 5+7; re-verified 2026-07-22): docs tool
  reference is not exhaustive — n8n-io/skills SKILL.md + a live `tools/list`
  are better inventories. `test_workflow` = synchronous/draft/pinData/5-min;
  `execute_workflow` = async/production → `get_execution`. Version-history
  tools are 2.29.0+ and undocumented on the site. `updateNodeParameters`
  merges; node ids survive renames; `search_workflows` lists everything while
  details/edit are `availableInMCP`-gated; data tables remain add-only (no
  row reads) — Plan 25 stays API-based.
- **CHANGELOG/PLAN.md:** Tasks 4–5 are user-facing (new verb, new proxy
  surface, template contract rewrite) → full docs trio + PLAN.md updates.
  Tasks 2–3 are mostly internal (changelog only where behavior changes, e.g.
  the codeDrift decision). Task 1 may produce a PLAN.md decision note only.
- The agent memory note `plan32-execution-review-checklist` (2026-07-22) is
  the raw session record behind this plan; this file supersedes it.
