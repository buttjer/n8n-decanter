# n8n-decanter — Plan

Standalone CLI that keeps the **Code-node source** of n8n workflows in git:
one folder per workflow, every Code node's source as its own file (`.js` with
JSDoc, or `.ts` compiled one-way), synced with the instance over **n8n's
built-in MCP server** — draft-first, code-only. Workflow *structure* is n8n's
job (the editor, or n8n's own MCP tools); decanter mirrors it into a
read-only `workflow.json` snapshot for review diffs and offline tooling.

This identity is the Plan 32 pivot (2026-07-22, maintainer GO): decanter
stopped being a canonical whole-workflow sync tool over the public REST API
and became **the Code-node craftsmanship layer** — the distinctive part
(shared TS, typecheck, local run/simulate, per-node git history) — while
structure and lifecycle are delegated to n8n's own agent surface (MCP +
official skills). Rewritten from the API-era plan; superseded mechanics are
kept below as compact history where they explain present shapes.

## Project layout

```
n8n-decanter/
  package.json            # deps: esbuild, luxon; devDeps: typescript,
                          #   @types/node, @types/luxon
  .env                    # N8N_HOST, optional N8N_MCP_TOKEN + N8N_API_KEY
                          #   (gitignored; written by init)
  .decanter-auth.json     # MCP OAuth credentials (gitignored; minted by init)
  decanter.config.json
  n8n-decanter.mts        # CLI entry (verb-first: `n8n-decanter <verb> …`):
                          #   init | pull | push | status | check | rename |
                          #   watch | create | publish | unpublish |
                          #   archive | list | executions | data-tables |
                          #   simulate | completion + namespaces:
                          #   node (create|rename|run), mock (create|check),
                          #   mcp (serve)
  lib/                    # implementation: add, api, compile, config, datatables,
                          #   diff, executions, git, init, lifecycle, mcp, picker,
                          #   prompt, proxy, pull, push, rename, run, state, status,
                          #   style, template, util, validate, watch (one .mts each)
                          #   + types.mts (shared data-model shapes)
  data-tables/            # optional: fetched data-table schema + rows (plans/25)
                          #   — top-level, self-gitignored, read-only, never synced
  scripts/typecheck.mts   # tsc wrapper — see Type checking
  template/               # copied verbatim by init: AGENTS.md, CLAUDE.md
                          #   (references AGENTS.md), workflows/ — anything
                          #   added here later is copied too
  test/                   # e2e.mts (mock REST+MCP e2e) + proxy.mts +
                          #   interactive.mts (picker terminal IO, PassThrough
                          #   streams) + unit/ — all npm test; smoke-n8n.mts
                          #   (opt-in Docker smoke incl. the MCP path, plans/15
                          #   + plans/32); harness.mts (shared step runner:
                          #   STEP=<substring> isolates one step,
                          #   skip-on-prerequisite-failure, plans/22)
  tsconfig.json           # workflow node files: allowJs + checkJs, includes workflows/
  tsconfig.cli.json       # the CLI's own .mts sources: strict NodeNext, no emit
  n8n-globals.d.ts        # ambient types: $, $input, DateTime, …
  workflows/              # synced content, see below
```

## Decisions made

- **Plan 32 (2026-07-22): the workflow code path rides n8n's MCP server; the
  public API stays only where MCP has no equivalent.** The invariant that
  made the pivot safe: *Code-node source in git* lives in the file layer and
  survived the backend swap untouched. What flexed: `workflow.json` demoted
  to a read-only snapshot; whole-workflow structural hashing, the
  PUT-canonical drift guard, watch's structural-conflict machinery
  (`workflow.remote.json`), and the `.remote.js` conflict artifacts all
  deleted; per-node content hashing kept as the only drift guard. Spike- and
  smoke-verified against n8n 2.30.7 (see "MCP backend" below).
- **Draft-first is the product, not a caveat.** MCP `update_workflow` writes
  land on the workflow's draft and `publish_workflow` is a separate act —
  the API-era "auto-publish on push to an active workflow" behavior (a
  server-side `publishIfActive: true` hardcode) is gone along with the API
  path. `push --publish` composes the two for the common case.
- **Structure acts are forwarded, never synced.** `rename`, `node create`,
  and `node rename` (offline in the API era, "push to propagate") now issue
  the matching MCP op (`setWorkflowMetadata`, `addNode`, `renameNode`) and
  pull the result. The framing that keeps the boundary honest: sync verbs
  touch only Code-node source; ref verbs *relay deliberate user acts* to
  n8n — decanter still never owns structure.
- **Per-verb API decisions (Plan 32 Task 4, revised by Plan 33):**
  `publish`/`unpublish`/`create` re-based onto MCP
  (`create_workflow_from_code` with the minimal `workflow('<slug>',
  '<name>')` SDK expression, gated by `validate_workflow` since Plan 33;
  MCP-created workflows are born `availableInMCP`, so the follow-up pull
  works). `executions` and `data-tables` stay on the API (no MCP row reads).
