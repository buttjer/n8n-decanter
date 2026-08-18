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
                          #   init | pull | push | diff | preflight | watch |
                          #   publish | unpublish | list | executions |
                          #   data-tables | test | completion +
                          #   namespaces: node (run), scenario (create|check),
                          #   backup (create|restore|list), mcp (connect|serve)
  lib/                    # implementation: api, compile, config, datatables,
                          #   diff, engine, errors, executions, git, init,
                          #   lifecycle,
                          #   mcp, mcpconnect, mcpserve, picker, prompt,
                          #   mirror, preflight, pull, push, run, simulate,
                          #   state, status, style, skills,
                          #   template, testrun, util, validate, watch (one
                          #   .mts each) + types.mts (shared data-model shapes)
  data-tables/            # optional: fetched data-table schema + rows (plans/25)
                          #   — top-level, self-gitignored, read-only, never synced
  scripts/typecheck.mts   # tsc wrapper — see Type checking
  template/               # copied verbatim by init: AGENTS.md, CLAUDE.md
                          #   (references AGENTS.md), workflows/ — anything
                          #   added here later is copied too
  test/                   # e2e.mts (mock REST+MCP e2e) +
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

- **Structure-verb retirement (2026-07-22, post-Plan-33): decanter has no
  structure/lifecycle verbs — n8n's MCP is the authoring surface, `pull` is
  the reconciler.** `rename`, `create`, `archive`, `node create`, and
  `node rename` were removed (maintainer decision; `node run` stays — offline
  execution has no MCP equivalent). The reasoning: every one of those verbs
  wrapped an MCP tool the agent can call directly through the guard, and the
  local bookkeeping they bundled is exactly what `pull` already does for acts
  made in the UI or by other clients. What replaced them: (a) the **guarded
  authoring loop** — an agent adds a Code node over MCP `addNode` **without**
  `jsCode` (the guard blocks code), `pull` lands it as an empty file, the
  first `push` seeds the source; `getWorkflowDetails` normalizes a
  jsCode-less JS Code node to `""` at the read choke point so every verb sees
  it; (b) the scaffolded **`.mcp.json`/`opencode.json` wire the guard by
  default** (see "MCP guard" below). Losses accepted: no client-side `$('…')`
  rewrite on rename — this was scoped at the time as "`.ts` sources only,
  since n8n rewrites the rest", which **Plan 64 falsified**: the MCP op
  rewrites no refs at all, so the by-hand step covers every source and every
  expression parameter. And `create`'s enforced validate-before-create is now
  the skills'/agent's discipline.
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
  surface was `executions` + `data-tables` fetches — later joined by `backup`
  (Plan 51 Part B; below).
- **Plan 51 (2026-07-23): `backup` re-adds a REST full-JSON path, framed as
  disaster recovery — not sync.** Two spikes settled the design (both live
  against n8n 2.30.7 + source). **Spike 1 (why not MCP/`.ts` deploy):**
  `create_workflow_from_code` is deployable but *lossy + create-only* —
  `jsCode` byte-exact, but node ids are **regenerated** (SDK grammar has no id
  slot), it always mints a **new** workflow, and settings/tags/pinData drop;
  the only faithful emitter (`generateWorkflowCode`) lives solely in the
  Sustainable-Use-licensed ~124 MB `@n8n/workflow-sdk`, not over MCP — so
  "fully deployable over MCP" is unreachable losslessly. **Spike 2 (why REST,
  not the MCP snapshot):** reading the *same* credentialed workflow both ways,
  MCP's sanitized `get_workflow_details` **strips** node credential refs +
  `pinData` + `staticData` + `description` (keeping jsCode/connections/
  settings/tags identical), while REST `GET /workflows/:id` is full-fidelity,
  reads the **draft tip**, shows no write/read race, and **`GET → POST`
  round-trips losslessly** (node ids, credential refs, pinData, webhookId all
  preserved). Hence `backup` sources from REST and redeploys via REST
  (`lib/backup.mts`, `lib/api.mts` `getWorkflow`/`createWorkflow`). REST exposes
  only the current tip; MCP `get_workflow_version(versionId)` *can* read a *past*
  version's code (verified 2026-07-25), but only **lossily** — credential refs +
  `settings` stripped, as above — so neither backend can export a *lossless,
  redeployable* past version. **git is the only place a redeployable version
  history can live** — a committed, redeployable backup makes git a real second
  versioning + DR layer outside n8n. `restore` creates a **new** workflow (new workflow id,
  node ids preserved), landing unpublished — it never reconciles an existing
  one; structure ownership stays with n8n. Consequence: the API-only surface
  is `executions` + `data-tables` + `backup`.
- **esbuild** compiles `.ts` node files (`bundle: false`, `format: "cjs"`,
  `target: node18`). Comments are stripped and lines shift — accepted.
  Consequence: instance-side edits on TS nodes can't be auto-merged back into
  the `.ts`; they are *detected* and warned about (the `diff` verb to
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
- **The compiled artifact must depend only on the SOURCE, never on the node's
  filename** (decided 2026-07-27, after a real smoke failure). esbuild labels
  each bundled module with a `// <path>` comment, so anything we name the stdin
  entry lands inside the compiled bytes — and therefore inside the marker hash.
  Labelling it with the node's own filename made a *pure remote rename* change
  the artifact: `pull` renames the local `.ts`, the comment follows, and the
  node reads "push pending" on a comment-only diff forever. The entry is now
  labelled with a fixed name (`ENTRY_SOURCEFILE` in `lib/compile.mts`), so a
  rename round-trip is byte-stable. Two related invariants already held and
  must keep holding: module labels are **sync-root-relative** (machine-
  independent hashes, via `absWorkingDir`), and the workflow folder is
  **sticky** (never follows a remote rename — Plan 27), which is what keeps the
  surrounding `resolveDir` portion of the label stable too.

  *Why it hid for so long:* the smoke step asserted only `status`'s **exit
  code**, and `status` exited 0 for "push pending" (it reserved 1 for
  conflicts). Plan 59 replaced it with a `diff` **content** match, which is what
  finally surfaced it. The lesson is in the test shape, not the code: assert the
  reported state, not just the exit code.
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
- **Plan 81 (2026-08-18): the unstated assumption "the sync dir is where the
  agent was started" is explicitly dropped.** Everything init scaffolds had
  treated the two as the same directory — true for a standalone sync dir, false
  for the nested layout `docs/concepts/sync-layout.md` explicitly promises. Two
  independent halves failed there: agents load their wiring **only from the dir
  they were started in** (`.mcp.json` merged from that dir's ancestors,
  `.claude/settings.json` from that dir alone — verified against Claude Code
  2.1.234), and decanter's config search only ever walked **up** from cwd, so
  hoisting the MCP entry to the repo root spawned the guard where nothing could
  be found. The fix leaves both mechanisms intact and supplies the input each
  was missing: `--dir`/`N8N_DECANTER_DIR` move the search's starting point (see
  Config), the scaffolded hooks locate themselves from `import.meta.dirname`
  instead of cwd, and `init` prints the working shapes when it detects a project
  root above its target (see Init flow). Deliberately not done: bending the
  agents' own discovery rules, and writing into a parent repo.

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
    scenarios/                # optional: committed, self-contained pin-data
      <slug>.json             #   sets (scenario create/check, plans/7+37) —
                              #   tracked; the ONLY committed pin artifact
    backups/                  # optional: versioned, redeployable full-export
      <ts>.<versionId>.json   #   disaster-recovery backups (backup create,
                              #   plans/51) — COMMITTED (not gitignored),
                              #   rolling-capped by backupLimit, PII-sensitive,
                              #   NOT auto-committed (user reviews + git adds)
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
  rename (UI, or any agent via MCP) therefore just moves
  the local file on the next pull; per-pull collision handling is
  deterministic, so a freed kebab base is re-claimed by the next pull. The
  same rename machinery migrates pre-`code/` flat layouts.
