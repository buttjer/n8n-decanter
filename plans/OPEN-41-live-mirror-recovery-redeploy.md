# Plan 41 — Live snapshot mirror + REST recovery redeploy

**Priority:** P2 (both parts — real design; the live mirror touches the guard's
concurrency, the recovery verb re-adds a REST surface)
**Status:** Not started
**Theme:** Make `workflow.json` earn its keep as a *live, redeployable* record:
(A) keep the snapshot **auto-fresh** after an agent restructures a workflow
through decanter's guarded MCP gateway — no manual `pull`; (B) let that git
snapshot be **redeployed** to a fresh/rebuilt n8n as a **disaster-recovery**
break-glass — losslessly, over the public REST API (the one path that preserves
node ids), framed as recovery, not day-to-day structure sync.
**Model:** Opus for Part A's cross-process concurrency/safety design; Sonnet for
Part B's assemble-and-POST implementation.

## Why

`workflow.json` is a **read-only structure snapshot** (Plan 32): written **only**
by `pull` ([lib/pull.mts](../lib/pull.mts) — `pullWorkflow`, the lone writer at
its tail), `jsCode` swapped for `//@file:` placeholders, never pushed. Two gaps
the maintainer wants closed:

1. **Staleness.** Since #118 reframed workflow structure as *decanter's guarded
   MCP gateway*, agents restructure workflows **through** the guard
   (`mcp connect` stdio / `mcp serve` HTTP — [lib/mcpconnect.mts](../lib/mcpconnect.mts),
   [lib/mcpserve.mts](../lib/mcpserve.mts)). The guard forwards every
   `addNode`/`renameNode`/`addConnection`/`setWorkflowSettings`/… but the local
   snapshot only refreshes on the next **manual** `pull` — so "structure changes
   show up as clean git diffs" lags behind what the agent just did. The gateway
   already sees the mutation and holds decanter's credential; it can refresh the
   mirror itself.

2. **The snapshot is a record but not a *deploy*.** Git holds the full structure
   + every Code node's source, yet there is no way to push that back to a fresh
   n8n if the instance is lost/rebuilt. A break-glass "redeploy this workflow
   from git" turns git into a genuine **second, recovery-grade versioning layer
   outside n8n** — which n8n's own draft/publish history cannot be (it dies with
   the instance).