- **Plan 33 (2026-07-22, maintainer decision): no hard delete and no clone in
  decanter.** The Plan 32 execution had kept `delete` (REST hard delete) and
  `duplicate` (lossless REST `POST /workflows`); both verbs are **gone**.
  `archive` (MCP `archive_workflow`) replaces `delete` with the same consent
  gate — reversible in the n8n UI, which also owns permanent deletion.
  `duplicate` was **dropped rather than re-based**: MCP has no lossless
  full-JSON create (only SDK-code creation), and the candidate SDK-code
  bridge — n8n's own `@n8n/workflow-sdk` npm generator — would have added a
  ~20 MB Sustainable-Use-licensed dependency tree to an MIT CLI for one verb;
  a hand-rolled emitter risked silent wiring divergence. The n8n UI
  duplicates natively; decanter pulls the copy. Consequence: the API-only
  surface is exactly `executions` + `data-tables` fetches.
- **esbuild** compiles `.ts` node files (`bundle: false`, `format: "cjs"`,
  `target: node18`). Comments are stripped and lines shift — accepted.
  Consequence: instance-side edits on TS nodes can't be auto-merged back into
  the `.ts`; they are *detected* and warned about (`status --diff` to
  inspect; the `.remote.js` artifact files died with Plan 32).
- **`.js` nodes are the lossless default**: pushed/pulled verbatim, byte-identical
  round-trip. Type-check via JSDoc + `checkJs`. Git merges them like any file.
- **`.ts` nodes are one-way**: local `.ts` is source of truth. Push compiles and
  appends a marker (see below). Pull never touches the `.ts`.
- **Marker** identifies TS-managed nodes, appended post-compile as the last line:

  ```
  // @ts-n8n sha256:<hex hash of the compiled JS excluding this line>
  ```

  Presence of the marker ⇒ node is TS-managed (self-describing, no config entry).
  Pull strips the marker line before hashing/comparing. Push also sends a
  body-equal node when the remote lacks the marker (so a freshly converted
  `.ts` node gets marked on its first push instead of warning forever).
- **Git workflow (decided 2026-07-19; releases decoupled 2026-07-21):
  protected main, releases via a dedicated release PR.** No direct commits to
  main; short-lived branches, squash-merged via PR (linear main, one commit per
  PR). **Feature PRs are decoupled from releases** — a user-facing PR only
  appends its entry under `[Unreleased]`; it does *not* bump `package.json`,
  tag, or release. Releasing is a separate, deliberate `chore/release-x.y.z`
  PR. `npm publish` is the maintainer's step. Full scheme in AGENTS.md.
- **n8n 2.x only (user decision 2026-07-19), with an MCP floor since Plan 32.**
  The tool targets the 2.x line exclusively; the MCP sync path additionally
  needs the built-in MCP server (~2.20+; all Plan 32 behavior verified on
  2.30.7), MCP access enabled instance-wide, and the per-workflow
  `availableInMCP` opt-in. Continuously verified against real 2.x instances
  by the plans/15 smoke suite (version matrix via `SMOKE_N8N_TAG`, plans/22).

## Synced content layout

```
workflows/
  <workflow-slug>/            # kebab-case slug of the name (a stable local pick)
    workflow.json             # READ-ONLY structure snapshot; jsCode replaced by
                              #   "//@file:code/<node-name>.js" placeholders
    code/
      <node-name>.js          # JSDoc-typed Code node (lossless)
      <node-name>.ts          # TS Code node (one-way)
    .decanter.json            # state, see below
    executions/               # optional: fetched run data (plans/3) — temp,
      <execId>.json           #   self-gitignored, never synced back
    fixtures/                 # optional: committed pins (simulate --pin, plans/7)
    mocks/                    # optional: committed, hand-fillable mock scenarios
      <slug>.json             #   (mock create/check, plans/7) — tracked
```

- Workflow **id** lives in `workflow.json` (and `.decanter.json`) → the folder
  name is a free local pick. Pull matches folders by id. A **new** folder is the
  **kebab-case slug** of the workflow name (`Order Sync` → `order-sync/`; a slug
  collision with a different workflow falls back to `<slug>-<id8>` + a warn); an
  **existing** folder is left as-is — folders are sticky and never follow a
  remote rename (Plan 27). The always-current display name is cached in
  `.decanter.json.name`.
- Node files live in the folder's `code/` subdir, named after the node name in
  **kebab-case** (`Parse Order` → `code/parse-order.js`). Node **id** is the
  real key — **ids survive renames** (spike-verified, including MCP
  `renameNode`), which is the whole identity design (Plan 32 Task 3):
  `.decanter.json` maps node-id → file path, MCP ops address nodes *by name*,
  and push looks each id's current name up from a fresh read. A structure-side
  rename (UI, another agent via MCP, or `node rename`) therefore just moves
  the local file on the next pull; per-pull collision handling is
  deterministic, so a freed kebab base is re-claimed by the next pull. The
  same rename machinery migrates pre-`code/` flat layouts.