- **`workflow.json` is a read-only snapshot** (Plan 32 Task 6, promoted from
  nice-to-have to core since so much offline tooling reads it): pull rewrites
  it from the workflow *tip*; nothing pushes it; `preflight`+s `snapshot`
  check reports an informational stale finding when the remote structure moved. Pretty-printed
  with stable key order → clean review diffs of structure changes made in
  n8n. The one meaningful local edit is re-pointing a `//@file:` placeholder
  (the human-visible file map; push honors it — that's how `.js` ↔ `.ts`
  conversions work). Derived/permission fields are stripped on pull:
  `activeVersion`, `activeVersionId`, `shared`, `scopes`, `canExecute`. The
  draft `versionId` is kept (the executions stale-fixture warning reads it).
  It stays *decanter-read-only*, but the **guard now keeps it live** (Plan 51
  Part A, `lib/mirror.mts`): when an agent's structure edit is forwarded
  through the guard (`mcp connect`/`serve` — a non-blocked `update_workflow`),
  decanter schedules a **debounced background `pull`** of that workflow, so
  the snapshot (+ code files + state, incl. rename file-moves) refreshes with
  no manual `pull`. Safety rails: fire-and-forget (the agent's tool call is
  never blocked); git-required + safety-commit-before-pull (skip with a
  warn-once when there's no git); per-workflow debounce + overlap guard (never
  two pulls, or a pull mid-pull, for one workflow); tracked-only (an untracked
  id — e.g. a `create_workflow_from_code` — is skipped with a hint). On by
  default; `liveMirror: false` disables it (CI/deterministic setups).

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
at 10 s), `dataTables` (default `true`, plans/25), `liveMirror` (default
`true`, plans/51 Part A — the guard's background `workflow.json` refresh;
`false` disables it), `backupLimit` (default `20`, plans/51 Part B — the
retained `backups/` working-set cap; `0` keeps all), `bundleDependencies`
(default `[]`, plans/14). `browserReload`/`proxyPort` (plans/5) were removed
in Plan 52 — a stale value in an existing config is ignored, not an error.

Credentials (Plan 32): `N8N_HOST` is required for online verbs; MCP
credentials (env token or auth file) power the sync/structure/lifecycle
verbs; `N8N_API_KEY` is **optional** and guarded per-verb (`requireApiKey`
names the verb in its error) — only `executions`, `data-tables`, and `backup`
need it (Plan 33 + 51). `loadConfig`'s old `requireCredentials` became
`requireHost`.

**Where the search STARTS (Plan 81): `--dir <path>` > `N8N_DECANTER_DIR` >
`process.cwd()`.** `resolveSearchStart` (`lib/config.mts`) resolves it once in
`main()` and every verb loads from there — the guard included, so there is no
guard-only path to keep in sync. The upward walk itself is untouched; only its
origin moves, which is what makes a nested sync dir reachable from the repo root
an agent starts in. Both forms resolve **relative to cwd**, so a committed root
`.mcp.json` can carry a repo-relative `"flows"` and survive a clone on another
machine (an absolute path would not); an empty value counts as unset, since an
agent config interpolating a missing variable ships `""`; a path that is not a
directory fails immediately rather than walking to `/` and reporting the wrong
problem. **The env var is the load-bearing half, not the flag** — every agent's
MCP server entry has an `env` block, while a `cwd` key is not guaranteed across
agents and versions. `init` **refuses** `--dir`: it takes its target as a
positional argument, and a flag value peeled off the argv would silently
scaffold the working directory instead.

**Why not a root-dir key in the sync dir's `.env`? Structurally circular** — the
standing answer to a question that keeps recurring. `loadEnv(dir)` runs only
*after* the upward search has located the sync dir, so a `.env` inside it cannot
say where it is, and in the broken case is never read at all. Any hint must
arrive from **outside** the sync dir: argv or the process environment. (A
second, upward-searched root `.env` would be a whole new lookup surface bought
for one bug.) Since `loadEnv` never overrides an already-set variable, the sync
dir's own `.env` cannot fight the `N8N_DECANTER_DIR` that found it either.

**The not-found error has two branches** (Plan 81), because the advice inverts
between them. A bounded breadth-first scan *below* the starting point (depth 3,
≤300 dirs, skipping `node_modules` and every dot-dir) is the evidence: a hit
means the setup is fine and the search merely began too high → name the dir with
`--dir`/`N8N_DECANTER_DIR`. No hit keeps the Plan 75 cold-start advice (a
half-setup `.env`, run `init`). Sending the nested case to `init` would scaffold
a second sync dir on top of a working one. The scan exists only to improve a
message — unreadable dirs are skipped, never authoritative.

## Workflow refs & CLI output (plans/11)

The grammar is **verb-first** (Plan 27): `n8n-decanter <verb> [workflow…]`.
`node run` lives under the **`node` namespace**, scenarios under `scenario`
(`create`/`check`), the agent guard under `mcp` (`connect`/`serve`). Flags may
sit anywhere; `--publish` (Plan 32) joins `--force`/`--no-typecheck` on push.

**`--version`/`-v` is reserved CLI-wide** and answered first — before the
value-flag parser, config load, or verb dispatch — printing the installed
package version. No verb may claim that spelling: `backup restore` did in v0.6.0
(Plan 51), and because the value-flag parser peels flags off *globally*, it
broke the conventional `n8n-decanter --version` on **every** verb — exit 1 with
"`--version` needs a value". Verb-scoped flags that mean "a version" spell out
which one (`--n8n-version`); `backup restore` now takes a positional backup ref
instead. **The lesson generalizes: a globally-peeled value flag is a CLI-wide
name claim, not a verb-local one** — check a new one against the conventional
globals (`--version`, `--help`) before adding it to that regex.

Reserving a name can't be a bare early return, because that just trades a loud
failure for a silent one: `<verb> … --version <id>` would print the version and
skip the work the user asked for. So the version flag only answers when **no
verb is present**; alongside a verb it is a hard error naming the replacement.
Same rule for any future reserved global.

Every `[workflow…]` argument is a **ref**: an id, a workflow/folder name, or
a unique name prefix. Resolution is tiered — exact id → exact name
(case-insensitive) → unique prefix — and never prompts. An id-shaped ref that
matches nothing passes through unresolved; `pull` additionally resolves
unknown names against MCP `search_workflows` (which sees every workflow,
opted-in or not). A ref verb given no workflow opens the picker on a TTY to
pick one (the verb menu is skipped). **For `pull` the no-ref picker merges the
remote `search_workflows` list** (like the bare picker), so a fresh setup with
nothing pulled still gets a menu — pick a not-yet-local workflow and it pulls;
the other ref verbs act on local files, so they pick among already-pulled
workflows only.

The **interactive picker** (Plan 19/23) shows three states since Plan 32:
pulled (green `●`), unpulled-but-available (yellow `○`), and
**MCP-unavailable (red `⊘`, sorted last)** — Enter on a `⊘` row resolves to
an `enable-mcp` sentinel the CLI turns into guidance (where the n8n-side
switch lives) instead of a failing pull; the legend gains `⊘ not in MCP` only
when such rows exist, and the Enter hint switches to "enter how to enable".
The remote list rides `search_workflows`. Everything else about the picker
(type-to-filter, verb menu, resume loop, skeleton rows, TTY-gating, pure
state machine exported for tests) is unchanged from Plans 19/23/27.

Pulled entries are ordered **newest-synced first** (Plan 29) by a pure exported
`sortByRecency`; the CLI applies it to the **local** list *before* `mergeRemote`,
which appends available-then-unavailable remotes, so the three-group order above
survives for free. **Decision — the recency signal is `<slug>/.decanter.json`'s
mtime, not a stored `lastSyncedAt` field.** Every pull and push rewrites that
file unconditionally, but a no-op sync rewrites it *byte-identically*, so git
sees no diff and the auto-commit stays a real no-op; a committed timestamp would
change on every sync and turn no-op syncs into churn plus spurious commits.
Known limitation, accepted: a fresh `git clone` stamps every state file with the
checkout time, so ordering degrades to the name tie-break until the first local
sync — mtime is a *local-activity* signal, not history. Scripted `list` output
keeps its dir/alphabetical order; re-ordering it would change machine-read
output for no gain.

A picker-run verb that fails on a **forceable** gate offers a retry (Plan 29).
`--force` bypasses exactly one gate — the per-node code-drift guard — so the
offer is keyed on a typed **`ForceableError`** (`lib/errors.mts`) thrown by
`assertNoDrift`, never on sniffing the message: the compliance guard keeps
throwing a plain `Error`, so a layout violation can never be offered a `--force`
that wouldn't help it. The confirm defaults to **No** (bare Enter, anything but
`y`/`yes`, and EOF all decline) and its copy says **draft**, matching what a
forced push actually overwrites since Plan 32. On yes the *same* menu row
re-dispatches with `force: true`, so a flag-carrying row keeps its flags. The
decision lives in the loop, not inside `runPicker`: the readline prompt runs
after `runPicker`'s `finally` has restored the terminal, and is closed before
the next round so raw-mode/keypress re-attach cleanly. Scope: the interactive
`pickerLoop` session only — the no-ref single-select path runs its verb on the
ordinary non-interactive path, which already prints the `--force` hint.

The banner wordmark's `n8n` columns render the **website's brand orange**
(Plan 29) via `style.brand`: `--color-accent-500: oklch(0.7 0.15 60)` converts
to `#E18528`, emitted as a 24-bit SGR because `styleText` has neither an orange
nor truecolor. Gating is delegated to `styleText` itself (one rule for every
color: non-TTY, `NO_COLOR`, `FORCE_COLOR`), and the depth ladder degrades to
xterm-256 `172` then to the pre-Plan-29 `red`. `style.mts` holds the single
derived value for the CLI side; semantic reds (diff `-` lines, the error prefix)
are deliberately left alone.