Both were raised as one backlog item (below) + a research question ("could the
snapshot also be a deployable second versioning layer, preferably `.ts`, fully
deployable over MCP"). A smoke spike (see **Spike findings**) answered the
research question and set Part B's shape.

## Source

- **Plan 0 / BACKLOG.md:** "*Auto-refresh `workflow.json` after structure edits
  over MCP — snapshot freshness without an explicit `pull`*" (2026-07-23). Its
  two proposed variants — (a) guard-proxy-triggered refresh, (b) broader
  auto-pull — and its open design questions (which ops count, debounce/races,
  git churn, draft-vs-tip timing, on-by-default vs opt-in) are resolved here.
  Graduated to this plan.
- **Research + user decisions (2026-07-23):** "research if it could also be a
  deployable snapshot for a second versioning layer outside n8n itself… the mcp
  docs mentioned something about `.ts`, I would even prefer it, as long its fully
  deployable using mcp… lets spike that using a smoke." Spiked against a real
  n8n 2.30.7 in Docker + `@n8n/workflow-sdk` source research. Two decisions:
  - **Ask A → on-by-default live mirror** (not the opt-in default I recommended —
    the maintainer wants the mirror live by default, with safety rails).
  - **Ask B → lossless via REST JSON, framed as recovery in the docs** (not the
    lossy MCP/`.ts` path; not positioned as structure sync).

## Spike findings (n8n 2.30.7; live round-trip + source-verified)

Why Part B is **REST, not MCP `.ts`** — the `create_workflow_from_code` /
`@n8n/workflow-sdk` path is *deployable but lossy and create-only*:

- ✅ **`jsCode` round-trips byte-exact** through `create_workflow_from_code`
  (input `{code}` = a full TS/JS SDK program; `validate_workflow {code}` →
  `{valid,nodeCount}` is the required preflight). Decanter's core asset survives.
- ✅ nodes/types/`typeVersion`/positions/parameters/**connections** faithful for
  linear + the documented control-flow patterns (`.to()/.onTrue()/.input(n)/…`).
- ❌ **Node ids are not expressible in the SDK grammar** and are **regenerated as
  fresh UUIDs on every deploy** (`node()`/`trigger()` configs have no `id`
  slot; the parser mints new ones; `create_workflow_from_code` is
  `idempotentHint:false` → a **new workflow every call**). The SDK/MCP world
  anchors identity on node **name**; decanter anchors on node **id** — a
  fundamental impedance mismatch that breaks the id→file map on each redeploy.
- ❌ **Create-only.** There is **no code-based *update*** — redeploy is always a
  fork/clone to a new workflow id, never in-place structure sync.
- ❌ **Lossy:** workflow `settings` (MCP create **force-sets**
  `executionOrder:'v1'` — confirmed live: a `v0` seed came back `v1`), **tags**,
  **pinData**, and trigger `position` are dropped.
- ⚠️ **A reverse (workflow→code) emitter exists — but only as the
  `@n8n/workflow-sdk` library** (`generateWorkflowCode()` + `json-to-code` CLI),
  **not over MCP** (live `tools/list`: 33 tools, none a `*_code` export tool).
  That library is **n8n Sustainable-Use-Licensed (not MIT), ~124 MB / 127
  packages incl. native `isolated-vm`** — a non-starter as an MIT minimal-dep
  CLI's dependency (the exact Plan 33 blocker, now quantified). Hand-rolling the
  emitter instead means graph→fluent-builder codegen — the "silent wiring
  divergence" risk Plan 33 named.

**Verdict:** "fully deployable over MCP" is **not achievable losslessly**. The
**only lossless redeploy path is REST `POST /api/v1/workflows`**, which
**preserves caller-supplied node ids** (smoke-verified: seed ids `w1/c1/r1`
survive a create). Part B takes that path and frames it narrowly as recovery so
it does not reintroduce day-to-day structure ownership (which stays n8n's job).

Spike artifacts (throwaway, not committed): `create_workflow_from_code {code}`
round-trip, live `tools/list` + `get_sdk_reference` dumps. Container torn down.

## Part A — On-by-default live snapshot mirror

**Behavior.** When an agent's structure edit is **forwarded** through the guard
(a non-blocked `tools/call` → `update_workflow`), the guard schedules a
**debounced background `pull`** of that workflow id, refreshing `workflow.json`
(+ code files + state, incl. rename file-moves) and committing per
`commitOnPull`. On by default; a config escape disables it.

**Why a full `pull`, not a snapshot-only rewrite:** `addNode` must create the
born-empty `code/` file and `renameNode` must move the file
([lib/pull.mts](../lib/pull.mts) owns both). A workflow.json-only rewrite would
leave placeholders pointing at missing/old files and trip the compliance guard.

**Safety rails (what makes default-on acceptable):**

- **Fire-and-forget.** The upstream response is relayed to the agent
  **immediately**; the pull runs in the background and never blocks the agent's
  next tool call.
- **Require git + safety-commit-before-pull.** Skip the mirror (warn once) when
  the sync dir isn't a git repo — mirrors `watch`'s startup rule. Commit any
  dirty working tree *before* pulling so an overwrite of an unpushed `.js` edit
  is always recoverable (reuse `watch`'s "safety commit + pull" via
  [lib/git.mts](../lib/git.mts)).
- **Debounce + overlap guard.** Coalesce a burst of ops (an agent's multi-op
  restructure) into a single pull; never run two pulls for the same workflow
  concurrently (mirror `watch`'s debounce/queue).
- **Tracked-only.** Refresh only workflows in `config.workflows`. A
  `create_workflow_from_code` mints an *untracked* id → skip (log a "run `pull
  <id>` to adopt it" hint) rather than auto-create a folder.
- **Optimistic on forward.** Schedule the refresh when a non-blocked
  `update_workflow` is forwarded; a failed op just yields a redundant no-op pull
  (idempotent), avoiding response-buffering in the streaming HTTP proxy.
- **Config escape.** `liveMirror` (default **true**; `false` disables) for
  CI/deterministic setups — booleans default-true via the `!== false` idiom
  already used by `commitOnPush`/`commitOnPull`.

**Draft-vs-tip:** `pull` reads the tip (the draft when one exists) — exactly what
the agent just edited. Correct with no extra logic.

### Part A tasks

1. **Config flag.** Add `liveMirror?: boolean` to `DecanterConfig`
   ([lib/types.mts](../lib/types.mts)) + `loadConfig`
   ([lib/config.mts](../lib/config.mts), `cfg.liveMirror !== false`, default
   true). Document in the config docs + `.env`/template config comment.
2. **Shared mirror orchestrator.** New `lib/mirror.mts`:
   `scheduleMirrorRefresh(workflowId)` — debounce timer, per-workflow overlap
   guard, tracked-check, git-presence check, safety-commit, then
   `pullWorkflow(mcp, root, id, { commitOnPull }, log)`. Pure orchestration over
   existing pieces; unit-testable with injected clock + a stub pull.
3. **Wire into both guards.** Thread `{ root, configDir, workflows, commitOnPull,
   liveMirror, mcp }` into `runStdioGuard` ([lib/mcpconnect.mts](../lib/mcpconnect.mts))
   and `startGuardProxy` ([lib/mcpserve.mts](../lib/mcpserve.mts)); on a
   forwarded non-blocked `update_workflow`, call the orchestrator with
   `arguments.workflowId`. Update the `mcp:connect`/`mcp:serve` dispatch in
   [n8n-decanter.mts](../n8n-decanter.mts) (~L214) to pass config through.
4. **Log surface.** Guard stderr notes "mirrored `<name>`: workflow.json
   refreshed" (and the "no git — skipping live mirror" / "untracked id — run
   pull" hints), consistent with the guard's existing stderr-only logging.
5. **Tests.** Unit (debounce coalescing, tracked-only skip, git-absent skip,
   overlap guard); e2e (drive an `update_workflow` through the in-process guard →
   assert `workflow.json` refreshed without a manual pull); smoke — a real
   `renameNode`/`addNode` through the guard auto-updates `workflow.json` and
   auto-commits, and `liveMirror:false` suppresses it. Fire-and-forget:
   assert the agent's tool response returns before the pull completes.

## Part B — REST recovery redeploy (`recover` verb, working name)

**Behavior.** `n8n-decanter recover <workflow>` assembles the full workflow JSON
from git — `workflow.json` structure with each Code node's `jsCode` **re-inlined
from its `code/` file** (`.ts` compiled, `.js` byte-exact) — and `POST`s it to
`/api/v1/workflows` on the configured instance, **creating a new workflow with
the snapshot's node ids preserved**. Prints the new id + rebind guidance. Lands
**unpublished** (a draft). REST-only, `N8N_API_KEY`-gated like
`executions`/`data-tables` (the surfaces MCP can't serve — and lossless full-JSON
create is exactly such a surface: the spike proved MCP has no lossless path).

**Framing (docs) = disaster recovery, not sync.** Positioned as break-glass:
redeploy a workflow from git to a rebuilt/fresh n8n. Honest caveats stated up
front: creates a **new workflow id** (the server assigns it; node ids are
preserved); **credentials must be re-bound** and **tags re-created** on the
target; lands unpublished. It is *not* a structure-sync verb — structure
ownership stays with n8n (Plan 32).

### Part B tasks

1. **Re-add REST create.** `createWorkflow(config, workflowJson)` in
   [lib/api.mts](../lib/api.mts) (`POST /api/v1/workflows`, via `requireApiKey`).
   Plan 33 removed the old one with the retired create/duplicate verbs; the
   endpoint itself is proven by the smoke seed.
2. **Full-JSON assembly.** New `lib/recover.mts` (or fold into
   `lib/lifecycle.mts`): read `workflow.json`, resolve each `//@file:`
   placeholder to its `code/` file and inline the compiled/verbatim `jsCode`
   (reuse `buildNodeCode` + `placeholderFile` from [lib/push.mts](../lib/push.mts)),
   keep `connections`/`settings`/`name`/node ids, strip server-derived fields
   (`versionId`, `active*`, `shared`, `scopes`, …). Compliance-guard the assembly
   first ([lib/validate.mts](../lib/validate.mts)) so a broken snapshot can't be
   deployed.
3. **`recover` verb.** Register in [n8n-decanter.mts](../n8n-decanter.mts)
   (`VERBS`, `__complete`, `usage()`); ref-taking (picker on no ref, TTY).
   Output: new id, editor URL, "rebind credentials / re-create tags; publish when
   ready". Confirm naming (`recover` vs `restore`/`redeploy`) — `restore` collides
   with n8n's `restore_workflow_version`; **`recover` preferred**.
4. **Tests.** Unit (assembly inlines jsCode + strips derived fields + guards a
   bad snapshot); smoke — `recover` a pulled workflow → `POST /workflows` →
   assert **node ids preserved** and it executes after `publish`.
5. **Docs (all three surfaces).** README verb-index row + a recovery feature
   bullet; `docs/cli/recover.md` + the `docs/cli/overview.md` command surface;
   `CHANGELOG.md` `[Unreleased]` Added. Frame as recovery throughout.

## Acceptance / verification

- **Part A:** an `update_workflow` through either guard transport refreshes
  `workflow.json` with no manual `pull`, without blocking the agent, with a
  safety commit first, only for tracked workflows, and disabled by
  `liveMirror:false`. Unit + e2e + smoke green.
- **Part B:** `recover` recreates a workflow on a fresh instance from git with
  **node ids preserved** and Code-node source intact; it executes after publish;
  requires an API key with `workflow:create`. Unit + smoke green.
- CI (lint + typecheck + `npm test`) green; docs three-surfaces in sync; the
  backlog item checked off; PLAN.md updated (below).

## Notes / PLAN.md + BACKLOG implications

- **CHANGELOG:** Added — "live `workflow.json` mirror (auto-refresh after MCP
  structure edits through the guard; on by default, `liveMirror:false` to
  disable)" and "`recover` verb — redeploy a workflow from git to a fresh n8n
  (disaster recovery)". Part A changes default behavior of `mcp connect`/`serve`
  → call it out (not **Breaking:** — additive, and disable-able).
- **PLAN.md (at implementation):** (a) the snapshot section — `workflow.json` is
  still *decanter-read-only* (never hand-pushed), but the **guard now refreshes
  it live**; note the mirror flow + safety rails. (b) The API-only surface grows
  from "`executions` + `data-tables`" to also include **recovery create**
  (lossless full-JSON create MCP cannot do), framed as DR. (c) Record the spike
  verdict on `create_workflow_from_code` losslessness so the SDK-code deploy
  question is settled in the design record (extends Plan 33's reasoning with hard
  numbers).
- **BACKLOG:** the auto-refresh item → graduated (checked, this plan). The
  recovery redeploy is a **distinctive feature** (git-native disaster recovery
  for n8n workflows — neither n8n nor generic git-sync offers it) → its own entry
  in the distinctive-features group.

## Non-goals

- **No lossy MCP/`.ts` deploy.** The spike settled it: `create_workflow_from_code`
  loses node ids/tags/pinData/settings and is create-only, and the faithful
  emitter is SUL-licensed + ~124 MB. Not pursued.
- **No in-place structure sync from git.** `recover` creates a *new* workflow; it
  does not reconcile an existing one. Structure ownership stays with n8n.
- **No `workflow.json` hand-push.** The snapshot stays decanter-read-only; Part A
  only makes decanter refresh it *sooner*, not the user edit-and-push it.