- **`workflow.json` is a read-only snapshot** (Plan 32 Task 6, promoted from
  nice-to-have to core since so much offline tooling reads it): pull rewrites
  it from the workflow *tip*; nothing pushes it; `status` prints an
  informational stale hint when the remote structure moved. Pretty-printed
  with stable key order → clean review diffs of structure changes made in
  n8n. The one meaningful local edit is re-pointing a `//@file:` placeholder
  (the human-visible file map; push honors it — that's how `.js` ↔ `.ts`
  conversions work). Derived/permission fields are stripped on pull:
  `activeVersion`, `activeVersionId`, `shared`, `scopes`, `canExecute`. The
  draft `versionId` is kept (the executions stale-fixture warning reads it).

### `.decanter.json` (per workflow)

```json
{
  "workflowId": "0cXNQKKzmO0pXiCq",
  "name": "Order Sync",
  "nodes": {
    "<node-id>": {
      "file": "code/amazon-feed.ts",
      "lastPushedHash": "sha256:…",
      "name": "Amazon Feed"
    }
  }
}
```

`name` (workflow-level) is the cached display name, refreshed on every pull
(Plan 27). Per-node `name` (Plan 32) is a cache for messages about nodes that
vanished remotely — push always resolves id → current name from a fresh read,
never from this cache. `lastPushedHash` = hash of the *remote* marker-less
code body at last sync (push **or** pull) — the per-node drift base and the
only sync hash left. The API-era `lastPulledWorkflowHash` (structure hash) is
gone; pull scrubs it from old state files.

## MCP backend (`lib/mcp.mts`, Plan 32)

The sync backend is n8n's built-in MCP server — `POST /mcp-server/http`,
JSON-RPC over streamable HTTP, spoken by a minimal hand-rolled client (no SDK
dependency). Everything below is verified against n8n 2.30.7 (spike + smoke,
2026-07-22; raw shapes in the plan32-mcp-api-facts memory and AGENTS.md
"Driving a real n8n in Docker").

- **Protocol:** `initialize` handshake (protocol `2025-03-26`) once per
  process, echo the `mcp-session-id` response header on later calls, send
  `accept: application/json, text/event-stream` and parse both plain-JSON and
  SSE (`data:` lines) responses. Tool results are
  `{content:[{type:"text",text}], structuredContent?, isError?}`; the client
  prefers `structuredContent`, falls back to parsing `text`, and normalizes
  `isError` to a thrown `McpToolError` carrying the server's message verbatim
  (n8n's own guidance texts are good — surface them unfiltered).
  `publish_workflow` reports failure **in-band** (`success:false` + `error`),
  normalized to a throw too.
- **Tools used:** `search_workflows` (lists ALL workflows instance-wide,
  `availableInMCP` flag per row; limit ≤ 200, no cursor),
  `get_workflow_details` (full nodes with ids + byte-exact `jsCode`,
  `versionId`/`activeVersionId`; the workflow **tip** — draft if one exists,
  else published content), `update_workflow` (atomic op batch, name-addressed;
  `updateNodeParameters` **merges** — a `{jsCode}`-only write preserves
  sibling params; returns a summary, never the workflow), `publish_workflow`
  / `unpublish_workflow`, `create_workflow_from_code`.
- **The availability gate:** `search_workflows` sees everything, but
  details/update/publish refuse workflows without `availableInMCP`
  ("Workflow is not available in MCP. Enable MCP access from the workflow
  card…"). Surfaced as a third picker state (red `⊘`, sorted last, Enter →
  guidance), `(not available in MCP)` markers + hint in `list --remote`
  (`--json`: `mcpAvailable`), and an appended hint on pull/push errors
  (`isUnavailableInMcp` classifier). Toggling is a user act in n8n — the
  internal `/rest/mcp/workflows/toggle-access` route is version-fragile and
  only used by the smoke suite's bootstrap, never by the shipped CLI.
- **Auth:** two methods, resolved in order — `N8N_MCP_TOKEN` (rotatable
  bearer from n8n Settings → MCP; the public API key is NOT a valid MCP
  bearer) wins, else the OAuth credentials in `.decanter-auth.json` (host,
  client id, refresh token, cached access token + expiry; 0600). **Refresh
  tokens rotate and the old one is invalid the moment a refresh succeeds** —
  the client persists the rotated pair before doing anything else, caches
  access tokens (3600 s, 60 s margin) so refreshes stay rare, refreshes once
  on a 401, and maps a terminal `invalid_grant` to "re-run init". An auth
  file minted for a different host is ignored with a warning. OAuth endpoint
  discovery (`/.well-known/oauth-authorization-server`) re-bases every
  advertised endpoint onto the configured host — instances behind
  proxies/containers advertise their own idea of their URL.
- **Rate limiting:** n8n 429s the MCP endpoint under bursts (hit live by the
  smoke suite's rapid CLI runs). The client backs off and retries (≤ 5,
  Retry-After-aware, else 1/2/4/8 s) — safe for every tool since a 429'd
  request was not applied.
- **Errors:** 404 → "enable MCP access in n8n (Settings → MCP; needs ~2.20+)";
  401 bearer → "mint a fresh token (the public API key is not a valid MCP
  token)"; timeouts honor `requestTimeoutMs` with the same guidance as the
  API era.