Output follows **one rule: styling and transient output exist only when the
target stream is a TTY**; piped output is plain line-oriented text and no
information is carried by color alone (the `⊘` glyph carries the third state
by shape). Exit codes: `preflight` exits **1 on a `not ready` verdict** — a
code conflict is a `drift` **fail**, remote code drift a `drift` warn; remote
*structure* changes are an informational `snapshot` finding, not drift
(narrowed by Plan 32: structure is n8n's business, and MCP/skills edits would
otherwise keep CI permanently red). **`diff` always exits 0** — it is an
inspection view like `git diff`, not a gate (Plan 59; this dropped the old
`status` verb's CI exit codes, and CI migrates to `preflight`). `DEBUG=1`
prints stack traces.

## Pull flow (`n8n-decanter pull [id…]`)

For each configured workflow:

1. MCP `get_workflow_details` — the tip (draft if one exists, else the
   published content). Pull mirrors the **tip** by design; a superseded
   published version *is* readable over MCP (`get_workflow_version(versionId)`,
   verified 2026-07-25), but decanter syncs the tip, not history. Unavailable →
   the server's guidance text + the CLI's enable hint.
2. Locate the local folder by id (scan `.decanter.json`s under root). An
   existing folder is kept as-is (sticky, Plan 27); a new one gets the
   kebab slug (`<slug>-<id8>` + warn on collision). Cache the display name.
3. Refresh the id→file map from the snapshot's `//@file:` placeholders — the
   **same** reconcile push runs (§ Push flow 1). This makes a re-pointed
   placeholder (a `.js`→`.ts` conversion) survive a pull that fires before the
   first TS push — notably the live-mirror background refresh after a structure
   edit, which otherwise treated the stale `.js` map entry as authoritative and
   rewrote the placeholder back to `.js` (Plan 35 field-test finding).
4. For each JS Code node (`n8n-nodes-base.code`), matched by node id:
   - **Marker present** → TS-managed: compare `hash(remote body)` vs
     `hash(compile(local .ts))` — in sync → nothing; local == lastPushedHash
     → **instance-side edit**: warn (inspect via `diff`), `.ts`
     untouched; remote == lastPushedHash **or no baseline recorded** → local
     modified, info; both moved → **CONFLICT** warning. No `.remote.js` files
     are written (Plan 32).
   - **No marker, local `.ts` exists** → never clobber TS source: keep the
     `.ts`, warn ("not pushed from TS yet?"), re-baseline.
   - **No marker** → plain JS: overwrite `code/<node>.js` with the remote
     body (git is the safety net; a warning flags when that clobbers
     unpushed local edits).
   - Node renamed → rename the file (id-keyed map), update state.
5. Write the `workflow.json` snapshot (placeholders substituted; derived
   fields stripped — see layout).
6. Update `.decanter.json`: per-node `lastPushedHash` (= remote body hash),
   per-node `name`, workflow `name`; scrub the legacy structure hash.
7. Optional auto-commit (`commitOnPull`).

## Push flow (`n8n-decanter push [id…] [--force] [--publish]`)

Before anything else, two local gates run: the **compliance guard** per
workflow and — unless `--no-typecheck` — the **typecheck** once per push.
Guard errors abort and are *not* bypassable with `--force`.

1. Refresh the id→file map from the snapshot's `//@file:` placeholders (the
   human-visible file map — this is what makes a local `.js` → `.ts`
   re-point take effect). Pull runs the **same** reconcile (§ Pull flow 3), so
   a conversion survives an intervening pull.
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
6. Optional auto-commit (`commitOnPush`).

## Compliance guard (`lib/validate.mts` — the push/watch gate + preflight+s `layout` check)

Unchanged by Plan 32 in substance — the guard validates the *file layer*,
which is exactly the layer decanter still owns. Runs at the start of every
push (and every watch save), and as `preflight`+s `layout` check — offline and
credential-free under `--offline`.

**A watch save runs the same folder-wide guard, with a scoped abort** (Plan 69).
Until then it ran `validateNodeFile` only — one file, no `workflow.json`, so no
node names, so no dangling-reference check: watch pushed exactly what `push`
refuses, and the fast unsupervised path was the lax one. It now calls
`validateWorkflowDir` and fails on the errors `errorsByFile` attributes to the
saved file; folder-level ones (duplicate names, connections, orphans) are printed
per save without blocking. The asymmetry is deliberate and narrow: mid-repair
after a rename, several files are stranded at once, and a folder-wide abort would
stop every save until the last fix — killing watch during the job it exists for. Plan 59 retired the standalone `check`
verb: it removed a *view*, not a *gate*, and preflight+s `layout` finding now
carries every violation in its `details` (what `check` printed in full).

Errors (block push / exit 1): inline `jsCode` in the snapshot instead of a
placeholder; placeholders referencing missing files, `.remote.js` leftovers,
non-`.js`/`.ts` files, or files outside `code/`; a `.js` file ending with an
`@ts-n8n` marker; imports in `.js` nodes / Node-builtin and
un-opted-in-package imports in `.ts` nodes (plans/14, plans/79 — esbuild is
silent about both, so the failure would otherwise surface at runtime on the
instance); missing/corrupt `workflow.json` or `.decanter.json`;
structural integrity of the snapshot (dangling connections, duplicate node
names/ids, orphan code files, dangling literal `$('…')` references in code
and expression parameters).

