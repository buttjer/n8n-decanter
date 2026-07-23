# Plan 51 — Live snapshot mirror + git-native workflow backups

**Status:** Not started
**Priority:** P2 (both parts — real design; the live mirror touches the guard's
cross-process concurrency, the `backup` verbs re-add a REST surface + a new
committed artifact)
**Source:** absorbs the retired `draft/42` "auto-refresh `workflow.json` after
MCP structure edits" backlog item (2026-07-23; number 42 retired per
never-reuse) + the paired 2026-07-23 deployable-snapshot research question.
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1
**Theme:** Make git more than a passive record of a workflow. **(A)** keep the
read-only `workflow.json` review mirror **auto-fresh** after an agent
restructures a workflow through decanter's guarded MCP gateway — no manual
`pull`. **(B)** add **versioned, redeployable `backup`s** — a git-native
disaster-recovery store (`backups/<timestamp>.<versionId>.json`) captured over
the public REST API (the only read faithful enough to redeploy), so a workflow
can be brought back on a rebuilt/fresh n8n.
**Model:** Opus for Part A's cross-process concurrency and Part B's assembly
correctness; Sonnet for the mechanical REST/verb wiring.
**Class:** Distinctive feature (Part B — git-native versioned disaster recovery;
neither n8n nor generic git-sync offers it).

## Why

`workflow.json` is a **read-only structure snapshot** (Plan 32): written **only**
by `pull` ([lib/pull.mts](../../lib/pull.mts)), sourced over MCP
`get_workflow_details`, `jsCode` swapped for `//@file:` placeholders, never
pushed. Two gaps the maintainer wants closed:

1. **Staleness.** Since #118 reframed workflow structure as *decanter's guarded
   MCP gateway*, agents restructure workflows **through** the guard
   (`mcp connect`/`serve`). The guard forwards every structure op but the local
   snapshot only refreshes on the next **manual** `pull`, so the "clean git diff
   of structure changes" story lags the agent. The gateway already sees the
   mutation and holds decanter's credential — it can refresh the mirror itself.

2. **Git holds the workflow but can't redeploy it, and can't recover a past
   version.** Both MCP and REST only expose the **current draft tip** — you
   cannot cleanly *export* a past version's content (n8n keeps history but
   `get_workflow_version` is metadata-only over MCP; `restore_workflow_version`
   mutates the draft). So **git is the only place a version history can live**,
   and a committed, redeployable backup turns git into a real **second
   versioning + disaster-recovery layer outside n8n** — one that survives the
   instance being lost.

## Source

- **`draft/42`** (retired, absorbed here) — "*Auto-refresh `workflow.json` after
  MCP structure edits*" (2026-07-23) → **Part A**. Its open questions (which ops,
  debounce/races, churn, draft-vs-tip, on-by-default vs opt-in) are resolved
  below. Number 42 is retired (never reused).
- **Research question (2026-07-23):** "could the snapshot also be a deployable
  second-versioning layer, preferably `.ts`, over MCP?" → **Part B**, answered by
  two Docker smoke spikes (below).
- **User decisions (2026-07-23):**
  - Part A → **on-by-default live mirror** (with safety rails).
  - Part B → **lossless via REST, framed as disaster recovery** (not the lossy
    MCP/`.ts` path). Sidecar approach: **`pull` stays on MCP**; recovery is a
    separate REST-sourced artifact.
  - **Naming:** a `backup` namespace — `backup create` (capture) / `backup
    restore` (redeploy) / `backup list`; artifact
    `backups/<timestamp>.<short-versionId>.json` (avoids colliding with
    "snapshot" = `workflow.json`).
  - **Versioned + rolling:** each `backup create` appends a new timestamped file;
    a `backupLimit` config caps the working set (default **20**, `0` = keep all).
  - **Fields committed:** the REST export **minus** `pinData` + `staticData`
    (runtime state — churny/semi-sensitive); **keep** credential refs +
    `description` (the "which-cred" rebind hint). `jsCode` stays a `//@file:`
    placeholder (no code duplication).
  - **PII:** `backup create` warns (full export incl. credential refs + any
    secrets embedded in node params) and is **not auto-committed** — the user
    reviews and `git add`s deliberately.
  - **Auth:** `backup` is REST-only → needs `N8N_API_KEY` (like
    `executions`/`data-tables`); daily `pull`/`push` stay MCP and key-free.

## Spike findings (two spikes, live against n8n 2.30.7 + source)

**Spike 1 — why not MCP/`.ts` deploy.** `create_workflow_from_code` is
deployable but *lossy + create-only*: `jsCode` byte-exact ✅, but node ids are
**regenerated** (SDK grammar has no id slot; identity is name-based), it always
mints a **new** workflow (no code-based update), and settings/tags/pinData drop.
The only faithful emitter (`generateWorkflowCode`) lives solely in the
**Sustainable-Use-Licensed ~124 MB `@n8n/workflow-sdk`**, not over MCP. So "fully
deployable over MCP" is unreachable losslessly. (Facts saved to the
`plan41-workflow-sdk-deploy-facts` memory.)

**Spike 2 — why `backup` is REST, not the MCP snapshot.** Read the *same*
credentialed workflow both ways:

| field | REST `GET /workflows/:id` | MCP `get_workflow_details` |
|---|---|---|
| node **credentials** ref | present | **stripped** |
| **pinData** | present | **stripped** |
| **staticData** | present | **stripped** |
| **description** | present | **stripped** |
| jsCode / connections / settings / tags / webhookId | present | present (identical) |

MCP's read is *"sanitized… safe for MCP consumption"* — it drops credentials,
pinData, staticData, description → **not recovery-safe.** REST GET is
full-fidelity, **reads the draft tip** (a published workflow's draft edit was
immediately visible via REST while `activeVersionId != versionId` — so REST keeps
draft-first), and shows **no write/read race** (an MCP write was visible to an
*immediate* REST GET — same DB, synchronous). And **REST `GET → POST` round-trips
losslessly**: node ids (`w1,h1,c1`), credential refs, pinData, webhookId all
preserved. Hence `backup` sources from REST and redeploys via REST.

## Part A — On-by-default live snapshot mirror

When an agent's structure edit is **forwarded** through the guard (a non-blocked
`tools/call` → `update_workflow`), schedule a **debounced background `pull`** of
that workflow id, refreshing `workflow.json` (+ code files + state, incl. rename
file-moves) and committing per `commitOnPull`. On by default; `liveMirror:false`
disables it.

**Full `pull`, not a snapshot-only rewrite:** `addNode` must create the
born-empty `code/` file and `renameNode` must move it — both live in `pull`.

**Safety rails (what makes default-on acceptable):**
- **Fire-and-forget** — relay the upstream response to the agent immediately; the
  pull runs in the background and never blocks the next tool call.
- **Require git + safety-commit-before-pull** — skip (warn once) with no git, like
  `watch`; commit a dirty tree before pulling so an overwrite of an unpushed
  `.js` edit is recoverable (reuse `watch`'s pattern via [lib/git.mts](../../lib/git.mts)).
- **Debounce + overlap guard** — coalesce an op burst into one pull; never two
  pulls (or a pull over a `push`) for the same workflow at once.
- **Tracked-only** — refresh only workflows in `config.workflows`; an untracked
  id (e.g. `create_workflow_from_code`) is skipped with a "run `pull <id>`" hint.
- **Optimistic on forward** — schedule on a forwarded non-blocked
  `update_workflow`; a failed op just yields a redundant no-op pull.
- **Config escape** — `liveMirror` (default **true**; `false` disables) for
  CI/deterministic setups.

### Part A tasks

1. **Config.** `liveMirror?: boolean` in [lib/types.mts](../../lib/types.mts) +
   `loadConfig` ([lib/config.mts](../../lib/config.mts), `!== false`, default true).
2. **Shared orchestrator.** `lib/mirror.mts`: `scheduleMirrorRefresh(id)` —
   debounce, per-workflow overlap guard, tracked-check, git-presence check,
   safety-commit, then `pullWorkflow(...)`. Unit-testable with an injected clock.
3. **Wire both guards.** Thread `{ root, configDir, workflows, commitOnPull,
   liveMirror, mcp }` into `runStdioGuard` ([lib/mcpconnect.mts](../../lib/mcpconnect.mts))
   + `startGuardProxy` ([lib/mcpserve.mts](../../lib/mcpserve.mts)); on a forwarded
   non-blocked `update_workflow`, call the orchestrator with `arguments.workflowId`.
   Pass config through the `mcp:connect`/`mcp:serve` dispatch in
   [n8n-decanter.mts](../../n8n-decanter.mts) (~L214).
4. **Log surface** (guard stderr): "mirrored `<name>`", + the no-git / untracked
   hints.
5. **Tests.** Unit (debounce, tracked/git skips, overlap); e2e (guard
   `update_workflow` → snapshot refreshed, no manual pull); smoke (real
   `renameNode`/`addNode` auto-updates + commits; `liveMirror:false` suppresses;
   the tool response returns before the pull finishes).

## Part B — Git-native workflow backups (`backup` namespace, REST)

A versioned DR store per workflow:

```
workflows/order-sync/
  backups/
    2026-07-23T14-30-00Z.8dd14331.json     # each `backup create` appends one
    2026-07-24T09-15-00Z.2f3335b8.json
```

Each file = a full REST export (`GET /workflows/:id`) with `jsCode` kept as
`//@file:` placeholders (no code dup) and `pinData`/`staticData`/server-derived
fields stripped; keeps credential refs + `description`. Named
`<filesystem-safe timestamp>.<short versionId>.json`; the full `versionId` lives
inside.

**`backup create <wf>`** (instance → git)
- REST GET the current draft; **skip if `versionId` is unchanged** since the
  latest backup (no redundant identical copies).
- Write the new timestamped file; **rolling-prune** the working set to
  `backupLimit` (default 20; `0` = keep all).
- **PII/secret warning**; **not auto-committed** — user reviews + `git add`s.

**`backup restore <wf>`** (git → instance)
- Default: the **latest** backup; `--version <id>` / `--at <ts>` / TTY picker to
  choose an older one.
- Assemble full JSON: the backup's structure + credentials + description, with
  each Code node's `jsCode` **re-inlined from its `code/` file** (`.ts` compiled;
  reuse `buildNodeCode`/`placeholderFile` from [lib/push.mts](../../lib/push.mts)),
  server-derived fields stripped.