## Config

`decanter.config.json`:

```json
{
  "root": "./workflows",
  "workflows": ["0cXNQKKzmO0pXiCq", "zhwm1hNadTUtpDBP"]
}
```

Ids only — names, folders, node lists are all derived on pull. Optional keys:
`commitOnPush`/`commitOnPull` (default `true`), `requestTimeoutMs` (default
`30000` — per-request timeout on MCP and API calls; init's probes are fixed
at 10 s), `dataTables` (default `true`, plans/25), `bundleDependencies`
(default `[]`, plans/14), and — for watch's browser live-reload (plans/5) —
`browserReload` (`"off"` default, or `"proxy"`) and `proxyPort` (default
`5679`).

Credentials (Plan 32): `N8N_HOST` is required for online verbs; MCP
credentials (env token or auth file) power the sync/structure/lifecycle
verbs; `N8N_API_KEY` is **optional** and guarded per-verb (`requireApiKey`
names the verb in its error) — only `executions` and `data-tables` need it
(Plan 33). `loadConfig`'s old `requireCredentials` became `requireHost`.

## Workflow refs & CLI output (plans/11)

The grammar is **verb-first** (Plan 27): `n8n-decanter <verb> [workflow…]`.
Node operations live under a **`node` namespace** (`node create` /
`node rename` / `node run`), mocks under `mock` (`create`/`check`). Flags may
sit anywhere; `--publish` (Plan 32) joins `--force`/`--no-typecheck` on push.

Every `[workflow…]` argument is a **ref**: an id, a workflow/folder name, or
a unique name prefix. Resolution is tiered — exact id → exact name
(case-insensitive) → unique prefix — and never prompts. An id-shaped ref that
matches nothing passes through unresolved; `pull` additionally resolves
unknown names against MCP `search_workflows` (which sees every workflow,
opted-in or not). A ref verb given no workflow opens the picker on a TTY.

The **interactive picker** (Plan 19/23) shows three states since Plan 32:
pulled (green `●`), unpulled-but-available (yellow `○`), and
**MCP-unavailable (red `⊘`, sorted last)** — Enter on a `⊘` row resolves to
an `enable-mcp` sentinel the CLI turns into guidance (where the n8n-side
switch lives) instead of a failing pull; the legend gains `⊘ not in MCP` only
when such rows exist, and the Enter hint switches to "enter how to enable".
The remote list rides `search_workflows`. Everything else about the picker
(type-to-filter, verb menu, resume loop, skeleton rows, TTY-gating, pure
state machine exported for tests) is unchanged from Plans 19/23/27.

Output follows **one rule: styling and transient output exist only when the
target stream is a TTY**; piped output is plain line-oriented text and no
information is carried by color alone (the `⊘` glyph carries the third state
by shape). Exit codes: `status` exits **1 on code conflict/remote code
drift** — narrowed by Plan 32: remote *structure* changes are an
informational snapshot-stale hint, not drift (structure is n8n's business,
and MCP/skills edits would otherwise keep CI permanently red). `DEBUG=1`
prints stack traces.

## Pull flow (`n8n-decanter pull [id…]`)

For each configured workflow:

1. MCP `get_workflow_details` — the tip (draft if one exists, else the
   published content; a *superseded* published version is unreadable over
   MCP, so pull syncs the tip by design). Unavailable → the server's
   guidance text + the CLI's enable hint.
2. Locate the local folder by id (scan `.decanter.json`s under root). An
   existing folder is kept as-is (sticky, Plan 27); a new one gets the
   kebab slug (`<slug>-<id8>` + warn on collision). Cache the display name.
3. For each JS Code node (`n8n-nodes-base.code`), matched by node id:
   - **Marker present** → TS-managed: compare `hash(remote body)` vs
     `hash(compile(local .ts))` — in sync → nothing; local == lastPushedHash
     → **instance-side edit**: warn (inspect via `status --diff`), `.ts`
     untouched; remote == lastPushedHash → local modified, info; both moved →
     **CONFLICT** warning. No `.remote.js` files are written (Plan 32).
   - **No marker, local `.ts` exists** → never clobber TS source: keep the
     `.ts`, warn ("not pushed from TS yet?"), re-baseline.
   - **No marker** → plain JS: overwrite `code/<node>.js` with the remote
     body (git is the safety net; a warning flags when that clobbers
     unpushed local edits).
   - Node renamed → rename the file (id-keyed map), update state.
4. Write the `workflow.json` snapshot (placeholders substituted; derived
   fields stripped — see layout).
5. Update `.decanter.json`: per-node `lastPushedHash` (= remote body hash),
   per-node `name`, workflow `name`; scrub the legacy structure hash.
6. Optional auto-commit (`commitOnPull`).

## Push flow (`n8n-decanter push [id…] [--force] [--publish]`)