Warnings (don't block): a relative import resolving outside the sync dir, and
an absolute-path import, in `.ts` nodes (plans/79 — advisory: they endanger
only the author's portability, bundle locally, and esbuild fails loudly
wherever the target is absent; the guard tier owns the printed line on push
paths, `compileTs` stays quiet there and keeps emitting for `node run` /
`diff`); unresolved `.remote.js` / `workflow.remote.json`
leftovers — pre-Plan-32 artifacts; port and delete them.

Typecheck gate: unchanged (see Type checking; scoping, and the template verify
hook — which spawns `preflight --offline` since Plan 59, Prereq 1).
`preflight --no-typecheck` skips it, the escape hatch `check` had.

## Structure & lifecycle acts (n8n's MCP + pull-reconcile)

The structure/lifecycle **verbs are retired** (see "Decisions made") — the
acts live in n8n's MCP tools, reached by agents through the guard, and
decanter's contract is the **reconcile**:

- **Workflow rename** (`setWorkflowMetadata`, or the UI) → next `pull`
  re-caches the display name; the folder never moves (Plan 27).
- **Node rename** (`renameNode`; node id stable) → next `pull` renames the
  local file (kebab collisions get `-<id8>`), re-points the placeholder,
  updates the id-keyed map. **The MCP op rewrites the node name and the
  connections only** — verified live against n8n 2.30.7 and 2.33.3 (Plan 64):
  every `$('…')` ref is left dangling, in Code-node source *and* in other
  nodes' expression parameters, and the op reports success with
  `validationWarnings: []`. Pull mirrors that faithfully; the dangling-ref
  compliance error is what surfaces it. The n8n **editor** does rewrite refs,
  but client-side in the browser before it saves — there is no server-side
  rewrite for any client. Repair is a documented by-hand step, expression
  parameters over MCP first (a forwarded write schedules a mirror pull that
  would clobber an unpushed code fix), then local sources, then `push`.
- **Code node added** (`addNode` **without** `jsCode` — the guard blocks
  code) → the node is born empty; `getWorkflowDetails` normalizes the
  missing `jsCode` to `""`, so `pull` lands it as an empty `code/` file
  (server-minted id and all) and the first `push` seeds the source. Lands
  disconnected — wiring is structure and stays in n8n.
- **Workflow created** (`create_workflow_from_code`; the skills' discipline
  is `validate_workflow` first) → `pull <fresh id>` (MCP-born workflows are
  auto-available; born unpublished; the server assigns the id).
- **Archive** (`archive_workflow`, or the UI) → server-side it unpublishes a
  live workflow first; afterwards the archived-first gate refuses all MCP
  access ("archived and cannot be accessed"), which decanter's verbs surface
  verbatim. The local folder stays as the git record.

## Lifecycle verbs (`lib/lifecycle.mts`)

- **`publish` / `unpublish`** → MCP `publish_workflow` / `unpublish_workflow`
  (in-band `success:false` normalized to errors). Since pushes are
  draft-only, `publish` is THE go-live step: already-published is only a
  no-op when `activeVersionId === versionId`; a diverged draft re-publishes.

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
- **Browser live-reload proxy (plans/5) is removed (Plan 52).** n8n 2.x
  reflects an MCP `update_workflow` draft edit in the open editor **natively**
  (soft canvas re-render via `collaborationService.broadcastWorkflowUpdate` →
  a `workflowUpdated` push, skipped — with a warning — when the tab has
  unsaved edits), making decanter's injected reload proxy redundant and, on
  its dirty-tab path, strictly worse (a hard `location.reload()` would
  destroy those edits). `watch` now just prints the editor deep link and a
  "keep it open" note; `lib/proxy.mts`/`test/proxy.mts` are gone, along with
  the `browserReload`/`proxyPort` config keys. The write-lock failure mode
  this surfaces (n8n's single-writer `LockedError` when a human is mid-edit)
  is tracked separately, plans/draft/53.

## MCP guard (`mcp connect` stdio + `mcp serve` HTTP, plans/33 + retirement wave)

Technical enforcement of the Code-node boundary the template's `AGENTS.md`
states in prose — one guard core (`guardMessage` in `lib/mcpserve.mts`), two
transports:

- **`mcp connect` (`lib/mcpconnect.mts`) is the default route** — a stdio MCP
  server the agent spawns itself, which is what lets `init` scaffold a
  static, secret-free `.mcp.json`/`opencode.json` entry
  (`{"command":"npx","args":["--no-install","n8n-decanter","mcp","connect"]}`):
  the instance MCP is wired the moment init runs. The `npx --no-install` prefix
  (Plan 58) resolves the command whether decanter is installed globally or as a
  local project dependency — a bare `n8n-decanter` only resolves on the agent's
  `PATH` (a global install) and would otherwise **silently fail to start**,
  dropping the agent onto whatever other n8n route it has, unguarded;
  `--no-install` never downloads, so a missing install fails loudly. Both that
  resolution and the guard's config lookup are relative to **the dir the agent
  started in**, which is the sync dir only when it is also the project root —
  the entry hoisted to a repo root above it needs `N8N_DECANTER_DIR` plus a
  root-resolvable command (Plan 81; see Config and Init flow). One JSON-RPC message per line; stdout is
  protocol-only (stderr logging; the dispatcher builds a stderr `Log` and a
  stderr-logging `McpClient`); strictly ordered processing (session-id
  capture race-free); SSE responses decoded back to per-line JSON; n8n's
  202-empty for notifications emits nothing; upstream-down answers an
  in-band JSON-RPC error naming the host; parse failures fail closed
  (-32700); same 401-refresh-once and bounded 429/Retry-After policy as the
  MCP client. No secret exists — stdio pipes are private to the two
  processes.
- **`initialize` is the one message the guard will answer itself.** It is
  forwarded like everything else — that is how the upstream `mcp-session-id`
  is captured — but a *failed* forward is answered locally with the guard's own
  `serverInfo`/`capabilities` instead of a JSON-RPC error. Rationale: an error
  at the handshake is fatal to the whole MCP session, so an unreachable
  instance took the guard down with it and the agent never got to make the call
  whose failure would have explained why (reported against 0.10.0, from a host
  missing on a sandbox allowlist). The guard is itself the server the agent
  spawned and it is running fine; the instance's absence belongs on the first
  forwarded tool call. A handshake answered this way is **replayed upstream**
  before the next forward (followed by `notifications/initialized`), so a
  recovered instance never sees an uninitialized session. The startup log line
  says `guard: ready — … to <host>`, never "connected": nothing has been
  contacted when it prints.
- **`mcp serve` is the HTTP variant** for harnesses that only take an MCP
  URL. Decanter is the sole credential holder: the proxy authenticates
  agents with a per-session random secret (printed once; also written with
  the endpoint to a gitignored `.decanter-proxy.json` for tooling discovery)
  and forwards upstream with the real bearer/OAuth token via
  `McpClient.bearerToken()` — inheriting the refresh-race coordination; one
  forced refresh on an upstream 401.
- **Requests are parsed, responses pipe through untouched** (SSE included).
  The block rule: `tools/call` → `update_workflow` that writes Code-node
  source → answered in-band with an instructive `isError` tool result
  ("edit the file + push"). Both write routes n8n's `update_workflow` op
  vocabulary exposes are covered: a `jsCode` **key** at any depth
  (`updateNodeParameters`/`addNode`), and a `setNodeParameter` whose
  JSON-Pointer `path` targets `jsCode` (code in a scalar `value`, no key —
  the bypass the branch review caught). The rest of the op vocabulary is
  deliberately NOT enumerated; only these two source-writing routes are
  intercepted. The **second** block rule (Plan 64 task 3c, `guardPublish`):
  `tools/call` → `publish_workflow` whose draft carries dangling node references
  is refused, so the go-live gate `publish` runs can't be walked around by
  calling the raw MCP tool. It is async (one `get_workflow_details` round-trip)
  and therefore separate from the sync `guardMessage`, but shared by both
  transports the same way; a failed read **fails closed** and the message names
  the *check* as what failed. Unparseable bodies **fail closed** (403), bodies
  over 10 MB get
  413 (drain-then-respond — destroying the socket would RST before the
  client reads the answer), non-secret requests 401 without touching n8n.
- Binds `127.0.0.1` only; default port 5680 (`--port`, `0` = ephemeral).
  Blast radius is availability, not integrity: decanter's own sync never
  routes through the proxy.
- **Live snapshot mirror (Plan 51 Part A, `lib/mirror.mts`).** Both transports
  share one orchestrator: after forwarding a **non-blocked** `update_workflow`
  (a structure edit), the guard calls `mirror.schedule(arguments.workflowId)`,
  which debounced-background-`pull`s that workflow so `workflow.json` refreshes
  with no manual `pull` (`mirrorTargetId` in `mcpserve.mts` extracts the id;
  the same client the guard forwards with does the pull). Rails: fire-and-
  forget (scheduled *after* the response relays — never blocks the agent);
  git-required + safety-commit-before-pull; per-workflow debounce + overlap
  guard (an injected clock makes it unit-testable); tracked-only. On by
  default; `liveMirror: false` disables it. The orchestrator is a pure
  scheduler over an injected `refresh`/clock/git-probe, so the debounce/overlap
  logic is tested without ports or a real pull.
  - **It is a full `pull`, and the agent is told when that costs it something**
    (Plan 68). Code files and `.decanter.json` are rewritten too, file moves
    included, so an unpushed local edit can lose. `pullWorkflow` returns the
    clobbered files; the mirror turns them into a notice, and
    `attachMirrorNotices` (shared, in `mcpserve.mts`) appends it to the next
    successful **tool result** — the one channel an agent reads, since the
    mirror's own logger is stderr-only so stdout stays pure protocol. The queue
    drains only once a message can actually carry it (a handshake in between must
    not eat the warning), and delivers once — a notice repeated on every later
    call is noise an agent learns to skip.
  - **Deliberate transport asymmetry:** this reaches agents on `mcp connect`
    only. `mcp serve` pipes upstream responses through untouched, SSE included;
    buffering them to inject an advisory line would cost streaming on every
    response to deliver it on some. The stderr warning stays the signal there.
    Not a drift bug — the two *refusals* remain shared, which is the invariant
    that matters; this is an advisory.
- Template stack: `mcp-route-check.mjs` (SessionStart hook, shared script —
  config-drift detector, not an op inspector) warns when an agent MCP config
  reaches an n8n `/mcp-server/http` endpoint that isn't loopback — project
  files in the sync dir *and* the user-level configs of known harnesses
  (`~/.claude.json` incl. its per-project entries, `~/.cursor/mcp.json`, the
  VS Code user profile, opencode's global config; Plan 58 task 2, the
  "second door" a project file never shows); `AGENTS.md.example` states the
  boundary proxy-first.

## Scenarios — committed pin-data sets (`scenario`, plans/7 + 37)

`lib/simulate.mts` (scenario read/write) + `lib/executions.mts` (dir consts,
migration) — a **scenario** (`workflows/<folder>/scenarios/<slug>.json`) is a
named, committed input set for a workflow — captured from a real run or
scaffolded from its schemas — replayed and diffed by both
`preflight --simulate --scenario <slug>` and `test --scenario <slug>`. It's the **one
committed pin artifact** (Plan 37 folded the earlier `mock`/`fixtures` split
into it):

- **Self-contained, no precedence.** A scenario is execution-shaped
  (verbatim capture + a `_decanterScenario` metadata block) — every
  pinnable node's data lives in one file; there is no fixture-over-capture
  layering to reason about (the earlier per-node `fixtures/` mechanism and
  `simulate --pin` are removed outright). Chosen explicitly by slug, never a
  "latest" default.
- **Two composable seeds.** `scenario create --execution <id>` promotes a
  gitignored capture, recording each node with captured output as
  provenance `capture` and listing every remaining gap under
  `_decanterScenario.fill`. `scenario create --scaffold` calls MCP
  `prepare_test_pin_data` (read-only) and annotates each gap with its
  output **JSON Schema** (`expectedSchema`), provenance `scaffolded` — the
  tool returns schemas + coverage counts only, **no data**
  (`readOnlyHint: true`; this corrects an earlier misread of the tool that
  assumed server-generated synthetic data). A bare `--scaffold` with no
  `--execution` builds a from-scratch set where every pinnable node is a
  fill entry. Neither seed **invents** a value — filling stays a person's
  or agent's authoring step, reviewed like any other scenario edit.
- **Per-node provenance drives the report.** Each node's pins are
  `capture` (real data — usable as a diff baseline), `authored`
  (hand/agent-filled, no schema), or `scaffolded` (schema-guided). A run on
  a scenario with **any** non-`capture` node is reported "synthetic pins —
  proves executability, not output correctness": no per-node diff is
  asserted for it, and divergence is informational, not a fail. A
  capture-only scenario keeps the full per-node diff and
  exit-1-on-divergence semantics unchanged. `--json` reports
  (`preflight --simulate` / `test`) carry `syntheticPins: boolean` and
  `provenance: Record<node, "capture" | "authored" | "scaffolded">`.
- **Multi-output pins: the sim replays them, `test` structurally cannot**
  (Plan 66). The split is n8n's, not a decision: `test` hands over a `pinData`
  map — one flat `INodeExecutionData[]` per node, **no output dimension** — so
  the instance run replays `main[0]` and nothing else. `preflight --simulate`
  pins by **node replacement**, and that topology is decanter's own, so each
  populated output beyond the first now gets its own Code stand-in
  (`__sim_out__<i>__<node>`) that **inherits the original's incoming edges** and
  takes over that output's targets (`splitPinnedOutputs`). Input-inheriting, not
  entry-wired, on purpose: an entry-wired stand-in fires from the synthetic
  trigger and would inject a branch's items into a replay whose real nodes took
  another path. `Simulation.splitOutputs` / `SimulationReport.splitOutputs`
  report the splits.
- **"Executable" has to mean something — item coverage bounds the synthetic
  verdict** (Plan 66). A pin feeding a branch nothing reads leaves the
  downstream nodes with no input; n8n
  finishes that run as `success` and the synthetic-pin report used to repeat it
  verbatim. `test` now counts, over the **unpinned** nodes (the ones the run
  really executed), how many emitted an item on **any** output —
  `TestReport.coverage = { total, emitted, empty }`, also in `--json` — and
  prints it. Partial emptiness warns; **`emitted === 0` with `total > 0` makes
  the report not-ok** (exit 1), because a run that moved no data demonstrated
  nothing. `scenario check` reports the instance-side truncation one step
  earlier and offline: a scenario node with items on more than one output
  (naming which path replays it), and any node source reading a pinned node's
  non-first output (`$('X').all(1)` / `$items('X', 1)` — `findBranchReads` in
  `lib/util.mts`).
- **Migration.** A pre-Plan-37 `mocks/` dir auto-migrates to `scenarios/`
  the first time any verb (`preflight`/`test`/`scenario`) touches it (plain
  `renameSync`, git-recorded); refuses when both dirs exist. A leftover
  `fixtures/` dir is a **hard error** naming the replacement — no read
  path, no silent fold (per-node fragments merging onto a gitignored
  capture would commit data nobody reviewed). The legacy metadata key
  `_decanterMock` is still read (as `_decanterScenario`) for scenarios
  written before the rename.
- **`scenario check`** validates one scenario or every scenario in the
  folder, offline, against the exact runData shape the simulate stage consumes
  (n8n publishes no JSON Schema for execution data);
  `preflight --simulate --scenario`/
  `test --scenario` run the same check on load.
- **Two gates, deliberately different — and now stated as such (Plan 65).**
  `preflight --simulate` demands data only for nodes the capture **reached**
  (an unreached node is neutralized, so worst case the replay stops);
  `test` demands **every** pinnable node, because it runs on the live
  instance with real credentials and a node reached unexpectedly there hits
  the real world. Keeping both is right; reporting only the looser one was
  not — a capture-seeded scenario could be green and still be refused by
  `test`, with no supported way to fix it (`scenario create` refused an
  existing file). Three changes close that: (1) `scenario create
  --execution` pins a pinnable-but-unreached node to an **empty run** and
  records it under `_decanterScenario.notExercised` — an honest
  "this branch isn't exercised", never an invented value, and the empty pin
  keeps the node from running for real; (2) `scenario check` reports the
  `test` gate alongside the simulate one; (3) `scenario create --extend`
  tops an **existing** scenario up with the nodes it lacks, additively, so
  `test`'s refusal has a supported way out instead of hand-edited JSON.
- **Relation to the official skills.** `n8n-workflow-lifecycle-official`
  teaches the same `prepare_test_pin_data` tool for an **ephemeral**
  in-session flow (schemas → agent-generated values → `test_workflow`,
  per-execution, unpersisted). Scenarios are the durable counterpart:
  committed, human-reviewed, reused across runs, and diffed against real
  data when capture-seeded.

## Backups — git-native disaster recovery (`backup`, plans/51 Part B)

`lib/backup.mts` (+ `lib/api.mts` `getWorkflow`/`createWorkflow`) — a
**versioned, redeployable** DR store per workflow
(`workflows/<slug>/backups/<ts>.<versionId>.json`), REST-sourced because MCP's
read is sanitized (the spike verdicts are recorded in the design-decisions
section above). It is disaster recovery, **not** sync: `restore` creates a
*new* workflow, never reconciling an existing one — structure ownership stays
with n8n.

- **`backup create`** REST-GETs the draft tip, **dedups** on an unchanged
  `versionId` (no redundant identical copies), strips `pinData`/`staticData`,
  keeps credential refs + `description`, and replaces each **tracked** Code
  node's `jsCode` with its `//@file:` placeholder (no code duplication; an
  untracked Code node keeps inline code + a "pull first" warn). Writes the new
  timestamped file, then **rolling-prunes** the working set to `backupLimit`
  (default 20; `0` = keep all — git holds the full history regardless).
  **Not auto-committed** and **not self-gitignored** — the file carries
  credential refs + any embedded secrets, so the user reviews + `git add`s
  deliberately; committing it is the whole point.
- **`backup restore`** selects a backup (latest default; an optional positional
  **backup ref** / a TTY chooser), compliance-guards the folder, re-inlines each
  placeholdered Code node's source from `code/` (reusing `buildNodeCode`/
  `placeholderFile` from push — `.ts` compiled), and REST-POSTs an **allowlist
  body** (`name`/`nodes`/`connections`/`settings`) → a **new** workflow, node
  ids preserved, landing **unpublished**. Prints credential-rebind hints (refs
  point at the source instance) + the editor URL; publish is the operator's
  next step.
  - A **backup ref** resolves by shape, like a workflow ref: timestamp (exact or
    a filename prefix — a bare date works) **or** versionId (the short one in
    the filename, the full one pasted from n8n, or the one stored inside the
    file). Both keys are in the filename `<timestamp>.<versionId>.json`, so one
    argument covers both and the caller never declares which kind it has; the
    two key spaces don't collide (dates vs. uuids), so first-match-wins needs no
    tie-break. **v0.6.0 shipped this as `--version <id>` / `--at <ts>`**; both
    were removed in favour of the positional (breaking) because `--version` is
    reserved CLI-wide — and are hard-errored rather than ignored, since a
    dropped `--at=<ts>` would silently restore the *latest* backup. An
    unresolvable ref is an error, never a fallback.