- REST `POST /workflows` → a **new** workflow (new workflow id; **node ids
  preserved**), landing **unpublished**. Print credential-rebind hints (from the
  backup's credential refs) + the editor URL; publish is the operator's next step.

**`backup list <wf>`** — the retained backups: timestamp · versionId · node count.

**Framing = disaster recovery, not sync.** Creates a *new* workflow; does not
reconcile an existing one. Structure ownership stays with n8n (Plan 32).

### Part B tasks

1. **REST client.** Add `getWorkflow(id)` (GET) + `createWorkflow(json)` (POST)
   to [lib/api.mts](../../lib/api.mts) (`requireApiKey`). Plan 33 removed the old
   create; the endpoints are proven by the smoke seed and Spike 2.
2. **`lib/backup.mts`.** `backupCreate` (GET → strip pinData/staticData/derived →
   placeholder `jsCode` → versionId dedup → write → rolling-prune → PII-warn, no
   auto-commit); `backupRestore` (select → assemble + re-inline → strip → POST →
   rebind hints); `backupList`. Compliance-guard the assembly
   ([lib/validate.mts](../../lib/validate.mts)) so a broken backup can't deploy.
3. **`backup` namespace.** Register in [n8n-decanter.mts](../../n8n-decanter.mts)
   (mirroring the `node`/`scenario`/`mcp` sub-verb dispatch); `create`/`restore`/
   `list`; `requireApiKey` per sub-verb; picker for `restore` selection on a TTY.
4. **Config.** `backupLimit?: number` (default 20) in types + `loadConfig`.
5. **API-key onboarding — name `backup` at every touchpoint.** The **reactive**
   hint is automatic: `backup` calls `requireApiKey` ([config.mts:26](../../lib/config.mts)),
   so a keyless run already errors *"`backup` uses the n8n public REST API … set
   `N8N_API_KEY` (n8n → Settings → n8n API)"*. The **proactive/reference** ones
   each currently name only executions/data-tables and must add `backup`:
   `init`'s optional-key prompt ([init.mts:296](../../lib/init.mts)),
   [README.md](../../README.md)'s API-key line, `template/.env.example`,
   `template/AGENTS.md.example`, and the new `docs/cli/backup.md` + config docs.
6. **`.gitignore` / template.** `backups/` is **committed** (that's the point) —
   ensure it is *not* self-gitignored (unlike `executions/`); document that
   decanter never auto-commits it.
7. **Tests.** Unit (versionId dedup, rolling prune to N, assembly re-inlines
   jsCode + strips pinData/staticData, restore selection); smoke (`backup create`
   writes a file; `backup restore` → POST preserves node ids + credential refs →
   executes after publish).
8. **Docs (all three surfaces).** README verb-index rows (`backup create/restore/
   list`) + a DR feature bullet; `docs/cli/backup.md` + `docs/cli/overview.md`
   command surface; `CHANGELOG.md` `[Unreleased]` Added; the PII/secret note.

## Acceptance / verification

- **Part A:** an `update_workflow` through either guard transport refreshes
  `workflow.json` with no manual `pull`, non-blocking, safety-committed,
  tracked-only, disabled by `liveMirror:false`. Unit + e2e + smoke green.
- **Part B:** `backup create` writes a deduped, rolling-capped, PII-warned,
  non-auto-committed file; `backup restore` recreates a workflow from git with
  **node ids preserved** and Code-node source intact, executing after publish;
  both gated on `N8N_API_KEY`. Unit + smoke green.
- CI green; docs three-surfaces in sync; PLAN.md updated (below).

## Notes / PLAN.md implications

- **CHANGELOG:** Added — live `workflow.json` mirror (`liveMirror`, default on)
  and the `backup create/restore/list` verbs (git-native disaster recovery).
  Part A changes `mcp connect`/`serve` default behavior — call it out (additive,
  disable-able; not **Breaking:**).
- **PLAN.md (at implementation):** (a) `workflow.json` stays *decanter-read-only*
  but the guard now refreshes it live (mirror flow + rails). (b) The API-only
  surface grows from "executions + data-tables" to also include **`backup`**
  (lossless full-JSON GET/POST MCP cannot do), framed as DR. (c) New data-model
  entry: `workflows/<slug>/backups/` (committed, versioned, rolling `backupLimit`,
  PII-sensitive, not auto-committed) + the `backupLimit`/`liveMirror` config
  fields. (d) Record both spike verdicts.

## Non-goals

- **No lossy MCP/`.ts` deploy** (Spike 1 settled it).
- **No in-place structure sync from git.** `backup restore` creates a *new*
  workflow; structure ownership stays with n8n.
- **No `workflow.json` hand-push.** Part A only refreshes the read-only mirror
  *sooner*.
- **No auto-commit / no gitignore for `backups/`.** Committed deliberately by the
  user (PII); retained by git, working set capped by `backupLimit`.