Before anything else, two local gates run: the **compliance guard** per
workflow and — unless `--no-typecheck` — the **typecheck** once per push.
Guard errors abort and are *not* bypassable with `--force`.

1. Refresh the id→file map from the snapshot's `//@file:` placeholders (the
   human-visible file map — this is what makes a local `.js` → `.ts`
   re-point take effect).
2. MCP `get_workflow_details` (fresh read). For each tracked node id: resolve
   its **current remote name** (the name↔id reconciliation — renames made
   anywhere are absorbed here), build the local payload (`.js` verbatim;
   `.ts` esbuild + marker), and compare hashes:
   - remote body moved off `lastPushedHash` *and* differs from the local
     payload → **per-node drift**: abort with "pull first" (`--force`
     overrides). A remote edit that equals the local payload re-baselines
     silently.
   - body equal (and marker present where expected) → skip; else queue a
     `{type:"updateNodeParameters", nodeName, parameters:{jsCode}}` op.
   - node id missing remotely → warn + skip (pull cleans state); a remote
     Code node not tracked locally → info ("pull to extract it") — never an
     abort (structure is n8n's business).
3. One atomic `update_workflow` batch (merge semantics keep sibling params
   like `mode`/`language` intact). The write lands on the **draft**;
   `versionId` moves, `activeVersionId` doesn't.
4. **Confirming read** — `update_workflow` returns only a summary, so hashes
   are recorded from a post-write `get_workflow_details` (the moral successor
   of the API-era "record from the PUT response" rule), with a byte-exact
   round-trip warning if the server normalized anything.
5. `--publish` → `publish_workflow` afterwards. Result lines state the draft
   reality: `— draft updated; the live version is unchanged (run "publish"
   to go live)` / `— unpublished draft` / `— published: code is live now`.
6. Optional auto-commit (`commitOnPush`); the live-reload proxy is notified.

## Compliance guard (`n8n-decanter check [id…]`)

Unchanged by Plan 32 in substance — the guard validates the *file layer*,
which is exactly the layer decanter still owns. Runs at the start of every
push and standalone as `check` (offline, credential-free).

Errors (block push / exit 1): inline `jsCode` in the snapshot instead of a
placeholder; placeholders referencing missing files, `.remote.js` leftovers,
non-`.js`/`.ts` files, or files outside `code/`; a `.js` file ending with an
`@ts-n8n` marker; imports in `.js` nodes / bundling violations in `.ts`
nodes (plans/14); missing/corrupt `workflow.json` or `.decanter.json`;
structural integrity of the snapshot (dangling connections, duplicate node
names/ids, orphan code files, dangling literal `$('…')` references in code
and expression parameters).

Warnings (don't block): unresolved `.remote.js` / `workflow.remote.json`
leftovers — pre-Plan-32 artifacts; port and delete them.

Typecheck gate: unchanged (see Type checking; scoping, template verify hook).

## Structure verbs (forwarded acts, Plan 32)

- **`rename <workflow> "<new name>"`** → MCP
  `update_workflow [{setWorkflowMetadata, name}]`, then update the local
  snapshot + cached name. Immediate; the folder never moves (Plan 27).
- **`node rename <workflow> "<old>" "<new>"`** → local pre-checks (node
  exists, no collision) → MCP `renameNode` (n8n rewrites connections and
  `$('…')` expression references server-side; node id stable) → rewrite
  `$('…')` in local `.ts` sources (the one thing pull can't refresh — `.ts`
  is one-way) → pull (files and placeholders follow; kebab collisions get
  `-<id8>`). The API-era local rewriting machinery
  (connections/params/file-pair logic in `lib/rename.mts`) shrank to the
  `.ts`-refs pass; `renameNodeRefs`/`findNodeRefs` stay shared with the guard.
- **`node create <workflow> "<Node name>" [--ts]`** → local checks → MCP
  `addNode` (type `n8n-nodes-base.code`, typeVersion 2, starter body,
  position = rightmost + 220) → pull → resolve the landed node **by name**
  (the server may re-mint the id — the e2e mock does, adversarially) →
  `--ts`: convert the landed `.js` to `.ts` in place (the starter body is
  valid TS; the marker lands on first push). Lands disconnected — wiring is
  structure and stays in n8n.

## Lifecycle verbs (`lib/lifecycle.mts`)

- **`publish` / `unpublish`** → MCP `publish_workflow` / `unpublish_workflow`
  (in-band `success:false` normalized to errors). Since pushes are
  draft-only, `publish` is THE go-live step: already-published is only a
  no-op when `activeVersionId === versionId`; a diverged draft re-publishes.
- **`create "<name>"`** → MCP `create_workflow_from_code` with
  `workflow("<kebab-slug>", "<name>")` (the minimal SDK expression — a bare
  expression, top-level `return` is rejected by the SDK parser), gated by a
  `validate_workflow` call first (Plan 33 — a rejected expression surfaces
  the server's errors + hint and never reaches create), then pull (MCP-born
  workflows are auto-available). Born unpublished. The born-in-n8n rule
  holds — the server assigns the id.
- **`archive <workflow> [--force]`** → MCP `archive_workflow` (Plan 33 — the
  replacement for the API-era hard `delete`; `duplicate` was dropped
  outright, see "Decisions made"). Same consent semantics the delete verb
  had: TTY y/N prompt naming workflow + id (plus a "currently published —
  archiving takes it offline" warning when live), `--force` for
  non-interactive, local folder kept, stale config entry flagged, one
  workflow per call. Reversible in the n8n UI (Archived filter), which also
  owns permanent deletion. Archived workflows refuse all MCP access
  (server-side archived-first gate: "archived and cannot be accessed"), so
  the pre-archive `get_workflow_details` read doubles as the
  not-already-archived check.

## Execution datasets (`executions`, plans/3 C) and data tables (plans/25)

Both **unchanged by Plan 32 and deliberately still on the public API** — the
surfaces MCP cannot serve (spike-verified: data-table tools are add-only with
no row reads; full execution run-data reads were not available). Their design
records stand as before:

- `executions [workflow…] [--status=…] [--limit=N]` fetches recent executions
  with full run data into self-gitignored `workflows/<folder>/executions/`;
  a numeric arg fetches one by id; `clean` is offline. Executions run the
  *published* version — the stale-fixture warning compares each
  `workflowVersionId` against the snapshot's draft `versionId` (kept in
  `workflow.json` for exactly this). Never synced back; never in git.
- `data-tables [table…] [--filter/--search/--sort/--limit/--all]` fetches
  schema + rows into the top-level self-gitignored `data-tables/` dir;
  read-only by design; config-gated by `dataTables`; `clean` offline. Scopes
  and endpoint facts in the plan25-datatables-api-facts memory.

## Watch mode (`n8n-decanter watch <workflow>`)

Radically simplified by Plan 32 — the fast inner loop for a workflow's
**code**:

- **Watch start = snapshot commit + pull**, unchanged rationale (the commit
  must land before pull overwrites `.js` files and the snapshot; no git → the
  startup pull is skipped). A dim note states the draft-only reality: run
  `publish` to take changes live.
- **Code saves** map the changed file back to its node (state re-read per
  event, so mid-session renames resolve) and push **only that node** — a
  single-op MCP `update_workflow`, per-node drift guard as in push. 200 ms
  debounce, overlap guard, dirty-set queueing — all as before.
- **`workflow.json` saves push nothing.** The snapshot is read-only; the
  first save in a session warns once ("structure changes belong in n8n"),
  then stays quiet. The whole structural-watch apparatus — 3-way baseline,
  conflict prompt (`[m]/[l]/[r]`), `workflow.remote.json`, promptFactory
  injection — is deleted.
- **Browser live-reload (plans/5)** is untouched: same transparent proxy,
  same `notifyPushed` SSE contract, verified by `test/proxy.mts` and a
  dedicated e2e step.

## MCP guard-proxy (`mcp serve`, plans/33)

Technical enforcement of the Code-node boundary the template's `AGENTS.md`
states in prose. `lib/mcpserve.mts`:

- **Decanter is the sole credential holder.** The proxy authenticates agents
  with a per-session random secret (printed once; also written with the
  endpoint to a gitignored `.decanter-proxy.json` for tooling discovery) and
  forwards upstream with the real bearer/OAuth token via
  `McpClient.bearerToken()` — inheriting the refresh-race coordination; one
  forced refresh on an upstream 401.
- **Requests are parsed, responses pipe through untouched** (SSE included).
  The single block rule: `tools/call` → `update_workflow` whose arguments
  contain a `jsCode` key at any depth → answered in-band with an
  instructive `isError` tool result ("edit the file + push"). Op types are
  deliberately NOT enumerated — the op vocabulary churns; the key is the
  contract. Unparseable bodies **fail closed** (403), bodies over 10 MB get
  413 (drain-then-respond — destroying the socket would RST before the
  client reads the answer), non-secret requests 401 without touching n8n.
- Binds `127.0.0.1` only; default port 5680 (`--port`, `0` = ephemeral).
  Blast radius is availability, not integrity: decanter's own sync never
  routes through the proxy.
- Template stack: `mcp-route-check.mjs` (SessionStart hook, shared script —
  config-drift detector, not an op inspector) warns when an agent MCP config
  in the sync dir reaches an n8n `/mcp-server/http` endpoint that isn't
  loopback; `AGENTS.md.example` states the boundary proxy-first.

## Init flow (`n8n-decanter init [dir]`)

Bootstraps a sync directory. Plan 32 made it OAuth-first:

1. **Host** prompt (existing `.env` value reused with a note; normalized).
2. **MCP credentials** — existing `N8N_MCP_TOKEN` or a host-matching
   `.decanter-auth.json` are reused. Otherwise, on a TTY: the **OAuth
   consent flow** (`runOAuthConsent` in `lib/mcp.mts`) — RFC 7591 dynamic
   client registration → PKCE S256 authorize URL opened in the browser
   (`DECANTER_NO_BROWSER=1` prints it only) → localhost callback server
   catches the code → token exchange → `.decanter-auth.json` (0600). Any
   failure falls back to a paste-a-token prompt. Piped/non-TTY runs skip the
   browser and go straight to the token prompt — init stays scriptable
   (`printf "host\ntoken\nkey\n" | n8n-decanter init`).
3. **Optional API key** prompt (Enter to skip) — executions / data-tables
   only (Plan 33).
4. `.env` is rewritten preserving unknown keys (comments are not preserved);
   template copy (modification-aware manifest machinery, unchanged — see
   below), `decanter.config.json` scaffold, `.gitignore` (now also covering
   `.decanter-auth.json`).
5. **Verification probes**: an MCP `search_workflows` reporting how many
   workflows are visible and how many are `availableInMCP` (with a hint about
   the per-workflow switch), plus the old `GET /api/v1/workflows?limit=1`
   probe when an API key was given.

**One shared prompt session** serves every question — a second
`createPrompt()` would lose piped answers the first one buffered (the same
class of bug the buffering prompt helper solved in the API era; rediscovered
when init grew multiple questions).

The template machinery (dpkg-conffile-style `.decanter-template.json`
manifest, `X.example` materialization, `--force` semantics) is unchanged from
plans/16. The template's agent contract (`AGENTS.md.example`) was rewritten
for Plan 32: Code-node source is authored as files and synced by decanter —
never edited on the instance (UI, MCP tools, or skills); `workflow.json` is a
read-only snapshot; structure/lifecycle may go through n8n's MCP tools and
the official n8n skills pack, whose **knowledge** skills are recommended
while the build/lifecycle skills are subordinated to the decanter override
(Task 9 — the override, not selective installation, holds the boundary; the
pack installs whole).

## Type checking

Unchanged by Plan 32 (the file layer is decanter's layer):

- `tsconfig.json`: `allowJs` + `checkJs`, includes `workflows/`, excludes
  `**/*.remote.js` (harmless legacy exclusion); `moduleDetection: "force"`.
- `scripts/typecheck.mts` wraps node files in an in-memory `async function`
  (node files recognized by a `.decanter.json` sibling — directly or in the
  parent of their `code/` dir) and maps diagnostic lines back; files on disk
  stay verbatim. `decanter-ts-plugin/` suppresses TS1108/TS1375/TS1378 on
  node files in editors (plans/4).
- `npm run typecheck` = `tsc -p tsconfig.cli.json` (the CLI's own strict
  sources) + the wrapper script.

## Milestones

1. ✅ Scaffold + pull, single workflow (API era — validated the data model).
2. ✅ push — reassembly, compile+marker, drift guard (API era).
3. ✅ multi-workflow loop + rename handling by id.
4. ⬜ n8n folder hierarchy — still blocked on API exposure
   ([Plan 8](plans/BLOCKED-8-folder-hierarchy-in-sync-layout.md)).
5. ✅ QoL: `watch`, `status`.
6. ✅ `init`; 7. ✅ compliance guard + `check`; 8. ✅ structural validation +
   `rename` (plans/2).
9. ✅ **Plan 32 (2026-07-22): MCP-native code layer** — `lib/mcp.mts` client
   + OAuth, pull/push/status/watch re-based (draft-first, code-only),
   structure verbs forwarded, lifecycle re-based, picker third state, init
   OAuth-first, template contract rewritten, e2e mock became a REST+MCP mock,
   smoke suite drives the MCP path on the real container (28 steps green on
   2.30.7).

## Implementation notes (decisions & observations)

Validated by `npm test` (unit + e2e with an in-process **REST+MCP mock** +
proxy + interactive suites) and the opt-in Docker smoke suite. Notes from the
API-era build that still hold are kept; superseded ones are marked.

- **Top-level `return`**: node code is a function body; esbuild accepts it,
  `tsc` rejects it (TS1108) → the typecheck wrapper.
- **`lastPushedHash` means "remote code hash at last sync"** (push *or*
  pull). Pull re-baselines even when surfacing an edit/conflict — otherwise
  push would stay blocked forever after a warned pull. Consequence: after a
  warned pull, push overwrites the surfaced remote edits; `status --diff` +
  git history are the safety net.
- **Hashes are recorded from a post-write confirming read** (Plan 32) — MCP
  `update_workflow` returns a summary, never the workflow; the confirming
  `get_workflow_details` is the successor of the API-era "record from the
  PUT response" rule and doubles as the byte-exact round-trip check.
- **Name↔id reconciliation is a lookup, not machinery** (Plan 32 Task 3):
  MCP addresses nodes by name, state is keyed by id, and push resolves
  id → current name from the fresh read it needs anyway. Renames from any
  actor are absorbed for free; ids surviving renames is the load-bearing
  server behavior (spike-verified).
- **n8n rate-limits the MCP endpoint (429)** — discovered live when the smoke
  suite's rapid CLI runs tripped it; the client's backoff-retry (safe: a
  429'd request was not applied) fixed it. Also: each CLI process does the
  full initialize handshake — acceptable, but part of why bursts hit limits.
- **OAuth refresh tokens are single-use** (rotate-on-refresh,
  `invalid_grant` on reuse — verified live). The client persists the rotated
  pair immediately and caches access tokens to keep refreshes rare;
  concurrent processes racing a refresh is accepted (the loser gets the
  "re-run init" error).
- **Extension transitions are never auto-renamed**: a local `.ts` is never
  clobbered by an unmarked remote, and compiled output is never relabeled as
  TS source — warn-only since Plan 32 (no `.remote.js` artifacts).
- **Filename sanitization / kebab-case `code/` layout**: unchanged
  (plans/2 + backlog decisions — `/ \ : * ? " < > |` → `-`, collisions get
  `-<id8>`, per-pull deterministic).
- **`run` staticData + `$env` isolation** (plans/3 A, 2026-07-20): unchanged.
- **Name resolution is composed, not monolithic** (plans/11): unchanged;
  `pull`'s remote fallback now queries `search_workflows`.
- **Nodes deleted remotely** are dropped from state with a warning; files
  stay on disk (git is the safety net). On push they warn + skip.
- **Watch internals**: dir watches (editor saves replace inodes), 200 ms
  debounce, dirty-set, state re-read per event — unchanged; the structural
  half is gone (see Watch mode).
- **Browser live-reload proxy** (plans/5): unchanged, incl. the SSE reload
  channel and dirty-tab probe.
- **Piped stdin for prompts**: `readline/promises` drops early lines and
  hangs on EOF → the buffering prompt helper; **one session per command** —
  a second `createPrompt()` loses lines the first one buffered (Plan 32
  rediscovery when init grew multiple questions).
- **TypeScript CLI + publish-build pipeline** (plans/6, plans/13): unchanged
  — native type stripping in dev, compiled `dist/` in the npm tarball,
  `erasableSyntaxOnly`, extension-aware runtime spots.
- **Testing**: the e2e suite is one sequential, stateful scenario against a
  single shared mock that now serves **both** surfaces — `POST
  /mcp-server/http` (bearer-authed JSON-RPC; initialize answers plain JSON,
  tools/call answers SSE so both client parser branches stay covered; ops
  applied with the verified merge/rename/re-mint semantics; per-workflow
  `availableInMCP` honored) and the REST endpoints for the API-only verbs.
  Async exec stays mandatory (in-process mock). `McpClient` has its own unit
  suite (envelope/SSE parsing, auth precedence, refresh rotation persistence,
  401/404/timeout mapping) against a scripted `node:http` server; push's
  drift/addressing logic is unit-tested through `pushWorkflow` with a stub
  `callTool`. The smoke suite bootstraps MCP itself (enable + rotate token +
  per-workflow toggle via the owner cookie — spike-only internals, fine for a
  throwaway container) and exercises the gate, draft-first pushes,
  `--force`, the MCP rename (id stability + server-side reference rewriting,
  live), watch, and lifecycle on the real image.
- **`shared/` bundling in `.ts` nodes** (plans/14): unchanged, including the
  export-free entry and CJS-interop rewrite (n8n's task-runner sandbox
  neuters getter descriptors) and the "no-import nodes keep byte-identical
  plain output" guarantee.
- **n8n 2.x publish semantics — API era, superseded but explanatory
  (researched 2026-07-18):** the public API's `PUT` hardcoded
  `publishIfActive: true` and `forceSave: true` (no reachable optimistic
  locking), which is why the API-era decanter had auto-publish-on-push and a
  PUT-canonical drift guard. Plan 32's MCP path made both obsolete: writes
  are draft-only by construction and the per-node hash check is the conflict
  protection. The version-aware `status` fields (`versionId` /
  `activeVersionId`, `publishedVersionLagsDraft`) carried over unchanged —
  they're first-class in the MCP responses too.

## Open questions (verify against a live instance)

- ~~Folder placement on the API GET~~ — answered no (2026-07-19/20, Plan 8
  blocked on upstream exposure). MCP note: `get_workflow_details` carries a
  `parentFolderId` field (null in tests) — re-check Plan 8 against the MCP
  surface when it matters.
- ~~Filename sanitization; PUT round-trip preservation of tags/pinData;
  activate/deactivate shapes; create body; DELETE on published~~ — all
  answered in the API era (see git history of this file); the still-relevant
  outcomes are recorded above.
- **MCP surface churn**: the tool inventory grew between spike and docs
  (33 → 40+ tools; execution reads, version-history tools appeared). The
  Plan 32 client pins only the six tools listed under "MCP backend"; anything
  new (e.g. re-basing `executions`, version-history reads) is future-plan
  material, re-verified against a live instance first.
- **Refresh-token concurrency**: two decanter processes refreshing the same
  OAuth session race the rotation (loser needs re-consent). Accepted for
  now — access-token caching makes it rare; revisit if it bites (keychain
  storage / lockfile are candidates).