- **`backup list`** (offline) prints the retained set: timestamp · versionId ·
  node count.
- **Auth:** REST-only → `requireApiKey` gates `create`/`restore` (`list` is
  offline). The `backup` namespace mirrors the `node`/`scenario`/`mcp`
  sub-verb dispatch in `n8n-decanter.mts`.

## Instance-side test runs (`test`, plans/33)

`lib/testrun.mts` — the recommended runtime check, wrapping MCP
`test_workflow` (synchronous; the server caps the run at 5 minutes, so the
verb uses a dedicated client with a ≥320 s timeout):

- **Pin split = the simulate stage's classification** (shared `lib/simulate.mts` code): every enabled
  non-pure, non-loop-driver node — trigger/network/credentialed — is pinned
  from the capture (`--execution`, default newest) or a committed scenario
  (`--scenario`, see above); a node with no pinned data is a hard **gap**
  error before anything runs (an unpinned network node would hit the real
  world). Pure nodes execute for real on the instance; `--trigger` →
  `triggerNodeName`. Provenance/synthetic-pins labeling is shared with
  `simulate` (above).
- **Always the draft tip.** Pre-check read captures `versionId` +
  per-node byte-exact jsCode. Local ≠ draft on a TTY → the what-to-test
  prompt (local = drift-guarded draft-only push first; draft wording:
  live-workflow vs current-draft); unpublished skips the prompt and pushes.
  After a pushed test: keep, or restore via `restore_workflow_version`
  (n8n ≥ 2.29) with a write-back fallback gated on the draft still matching
  our push; the pre-push snapshot persists crash-safe in
  `executions/.test-snapshot.json` (the test verb writes the `executions/*`
  self-ignore first, so the snapshot's inline jsCode can never be committed
  by the push auto-commit even in a repo without the root-level ignore);
  state re-baselines after restore so
  local edits read "pending push", not conflict. **Non-TTY never mutates**
  and prints "tested the draft, not your local code" when local differs —
  no choice flags, choices are verb composition.
- **Diff** (client-side): the test execution is read back over MCP
  `get_execution(includeData)`; each pure node with captured expectations
  diffs first-run/first-output items via `lib/simulate.mts`'s `diffItems`; exit 1
  on divergence; `--json` emits the report. The verb takes exactly ONE
  workflow ref (the plan sketched `[workflow…]`; selectors are per-workflow,
  so multi-ref was dropped for parity with the local-engine replay).
- The local-engine replay stays the offline sibling (decided 2026-07-22; folded
  into `preflight --simulate` by Plan 59): pre-push verification of uncommitted
  code, CI without an instance (`--offline --simulate`), isolation, version
  rehearsal. *(Docs originally recommended `test` first everywhere;
  Plan 60/#162 reversed that — `test` runs the draft, so it belongs AFTER the
  push, and the local-engine replay is the pre-push runtime check.)*

## Preflight — the scored verification gate (`preflight`, plans/36)

`lib/preflight.mts` orchestrates the ladder into one read-only, scored verdict.
It adds **zero execution paths** — it reuses `validateWorkflowDir` /
`computeSyncFacts` / `runSimulation` / `executions` quietly (a silent `Log`)
and scores their returned facts. Nothing
it does mutates (no push/publish/restore/draft write) **and nothing it does
runs the workflow on the instance**.

**Plan 60 — the ordering fix.** `preflight` originally ran `test` as its
instance-side runtime stage. `test_workflow` executes n8n's **draft**, while
every other stage grades **local files**, so whenever a push was pending one
score described two different artifacts — flagged only by the `parity` warn's
−10. The verb surface now encodes the honest order:

```
preflight → push → test → publish
```

Each step verifies the artifact the previous one produced: `preflight` grades
local code (reads the instance for sync facts only), `push` makes it the draft,
`test` grades what was pushed, `publish` goes live. `runTest`'s `neverMutate`
flag is gone with the stage — the read-only guarantee is now structural
(preflight never calls `runTest`) rather than a mode.

**`test` has two tiers (Plan 64).** Bare, it grades the draft **statically** —
`danglingNodeRefs` over the nodes the instance returns — and executes nothing.
With `--execution`/`--scenario` it is the pinned run, which now runs the static
scan first so a known-broken draft is never fired at the instance. The
latest-capture fallback is **gone**: a bare `test` used to execute for real,
steered by whatever sat in the gitignored `executions/` dir, so the same commit
behaved differently for different people. `publish` gates on the same scan,
applied to the `getWorkflowDetails` read it already makes — the instance's
draft, never the local `workflow.json`, which is a snapshot and would
false-green on a stale mirror and false-red on a fresh clone. Running it in both
places is intentional: the instance can change in between, so only the check
inside `publish` is authoritative for that publish.

- **Ladder (stable check ids agents key on), fast → slow:** static `layout`
  (`validateWorkflowDir`), `types` (`runTypecheckResult`); sync `connect` +
  `access` (one `getWorkflowDetails` — a reach-and-auth success is `connect`
  pass, an `isUnavailableInMcp` refusal is `connect` pass + `access` fail, any
  other error is `connect` fail), `parity`/`drift`/`snapshot` (from
  `computeSyncFacts` — the per-node code-sync fact core, since Plan 59 the
  single source shared by preflight's sync tier and the `diff` verb;
  `statusWorkflow`'s standalone summary renderer died with the verb),
  `lifecycle` (`publicationState`/`publishedVersionLagsDraft`),
  `history` (production-run health), `capture` (a pin source exists + matches
  the draft); runtime `simulate` (`runSimulation` headless, `networkNone`
  forced) — the **only** runtime stage since Plan 60, opt-in behind
  `--simulate` since Plan 59, and it replays *local* code on a *local* engine.
  The check **id** stays `simulate` even though the verb is gone: agents key on
  it and `--require=simulate` depends on it.
- **Depth: two orthogonal flags, no profiles** (deterministic, no
  auto-escalation — Plan 59 deleted the `Profile`/`PROFILES`/`profileSpec`
  machinery, and `--full`/`--quick` with it, leaving no tombstone: pre-1.0 the
  maintainer's call was a clean surface over a migration shim, so both are now
  merely unrecognized flags). `--simulate` is **additive**
  (appends the local-engine stage); `--offline` is **subtractive** (drops the
  instance-reads tier and joins the dispatcher's `offline` set, so `loadConfig`
  skips `requireHost`). One pure function, `activeStages({simulate, offline})
  → {sync: !offline, simulate}`, is the whole model; they compose:

  ```
  preflight                       static + instance reads            (the default gate)
  preflight --simulate            + a local-engine run of your code
  preflight --offline             static only — no instance contact  (edit hook, air-gapped CI)
  preflight --offline --simulate  static + local engine, no instance
  ```

  **The inversion to remember:** the old `--offline` *profile* implied the
  engine replay; the new `--offline` *flag* does not. `--offline --simulate` is
  the old `--offline`. The flag name is unchanged, so nothing errors — it just
  quietly does less, which is why it shipped as its own **Breaking:** entry.
- A stage the flags don't activate is a `skip` with an `unlock`, never a silent
  omission. `--require=<ids>` promotes such a skip to a `fail` (the CI teeth);
  `--require=test` is rejected via `RETIRED_CHECK_IDS` with the flow as its
  remediation.
- **`--viewer`** (Plan 59, with `--simulate` only): leaves a browsable
  throwaway n8n running so the replayed run can be opened in the UI. It does
  **not** weaken the safety contract — `runSimulation` already runs two
  containers, and only the graded `runEngine` one gets `networkNone`. Under
  `--viewer` a multi-batch-loop workflow reports `simulate` as a **skip**
  ("a preview, not a pass/fail check"), never a pass: that path returns
  `ok: true` with an empty diff, so scoring it green would be a lie.
- **`--no-typecheck`** skips the `types` stage — the escape hatch the retired
  `check` verb had.
- **`details[]` on every finding** (Plan 59): with `check` gone, the static tier
  is the only view of a layout violation or a type error, so a finding carries
  the *full* list behind its one-line message (every violation, every `tsc`
  line, the drifted node names, the viewer URL). Correspondingly `layout`/
  `types` failures carry **no `remediation`** — that field is contractually a
  runnable command, and "edit these files" is not one.
- **Scoring/verdict/coverage are pure functions** (unit-tested without IO):
  score starts at 100, each `fail` −40 (a `CONFLICT` `drift` −30), each `warn`
  −10, floor 0. Verdict: any `fail` → `not ready` (exit 1); else any `warn` →
  `caution` (exit 0, `--fail-on=warn` → 1); else `ready`. `--require=<ids>`
  promotes a skip of a named check to a `fail` at emit time (so the streamed
  line, the summary, and `--fail-fast` all agree). `--json` emits the report
  (single object, or an array for a multi-ref run); `--fail-fast` stops after
  the first failure. Since Plan 59 the report carries the resolved
  `flags: {simulate, offline}` where a `profile` string used to be, and each
  check may carry `details[]` — the machine-readable half of the break, and the
  one no doc *page* would otherwise mention.
- **Executions in the gate:** before the runtime tier, a `capture`-source run
  with no explicit `--execution` auto-fetches the newest capture when
  `N8N_API_KEY` is set and the local one is missing/stale (`--no-fetch` opts
  out; read-only, gitignored). Since Plan 60 this only fires when a runtime
  stage is active (`--simulate`) — without that flag there is no runtime stage,
  so a missing capture is `info`, not `warn`. `history` reads recent production runs via a new
  MCP `searchExecutions` wrapper (`search_executions` — shape source-verified
  and smoke-asserted on 2.30.7: `{data:[{id,workflowId,status,mode,startedAt,
  stoppedAt}],count,estimated}`) with a REST `listExecutions({includeData:
  false})` fallback (a new lightweight variant — the old one always pulled full
  run data); a live workflow that's been failing is a `warn`, never a `fail`.
- **Seams added (all behavior-preserving):** `runTypecheckResult` (fact core
  under `runTypecheck`), `computeSyncFacts` (the per-node code-sync fact core,
  now shared by preflight's sync tier and `diff`),
  `api.listExecutions({includeData})`, `mcp.searchExecutions`. *(The
  `runTest({neverMutate})` seam went with the test stage — Plan 60/#162.)*
  Multi-ref like `pull`/`push`/`diff` (no-ref TTY → picker; piped → config
  workflows; aggregate exit) — and, since Plan 59, a no-ref run with an empty
  config `"workflows"` falls back to every *pulled* workflow, the behaviour the
  retired `check` verb had.

## Code diffs (`diff`, plans/59)

The promoted half of the retired `status` verb: `preflight` is `git status`
(the scored summary), `diff` is `git diff` (the actual changed lines). Splitting
them is what let three overlapping "check my thing" verbs collapse into two with
no capability lost.

- **The reporting ladder answers to `push`, not the other way round.**
  `computeSyncFacts` judges each node as in-sync → push-pending →
  changed-remotely → conflict, and two rules keep it from inventing drift the
  CLI does not actually have (both were real 0.10.0 bug reports):
  - **No baseline is not a remote edit.** An absent `lastPushedHash` makes
    "both sides moved" unmeasurable, so the node reads `push-pending` — the
    same relaxation push's `codeDrift` has always made. Before this, `diff`
    printed CONFLICT and `preflight` failed its drift gate on state `push`
    accepts without `--force`, and the scaffolded agent permissions **deny**
    `--force`: the report described a dead end the CLI did not have.
  - **The `//@file:` placeholder is the file map here too.** The fact core runs
    the same `reconcileFileMapFromSnapshot` push and pull run (in memory — it
    never writes state), so a sanctioned `.js`→`.ts` conversion reads as
    `push-pending` on the `.ts` instead of "local file … missing" on the
    deleted `.js`.
  Preflight's `parity` check follows from the same facts: it may report a match
  **only** when every node is in sync, so it can never print "local code
  matches the draft" one line above drift's `CONFLICT`.
- `lib/diff.mts` — `diffWorkflow` over `computeSyncFacts` (the same fact core
  preflight's sync tier scores, so the two can never disagree) plus the
  existing `unifiedDiff`. `.ts` nodes are compiled first, bundling `shared/*`,
  so the diff shows the exact bytes `push` would send — and a shared-helper edit
  surfaces on **every** importing node.
- Prints only nodes that are **not** in sync (`git diff` semantics), plus
  deleted-remotely warnings; a clean tree says so in one line. The in-sync
  roll-call, the publish state, the live-lags-draft note and the snapshot-stale
  hint all moved to preflight findings (`parity` / `lifecycle` / `snapshot`) —
  nothing was dropped, only relocated.
- **Always exits 0.** It is an inspection view, not a gate. This deliberately
  drops `status`'s CI exit codes; a pipeline that gated on drift now gates on
  `preflight` (whose `drift` check fails on CONFLICT and warns on remote drift).
- Multi-ref like `pull`/`push`, no-ref TTY → picker.

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
3. **Optional API key** prompt (Enter to skip) — executions / data-tables /
   backup only (Plan 33 + 51).
4. `.env` is rewritten preserving unknown keys (comments are not preserved);
   template copy (modification-aware manifest machinery, unchanged — see
   below), `decanter.config.json` scaffold, `.gitignore` (now also covering
   `.decanter-auth.json`).
5. **Verification probes**: an MCP `search_workflows` reporting how many
   workflows are visible and how many are `availableInMCP` (with a hint about
   the per-workflow switch), plus the old `GET /api/v1/workflows?limit=1`
   probe when an API key was given.
6. **The official-skills pointer** (Plan 55, `lib/skills.mts`) — dead last, so
   it can never block credential setup. On a **first** init (no
   `.decanter-template.json` yet) decanter names the pack and prints the
   **shell** install commands for all three routes (Claude Code / Codex /
   skills.sh), detected agent first, each with its activation step. Detection
   reads env / `PATH` / home markers and **spawns nothing**.

   It is **output only, on every path, consuming no input** — deliberately not
   a prompt and not a subprocess. A prompt would add a fourth positional answer
   to init's stdin and break every existing script; a subprocess would mean
   decanter driving three third-party CLIs with their own version floors to
   mutate user-global agent state, at the most fragile moment of setup, for a
   plugin that isn't active until the agent reloads anyway. No flag tunes it:
   once per sync dir is cheap enough that a CLI surface isn't warranted.

   Claude Code's `<claude-code-hint/>` stderr protocol would be the natural fit
   but is silently dropped for non-Anthropic marketplaces, so it isn't used.
   Actually *installing* — declaratively, via `.claude/settings.json`
   (`extraKnownMarketplaces` + `enabledPlugins`) — is Plan 56.

**The nested-sync-dir note (Plan 81).** The three agent files init scaffolds
(`.claude/settings.json`, `.mcp.json`, `opencode.json`) are exactly the ones an
agent loads *only from the dir it was started in*, so init says so when the sync
dir is not that dir. `projectRootAbove` (`lib/init.mts`) walks **strict**
ancestors for a `.git` (checked with `existsSync` — a *file* in worktrees and
submodules) or, failing that, a `package.json`; `.git` wins over an intermediate
manifest, since in a monorepo the repo root is the dir people open. Strict
ancestors are what keep the test cheap: the sync dir's own scaffolded
`package.json`, and a `git init` run inside it (the shape the docs teach), never
register. The note rides the **same gate as the restart reminder** — the run
that first scaffolds those files — so a standalone dir, the shape everything
assumed until now, stays completely silent, and a re-init never repeats it.
**Plan 83 turned that gate into a branch**: the two lines are alternatives, not
a line plus an addendum. "Restart your agent" is true only where a restart can
change the answer, and in a nested dir it cannot — startup discovery walks *up*
from the launch dir, so a session started at the root re-misses this `.mcp.json`
every time, however often it restarts. The detection already distinguishes the
cases, so the nested run prints "loads from the dir the agent was STARTED in;
started higher up, no restart ever loads them" plus A/B, and the bare restart
line fires only in the flat case where it is the fix. The same two-cause split
— *wiring is new* (restart) vs. *wiring is below you* (start here, or wire the
root), discriminated by "is that `.mcp.json` below the dir you started in?" —
is now taught everywhere the restart claim appears: the scaffolded `AGENTS.md`,
`docs/agents/overview.md`, `docs/cli/init.md`, and a troubleshooting entry.
It came out of field-test round `ftrun-468939`, where a blind agent hit the
missing tools in the nested layout, quoted our own `AGENTS.md` back at us, and
concluded "restart" — a dead end it was saved from only by not needing the
tools. What still works in both cases is the CLI, which carries its own config
and credentials and never depended on the agent wiring; that is the fallback
the guidance now names, since the code layer stays fully open while only
MCP-side *structure* work is blocked.
Option A leads (`cd <syncdir> && claude`): zero further config, and the only
shape in which the scaffolded permission globs stay anchored where they were
written; its one cost is that the surrounding project's own
`.claude/settings.json` then does not load (its `.mcp.json` still does, via the
ancestor walk). Option B is the paste-ready root wiring and needs **both**
halves or it still fails: the `N8N_DECANTER_DIR` pin *and* a root-resolvable
command, because `npx --no-install` resolves from the launch dir's
`node_modules/.bin` — the sync dir itself under a local install. Every printed
path and glob carries the sync-dir prefix, above all `Read(<rel>/.env)` /
`Edit(<rel>/.env)`: a relative pattern anchors at the settings file declaring
it, so a verbatim hoist would guard the *root's* `.env` and silently stop
protecting the credentials file. `${CLAUDE_PROJECT_DIR}` is named only as a
thing not to reach for — it expands to the parent, so it reads as if it pointed
at the sync dir and never does. **init prints, never writes into a parent**: the
parent's config usually carries other servers and is not guaranteed to be the
agent's root (same boundary as Plan 80 — setup stays the user's).

**One shared prompt session** serves every question — a second
`createPrompt()` would lose piped answers the first one buffered (the same
class of bug the buffering prompt helper solved in the API era; rediscovered
when init grew multiple questions).

The template machinery (dpkg-conffile-style `.decanter-template.json`
manifest, `X.example` materialization, `--force` semantics) is otherwise
unchanged from plans/16, but Plan 56 added the one case it could not express:
**a template file that changes NAME**. The manifest is keyed by path, so a
rename otherwise reads as "delete one, add another" and both copies coexist —
which for a settings file means the stale one silently keeps applying.
`TEMPLATE_RENAMES` in `lib/init.mts` lists `{from, to}` pairs resolved *before*
the scan, file-driven rather than manifest-driven (a rename doesn't change
contents, so hashing answers "is this decanter's copy, untouched?" even for
dirs pre-dating manifests): not ours → untouched; ours and pristine → deleted
so the scan lands the new name; ours but edited → kept, and the new name is
**skipped** this run (writing both would double-register the hooks), with the
old key carried over in the manifest so the *next* re-init can still tell it
from a user file; both present → reported only. `--force` removes the old file
regardless, per its reset contract. Its first use:
`.claude/settings.local.json` → `.claude/settings.json` — project policy
(decanter's verb permissions + the `verify.mjs`/`mcp-route-check.mjs` hooks),
already committed and manifest-tracked, so `local` was the wrong scope *and* it
squatted Claude Code's per-user override slot. Permission lists merge across
scopes and `deny` beats `allow`, so the demotion does not weaken the denies.

The template's agent contract (`AGENTS.md.example`) was rewritten
for Plan 32: Code-node source is authored as files and synced by decanter —
never edited on the instance (UI, MCP tools, or skills); `workflow.json` is a
read-only snapshot; structure/lifecycle may go through n8n's MCP tools and
the official n8n skills pack, whose **knowledge** skills are recommended
while the build/lifecycle skills are subordinated to the decanter override
(Task 9 — the override, not selective installation, holds the boundary; the
pack installs whole). Plan 55 added the install instructions there in both
forms (in-session slash commands *and* the shell CLI — they are not
interchangeable) plus the `using-n8n-skills-official` routing cue the
plugin-less skills.sh route needs, since that route ships no SessionStart hook.

## Type checking

Unchanged by Plan 32 (the file layer is decanter's layer):

- `tsconfig.json`: `allowJs` + `checkJs`, includes `workflows/`, excludes
  `**/*.remote.js` (harmless legacy exclusion); `moduleDetection: "force"`.
  Helper imports resolve through `moduleResolution: "bundler"` (the docs teach
  the extensionless form) **plus `allowImportingTsExtensions`** — legal because
  `noEmit`, and needed because esbuild resolves an explicit
  `../../../shared/money.ts` too: without it the typecheck rejects (TS5097)
  what `push` bundles happily, i.e. the gate and the bundler disagree over a
  spelling. Tolerance, not a recommendation — extensionless survives a helper
  later becoming `.js`.
- `scripts/typecheck.mts` wraps node files in an in-memory `async function`
  (node files recognized by a `.decanter.json` sibling — directly or in the
  parent of their `code/` dir) and maps diagnostic lines back; files on disk
  stay verbatim. `decanter-ts-plugin/` suppresses TS1108/TS1375/TS1378 on
  node files in editors (plans/4).
- `npm run typecheck` = `tsc -p tsconfig.cli.json` (the CLI's own strict
  sources) + the wrapper script.

### The emulated-globals surface (Plan 43)

`n8n-globals.d.ts` is decanter's **own** hand-written, MIT-clean subset of n8n's
Code-node globals (n8n's authoritative surface — `WorkflowDataProxy` +
`getAdditionalKeys` — is Sustainable-Use-Licensed, so its text is never
vendored). It is **single-sourced**: `init` copies the one root file into a sync
dir (no `template/*.example` duplicate to drift).

`node run` is the **offline approximation** rung of the verification ladder, not
a faithful n8n context — `test` (real draft over MCP) is the fidelity backstop.
Its `buildGlobals` ([lib/run.mts](lib/run.mts)) classifies each declared global as
one of three, and a parity test keeps *declared* (the `.d.ts`) and *emulated*
(`buildGlobals`) in lock-step — every global is exactly one of:

- **Emulated** — pure/offline meaning: `$jmespath`/`$jmesPath` (n8n's pinned
  `jmespath@0.16.0` `search(data, expr)`), `$items`/`$node` views over the
  fixture, Luxon `DateTime`/`Duration`/`Interval`, `$nodeId`/`$nodeVersion` from
  the node entry.
- **Pinnable** from the fixture: `$input`/`$json`/`$env`/`$vars`/`$secrets`/
  `$workflow`/`$execution`/`$getWorkflowStaticData`/…
- **Signposted** — genuinely instance-scoped, so `run` refuses it with one
  friendly *"not emulated in `run` — use `test`, or pin it in the fixture"*
  message (never a bare `ReferenceError`): `$vars`/`$secrets` when unpinned,
  `$evaluateExpression` (needs the expression engine).

**Branch (output) indexes are pinnable, not signposted** (Plan 66 task 4). A
fixture entry — `nodes.<name>` or `input` — is read as **outputs** when every
element is an array: `[[…output 0…], […output 1…]]`, so `all(1)`/`first(1)`/
`last(1)`/`$items(name, 1)` answer from the pinned branch and an **empty** array
is a real answer. A plain items array stays one output (so the ambiguous case —
a single output of array-valued items — is written `[{ "json": [1, 2] }]`).
Plan 63 task 5's refusal survives for an output the fixture does not supply,
since returning output 0's items there is *wrong* data that looks right.

Expression-language extensions (`$if`/`$min`/`$max`/`$ifEmpty`) are deliberately
**not** declared — they resolve inside `{{ }}` expressions, not the Code node's
JS, so they throw in real n8n too. `scripts/globals-drift-audit.mts` reads n8n's
proxy at a pinned tag to flag newly-added globals (names only, license-clean).

## Milestones

1. ✅ Scaffold + pull, single workflow (API era — validated the data model).
2. ✅ push — reassembly, compile+marker, drift guard (API era).
3. ✅ multi-workflow loop + rename handling by id.
4. ⬜ n8n folder hierarchy — rescoped 2026-07-22 to **read-only "Local
   Overview"** (pull mirrors n8n placement as local dir nesting; decanter
   never writes folders/placement); blocked on one upstream MCP read fix
   ([Plan 8](plans/blocked/8-folder-hierarchy-in-sync-layout.md)).
5. ✅ QoL: `watch`, `status`.
6. ✅ `init`; 7. ✅ compliance guard + `check`; 8. ✅ structural validation +
   `rename` (plans/2). *(`status`/`check` were folded into `preflight`/`diff`
   in Plan 59; kept verbatim here — this log records what shipped when.)*
9. ✅ **Plan 32 (2026-07-22): MCP-native code layer** — `lib/mcp.mts` client
   + OAuth, pull/push/status/watch re-based (draft-first, code-only),
   structure verbs forwarded, lifecycle re-based, picker third state, init
   OAuth-first, template contract rewritten, e2e mock became a REST+MCP mock,
   smoke suite drives the MCP path on the real container (28 steps green on
   2.30.7).

## Implementation notes (decisions & observations)

Validated by `npm test` (unit + e2e with an in-process **REST+MCP mock** +
interactive suites) and the opt-in Docker smoke suite. Notes from the
API-era build that still hold are kept; superseded ones are marked.

- **Top-level `return`**: node code is a function body; esbuild accepts it,
  `tsc` rejects it (TS1108) → the typecheck wrapper.
- **`lastPushedHash` means "remote code hash at last sync"** (push *or*
  pull). Pull re-baselines even when surfacing an edit/conflict — otherwise
  push would stay blocked forever after a warned pull. Consequence: after a
  warned pull, push overwrites the surfaced remote edits; the `diff` verb +
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
- **Browser live-reload proxy** (plans/5): removed (Plan 52) — n8n's own
  editor reflects MCP draft edits live, dirty-safe; see Watch mode above.
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
  `--force`, the MCP rename (id stability + server-side **connection**
  rewriting, live — expression refs are NOT rewritten; Plan 64 task 4 adds the
  fixture that proves it), watch, and lifecycle on the real image.
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
  protection. The version-aware sync-fact fields (`versionId` /
  `activeVersionId`, `publishedVersionLagsDraft`) carried over unchanged —
  they're first-class in the MCP responses too.

## Open questions (verify against a live instance)

- ~~Folder placement on the API GET~~ — answered no (2026-07-19/20, Plan 8
  blocked on upstream exposure). ~~MCP note: `get_workflow_details` carries a
  `parentFolderId` field (null in tests) — re-check Plan 8 against the MCP
  surface when it matters.~~ Re-checked 2026-07-22 from n8n source (master +
  2.30.7): the field is in the output contract but the handler never loads the
  `parentFolder` relation (`includeParentFolder` defaults false at the call
  site), so it is **always null** — an upstream one-line wiring gap, not a
  design stance. The folder *tree* is readable (`search_folders`), but MCP has
  no move op and no folder create; only `create_workflow_from_code` takes a
  `folderId`. Plan 8 stays blocked (and was rescoped 2026-07-22 to read-only
  local mirroring — "Local Overview"); full findings in its "MCP re-check"
  section.
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
