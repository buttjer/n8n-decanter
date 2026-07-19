# n8n-decanter — Plan

Standalone CLI that keeps n8n workflows in git: pull **full workflows** into a
folder-per-workflow layout, keep every Code node's source as its own file
(`.js` with JSDoc, or `.ts` compiled one-way), and push them back.

## Project layout

```
n8n-decanter/
  package.json            # deps: esbuild, luxon; devDeps: typescript,
                          #   @types/node, @types/luxon
  .env                    # N8N_HOST, N8N_API_KEY (gitignored; written by init)
  .env.example
  decanter.config.json
  n8n-decanter.mts        # CLI entry: init | pull | push | status | check |
                          #   rename | watch | run | uuid
  lib/                    # implementation: api, compile, config, git, init,
                          #   prompt, proxy, pull, push, rename, run, state,
                          #   status, util, validate, watch (one .mts each)
                          #   + types.mts (shared data-model shapes)
  scripts/typecheck.mts   # tsc wrapper — see Type checking
  template/               # copied verbatim by init: AGENTS.md, CLAUDE.md
                          #   (references AGENTS.md), workflows/ — anything
                          #   added here later is copied too
  test/e2e.mts            # mock-API end-to-end test (npm test)
  tsconfig.json           # workflow node files: allowJs + checkJs, includes workflows/
  tsconfig.cli.json       # the CLI's own .mts sources: strict NodeNext, no emit
  n8n-globals.d.ts        # ambient types: $, $input, DateTime, …
  workflows/              # synced content, see below
```

## Decisions made

- **esbuild** compiles `.ts` node files (`bundle: false`, `format: "cjs"`,
  `target: node18`). Comments are stripped and lines shift — accepted.
  Consequence: n8n-UI edits on TS nodes can't be auto-merged back into the
  `.ts`; they are *detected* and surfaced as `<Node>.remote.js` for manual porting.
- **`.js` nodes are the lossless default**: pushed/pulled verbatim, byte-identical
  round-trip. Type-check via JSDoc + `checkJs`. Git merges them like any file.
- **`.ts` nodes are one-way**: local `.ts` is source of truth. Push compiles and
  appends a marker (see below). Pull never touches the `.ts`.
- **Marker** identifies TS-managed nodes, appended post-compile as the last line:

  ```
  // @ts-n8n sha256:<hex hash of the compiled JS excluding this line>
  ```

  Presence of the marker ⇒ node is TS-managed (self-describing, no config entry).
  Pull strips the marker line before hashing/comparing.
- **Git workflow (decided 2026-07-19): protected main, merge = release.** No
  direct commits to main; short-lived branches, squash-merged via PR (linear
  main, one commit per PR). Merging a PR with a non-empty `[Unreleased]`
  changelog section *is* a release: that PR rolls the changelog and bumps the
  version; the squash commit gets tagged `vX.Y.Z` and published as a GitHub
  Release (changelog section as notes). Internal-only PRs (no
  changelog entry) merge without a bump — user-facing work never sits
  unreleased on main. Full scheme in CLAUDE.md ("Git workflow & releases");
  GitHub ruleset enforcement waits for the repo going public (plans/OPEN-13).
- **n8n 2.x only (user decision 2026-07-19).** The tool targets the n8n 2.x
  line exclusively — the draft/publish model is treated as the native model,
  no 1.x compatibility hedges. Continuously verified against a pinned real
  2.x instance by the plans/15 smoke suite. A consequence recorded the same
  day: the 2.x public API *does* offer `POST /api/v1/workflows`, so
  repo-born workflows are possible (backlog: "Create workflows from the
  repo").

## Synced content layout

```
workflows/
  <n8n folder path>/            # only if the API exposes it, see Open questions
    <Workflow Name>/
      workflow.json             # full workflow, jsCode replaced by "//@file:code/<node-name>.js"
      code/
        <node-name>.js          # JSDoc-typed Code node (lossless)
        <node-name>.ts          # TS Code node (one-way)
        <node-name>.remote.js   # written by pull on conflict/UI-edit, visible on purpose
      .decanter.json            # state, see below
      executions/               # optional: fetched run data (plans/3) — temp,
        <execId>.json           #   self-gitignored, never synced back
```

- Workflow **id** lives in `workflow.json` itself → folder name is cosmetic.
  Pull matches folders by id and renames the folder when the workflow was renamed.
- Node files live in the folder's `code/` subdir and are named after the node
  name in **kebab-case** (`Parse Order` → `code/parse-order.js`; workflow folder
  names stay human-readable). Node **id** (stable in the workflow JSON) is the
  real key; `.decanter.json` maps node-id → file path (with the `code/` prefix),
  so node renames rename the file instead of orphaning it — the same rename
  machinery migrates pre-`code/` flat layouts on the next pull.
- `workflow.json` is pretty-printed with stable key order → clean diffs.
- No per-file header comments needed: which workflow/node a file belongs to is
  resolved from `.decanter.json` + the placeholders in `workflow.json`.

### `.decanter.json` (per workflow)

```json
{
  "workflowId": "0cXNQKKzmO0pXiCq",
  "nodes": {
    "<node-id>": { "file": "code/amazon-feed.ts", "lastPushedHash": "sha256:…" }
  },
  "lastPulledWorkflowHash": "sha256:…"
}
```

`lastPushedHash` = hash of the compiled JS (marker excluded) at last push — the
"base" for drift detection. `lastPulledWorkflowHash` = hash of the sanitized,
code-stripped workflow JSON, to warn about structural UI edits.

## Config

`decanter.config.json`:

```json
{
  "root": "./workflows",
  "workflows": ["0cXNQKKzmO0pXiCq", "zhwm1hNadTUtpDBP"]
}
```

Ids only — names, folders, node lists are all derived on pull. Optional keys:
`commitOnPush`/`commitOnPull` (default `true`, see Push/Pull),
`requestTimeoutMs` (default `30000` — per-request timeout on all n8n API
calls, plans/10; init's credential probe is fixed at 10 s),
`bundleDependencies` (default `[]` — npm packages `.ts` nodes may import;
bundled into the compiled node on push, plans/14; read at compile time by an
upward config search so `run` stays config-optional), and — for watch's
browser live-reload (plans/5) — `browserReload` (`"off"` default, or `"proxy"`)
and `proxyPort` (default `5679`).

## Workflow refs & CLI output (plans/11)

Every `[id…]` argument in the flows below is really a **ref**: an id, a
workflow/folder name, or a unique name prefix. Resolution is tiered — exact id
→ exact name (case-insensitive; folder basename *and* `workflow.json` `name`
both count, since `.decanter.json` stores no name) → unique prefix — and
never prompts: several matches in a tier error with the candidate list. An
**id-shaped ref that matches nothing passes through unresolved** so
`pull`/`status` of a fresh remote id keep working; `pull` additionally
resolves unknown names against `GET /api/v1/workflows` (cursor-paginated,
matched client-side). A workflow literally named like a verb loses to verb
detection — use the id. Config entries stay ids only.

Discovery surfaces: `list` (one line per pulled workflow: name, id, folder;
`--remote` appends unpulled remote ones) and `completion zsh|bash`, a printed
shell script that delegates to the hidden, credentials-free `__complete` verb
(verbs, flags, local names/ids; silently name-less without a config).

Output follows **one rule: styling and transient output exist only when the
target stream is a TTY** (`util.styleText` per stream — `NO_COLOR` respected,
though Node ignores it when `FORCE_COLOR` is set). Piped output is plain
line-oriented text; no information is carried by color alone. Vocabulary
(`lib/style.mts`): `✓ ` green success (`Log.ok`), `! ` yellow warn, `✗ ` red
error (was `x `), dim metadata, bold names, OSC 8 `link()` (plain text+URL
when piped). Progress — `[2/5]` counters and `(0.4s)` durations — is plain
text in both modes; the transient `pulling <id>…` rewrite, the `init` logo
(quadrant-block minifont; piped runs get one `n8n-decanter v<version>` line),
and hyperlinks are TTY-only. `watch` prints a deep link to
`<origin>/workflow/<id>` (proxy origin when live-reload runs, upstream
otherwise).

Exit codes: `status` exits **1 on conflict/remote drift** — anything where a
pull is needed or a push would clobber remote work (CONFLICT, remote-only
structure/code changes, remote nodes unknown locally or deleted, not pulled
yet); local-only "push pending" edits exit 0 (plans/10 decision, 2026-07-18:
the normal dev state must stay green). `status --diff` (plans/3 B) adds a
unified line diff under each drifted node — `-` remote, `+` local, `.ts`
nodes diffed as their compiled JS (what the sync hashes compare) — via the
zero-dep LCS differ in `lib/diff.mts`. `DEBUG=1` prints stack traces on
errors; the default is the one-line message.

## Pull flow (`n8n-decanter pull [id…]`)

For each configured workflow:

1. `GET /api/v1/workflows/:id` (header `X-N8N-API-KEY`).
2. Locate the local folder by id (scan `.decanter.json`s under root). Rename/move the
   folder if name (or n8n folder, if available) changed. Create if new.
3. For each Code node (`n8n-nodes-base.code`), matched by node id:
   - **Marker present** → TS-managed:
     - `hash(remote jsCode minus marker) == hash(compile(local .ts))` → in sync, skip.
     - hashes differ, local compiled hash == `lastPushedHash` → **UI edit**: write
       `code/<node>.remote.js`, print warning, leave `.ts` untouched.
     - both differ → **conflict**: same as above, louder warning.
   - **No marker** → plain/JSDoc JS: write `code/<node>.js` verbatim (overwrite;
     git history is the safety net).
   - Node renamed → rename the file, update `.decanter.json` (also how flat
     pre-`code/` layouts migrate).
4. Write `workflow.json` with each `jsCode` replaced by `//@file:<filename>`,
   keeping the file to the workflow itself: the n8n 2.x derived fields
   `activeVersion` (a server-side copy of the published version, code
   included) and `shared` (sharing metadata) are left out — code exists
   exactly once (in `code/`), and diffs show your changes, not publish
   churn. Neither field is pushable (PUT whitelist), so nothing is lost.
5. Update `.decanter.json` hashes.

## Push flow (`n8n-decanter push [id…]`)

Before anything else, two local gates run: the **compliance guard** (below) per
workflow, and — unless `--no-typecheck` — the **typecheck** once per push.
Guard errors abort and are *not* bypassable with `--force` (that flag only
overrides remote-drift protection); they must be fixed.

1. Read `workflow.json`, resolve `//@file:` placeholders:
   - `.js` → verbatim.
   - `.ts` → esbuild → append marker with hash → `jsCode`.
2. **Drift guard**: `GET` the workflow first (needed for the PUT anyway). For each
   Code node compare remote hash vs `lastPushedHash`; on mismatch abort with a
   "remote changed since last sync — pull first" message. `--force` overrides.
   Same check for the code-stripped workflow hash (structural UI edits).
3. Sanitize and `PUT /api/v1/workflows/:id`. The PUT endpoint rejects unknown
   fields, so send only:
   - top level: `name`, `nodes`, `connections`, `settings`, `staticData`
   - `settings`, whitelisted: `saveExecutionProgress`, `saveManualExecutions`,
     `saveDataErrorExecution`, `saveDataSuccessExecution`, `executionTimeout`,
     `timezone`, `errorWorkflow`
4. Update `.decanter.json` (`lastPushedHash` per node, workflow hash).

## Compliance guard (`n8n-decanter check [id…]`)

Validates pulled folders against this plan's layout — runs automatically at
the start of every push, and standalone as `check` (offline; needs no
credentials, so it works in CI without secrets). Without ids it checks every
folder under `root` that has a `.decanter.json`.

Errors (block push / exit 1):

- Code node in `workflow.json` with inline `jsCode` instead of a `//@file:`
  placeholder (hand edit or bad merge).
- Placeholder referencing a missing file, a `*.remote.js` conflict artifact,
  anything that isn't `.js`/`.ts`, or a file outside the `code/` subdir
  (pre-`code/` layouts — a fresh pull migrates them).
- A `.js` node file ending with an `@ts-n8n` marker line (would be
  misidentified as TS-managed on the next pull).
- Missing/corrupt `workflow.json` or `.decanter.json`.
- Structural integrity (added 2026-07-18, plans/2): dangling connection
  sources/targets (every key in `wf.connections` and every `{ node: … }`
  target must name a real node), duplicate node names or ids, orphan
  `.js`/`.ts` files no placeholder references (`.d.ts` and `*.remote.js`
  exempt; only the folder root and `code/` are scanned — other subdirs are
  reserved for artifacts like `executions/` (live since plans/3 C) and
  `fixtures/` (plans/7)),
  and dangling literal `$('…')` references in node source files *and* in
  expression parameters. The `$('…')` scan is a deliberate regex heuristic
  (shared `findNodeRefs`/`renameNodeRefs` in `lib/util.mts`): literal
  single-argument calls only; `$(var)`, multi-arg, and `${…}` templates are
  skipped.

Warnings (don't block):

- Unresolved `*.remote.js` leftovers — push will overwrite those remote edits.

Typecheck gate: `push` and `check` run `scripts/typecheck.mts` against the
nearest `tsconfig.json` at/above the config dir; skipped with an info message
when none exists (e.g. an init'ed sync dir), skippable with `--no-typecheck`.
With explicit ids, `check` scopes the typecheck too: the workflow dirs are
passed to the script, which still compiles the whole project (cross-file types
need the full graph) but only reports/counts diagnostics under those dirs;
file-less diagnostics (broken tsconfig) always surface. The template's
PostToolUse verify hook leans on this — it reads `workflowId` from the edited
file's sibling `.decanter.json` (ids, not folder names, are what `check`
resolves) and runs `check <id>`, so an unrelated broken workflow can't block
an edit. Watch validates only its own node file on code saves — structural
saves run the full compliance guard via push — and never typechecks (fast
inner loop).

## Rename (`n8n-decanter rename <id> "<old>" "<new>"`)

Added 2026-07-18 (plans/2). Renames a node atomically everywhere the old name
is load-bearing, replacing the manual 4-step dance: `node.name`, connection
keys and `{ node: … }` targets, literal `$('…')` references in every node
source file and expression parameter (via the same shared regex as the
guard), the kebab-case source filename plus its `.remote.js` sibling (never
across extensions; collisions fall back to `-<first 8 of node id>`), the
`//@file:` placeholder, and the `.decanter.json` entry. `.remote.js`
*contents* are never rewritten — they mirror remote code. Refuses unknown,
colliding, empty, and unchanged names; re-runs the compliance guard
afterwards and fails loudly (files stay written; git is the safety net).
Offline by design — `push` propagates.

`rename <id> --workflow "<new name>"` sets `wf.name` only: the folder is
cosmetic and follows on the next pull (same rename machinery as remote
renames).

## Execution datasets (`n8n-decanter [ref…] executions`, plans/3 C)

Added 2026-07-19. Fetches recent executions with full run data
(`GET /api/v1/executions?includeData=true`, filtered by `workflowId`;
`--status=success|error|waiting` and `--limit=N` — default 5, API page cap
250 — pass through to the API) into
`workflows/<Name>/executions/<execId>.json`, verbatim and pretty-printed. A
purely numeric argument is an execution id (`GET /executions/{id}`), routed
to its workflow's folder via the response's `workflowId`. Read-only against
the API by design — nothing under `executions/` is ever synced back.

Purpose: **temporary reference data so agents (and humans) see real payload
shapes** — items live under
`data.resultData.runData["<Node>"][0].data.main[0][]` — instead of guessing
when writing `run` fixtures or debugging nodes; also the designated fixture
source for the simulation suite (plans/7). `executions clean` (offline)
deletes the dirs — for the given refs, or every pulled workflow.

Two decisions from the 2026-07-18 review (plans/3):

- **Standalone verb, not part of `pull`** — fetching on every pull would be
  scope creep and a surprise network/data cost.
- **Never in git.** Run data can contain credentials/PII, and `executions/`
  sits inside the commit-on-pull/push pathspec — so the verb writes each dir
  *self-ignoring* (`executions/.gitignore` containing `*`, robust for
  pre-existing sync dirs and custom roots), and init's scaffolded root
  `.gitignore` lists `workflows/*/executions/` as well.

Caveat (recorded in plans/3, smoke-verified): executions run the *published*
workflow version (per-execution `workflowVersionId`, n8n 2.x) — possibly
older than the draft/repo state. Convenience data, not ground truth.
`run --from-execution` (auto-building a fixture from a captured execution)
was deliberately deferred to the backlog — agents read the JSON directly.

## Watch mode (`n8n-decanter <id> watch`)

Fast inner loop while developing a workflow: resolve its folder by id and
watch both the `code/` dir and `workflow.json`. Takes exactly one workflow
id — or none when the config lists a single workflow. (Was
single-node-*file* scoped until plans/5's browser live-reload made watching a
whole workflow the natural fit; structural watch added 2026-07-18, plans/12.)

**Watch start = snapshot commit + pull.** Before the watchers arm, watch
makes a safety commit of the workflow folder (regardless of
`commitOnPush`/`commitOnPull` — it's the data-loss guard, not sync
bookkeeping; no-op on a clean tree), then pulls, so every session begins
committed and in sync with remote. Order is the guarantee: pull overwrites
plain `.js` files and `workflow.json` with remote unconditionally, so the
commit must land first. If the snapshot fails (no git), the startup pull is
skipped rather than pulling over an unsnapshotted tree. A structural conflict
already present at start (local and remote both moved) warns that remote wins
the working tree and git holds the local version.

**Code saves** map the changed file back to its node (via `.decanter.json`,
re-read each time so a mid-session rename still resolves) and push **only
that node** (GET workflow → replace `jsCode` → sanitized PUT) — remote
structure is preserved by construction; per-node drift guard as before.

**`workflow.json` saves** push the structure via a full push (compliance
guard + placeholder resolution + full drift guard; still no typecheck), gated
by a 3-way check against the **session baseline** — the structure hash both
sides agreed on at the session's last sync point. The baseline lives in
memory because single-node pushes re-baseline `lastPulledWorkflowHash` from
their PUT responses, silently absorbing n8n-UI structural edits into
`.decanter.json`; the in-memory copy keeps them detectable (a warning fires
right after the node push that reveals one). Per save: local == baseline →
skip (the anti-loop guard: covers formatting-only saves and watch's own pull
rewrite); remote == baseline → push; both moved → interactive conflict
prompt — `[m]erge` writes a diff-friendly `workflow.remote.json` (`//@file:`
placeholders substituted only where the remote code still matches the last
sync; the guard warns while it exists) for manual reconciliation, `[l]ocal`
force-pushes over the remote changes, `[r]emote` pulls over the local file
(git holds the previous version), Enter skips until the next save. Non-TTY
sessions log the conflict and skip; `--force` resolves as keep-local without
prompting. Known footguns, accepted: `git checkout` rewriting
`workflow.json` triggers a structural push or prompt (same class as node
files), and only the PUT-whitelisted fields propagate — local edits to e.g.
`active` or tags silently don't push.

**Browser live-reload (optional, plans/5).** With `browserReload: "proxy"`,
watch first boots a transparent reverse proxy on `127.0.0.1:<proxyPort>`
(default 5679, native `node:http`/`net`/`tls`, no new dep). It pipes every
request to `host` untouched — auth, assets, and n8n's native `/rest/push`
WebSocket — and injects a small live-reload client into `text/html` responses
(buffered, injected before `</body>`; everything else streams through). Open the
editor via the **proxy URL**; each successful single-node push calls
`notifyPushed` (a module singleton in `lib/proxy.mts`, also invoked by full
`push`), which broadcasts a `pushed` SSE event and the client reloads the tab —
unless the editor has unsaved changes (a synthetic-`beforeunload` dirty probe →
console warning instead) or a different workflow is open. A port-bind failure
warns and watch keeps syncing without reload. Clean for a local http `host`;
https/remote is best-effort (Secure cookies don't survive the plain-http hop).
**Auth/WebSocket passthrough and the dirty safeguard need a live instance to
verify** — the offline-testable parts are covered by `test/proxy.mts`.

## Init flow (`n8n-decanter init [dir]`)

Bootstraps a sync directory (defaults to cwd, runs before any config exists):

1. Prompt for host + API key; values from an existing `.env` are offered as
   defaults (enter keeps them). Host is normalized (`https://` prepended when
   no scheme, trailing `/` stripped). Write `.env`.
2. Copy `template/` into the target **recursively and completely** — whatever
   the template contains ships — but never overwrite files that already exist
   in the target, so re-running init is safe. Files named `X.example`
   materialize as `X`: the suffix keeps agent-tooling config (CLAUDE.md,
   `.claude/settings*`, opencode.json, …) inert inside this repo while
   working on the CLI itself, but live in init'ed dirs. Name template files
   `<full real name>.example` (e.g. `settings.local.json.example`, not
   `settings.local.example`). `.env.example` materializes to `.env` and is
   therefore always skipped — init has just written the real `.env`.
   The template also ships `shared/` for shared types and helpers used by
   node files, plus agent permission configs (`.claude/settings.local.json`,
   `opencode.json`) that allow edits in `workflows/` and `shared/` while
   denying `.decanter.json`, `*.remote.js`, `.env`, and `push --force` —
   the CLI compliance guard stays the wall behind those. `.mcp.json` embeds
   the [n8n-mcp](https://github.com/czlonkowski/n8n-mcp) server through a
   small `sh -c` wrapper that sources `./.env` (with `set -a` so the vars are
   exported, mapping `N8N_HOST` to n8n-mcp's `N8N_API_URL`) and then `exec`s
   `npx n8n-mcp`. That keeps credentials out of the committable file *and*
   needs no shell setup — Claude Code does not read `.env` itself. Two
   gotchas: don't use `${VAR}` syntax inside the wrapper (Claude Code expands
   `${…}` in `.mcp.json` fields before the shell sees them, plain `$VAR` is
   safe), and the wrapper is POSIX-sh (macOS/Linux). Without a `.env` the
   server still starts, in docs-only mode. See the shared-code
   caveat in Implementation notes.
3. Create `decanter.config.json` (empty workflow list) and `.gitignore`
   (`node_modules/`, `.env`) if missing; if a `.gitignore` exists that doesn't
   ignore `.env`, warn (the file holds the API key).
4. Best-effort credential check: `GET /api/v1/workflows?limit=1`; failure is
   a warning, not an error.

Prompting must buffer piped stdin (plain `readline/promises` drops lines that
arrive before `question()` and hangs on EOF — see Implementation notes).

## Type checking

- `tsconfig.json`: `"allowJs": true, "checkJs": true`, includes `workflows/`,
  excludes `**/*.remote.js`. `"moduleDetection": "force"` gives every node
  file its own module scope, so same-named top-level declarations across
  node files don't collide ("cannot redeclare"); `.d.ts` files are exempt
  from `force`, so `n8n-globals.d.ts` stays ambient.
- `n8n-globals.d.ts` covers `.ts` and JSDoc-`.js` files alike.
- `.js` node files start with `// @ts-check` + JSDoc types.
- `npm run typecheck` → `tsc -p tsconfig.cli.json && node
  scripts/typecheck.mts`. The first half strict-checks the CLI's own `.mts`
  sources. The second checks node files and is **not** plain `tsc --noEmit`:
  node code is a function body, and `tsc` rejects top-level `return` (TS1108)
  — in checkJs `.js` and `.ts` files alike; the wrapper, not the file type,
  is what makes typecheck pass. The
  script wraps node files in `async function () { … }` in memory via a custom
  CompilerHost — files on disk stay verbatim — and maps diagnostic lines back
  (−1). Node files are recognized by a `.decanter.json` sibling — directly, or
  in the parent of their `code/` dir.
- Editor tsservers don't apply the wrapper, so the template ships
  **`decanter-ts-plugin/`** — a tsserver language-service plugin that drops
  exactly TS1108/TS1375/TS1378 on node files (same recognition rule as the
  wrapper; every other diagnostic and every non-node file untouched). Loaded
  via the sync-dir tsconfig `plugins` entry plus a `file:./decanter-ts-plugin`
  devDependency; VS Code must run the *workspace* TypeScript
  (`.vscode/settings.json` sets `typescript.tsdk`, one-time "Use Workspace
  Version" consent) because `typescript.tsserver.pluginPaths` is
  machine-scoped and the bundled tsserver can't resolve workspace plugins.
  JetBrains IDEs use the project TypeScript by default. (plans/4)

## Milestones

1. ✅ **Scaffold + pull, single workflow, flat layout** — project setup, fetch,
   extract code files, placeholders, marker detection, `.decanter.json`.
   (Validates the whole data model.)
2. ✅ **push** — reassembly, compile+marker, drift guard, PUT.
3. ✅ **multi-workflow loop + rename handling** (workflow + node renames by id).
4. ⬜ **n8n folder hierarchy** — only if the API exposes it (see below).
   Deferred: needs a live instance to verify; layout is flat until then.
5. ✅ **QoL**: `watch`, `status` (local vs remote drift report).
6. ✅ **init** — interactive bootstrap, see Init flow. (Added after v1 of this
   plan.)
7. ✅ **compliance guard + `check`** — see Compliance guard. (Added after v1.)
8. ✅ **structural validation + `rename`** — connection/uniqueness/orphan/
   `$('…')` checks in the guard, atomic rename verb. (2026-07-18, plans/2.)

## Implementation notes (decisions & observations from the 2026-07-17 build)

Everything below was validated by `npm test` (`test/e2e.mts`): an in-process
mock n8n API — including the strict PUT that rejects unknown fields — driven
through the real CLI as a subprocess. 11 scenarios: init (+ idempotent re-init),
pull, byte-identical `.js` round-trip, TS convert + marker, UI-edit and
conflict surfacing, structural drift abort, status, renames, single-node push.

- **Top-level `return`**: node code is a function body. esbuild
  (`transform`, `format: "cjs"`) accepts it; `tsc` rejects it (TS1108) in
  checkJs `.js` and `.ts` files alike → `scripts/typecheck.mts`
  wrapper (see Type checking).
- **`lastPushedHash` really means "remote code hash at last sync"** (push *or*
  pull). Pull updates it even when surfacing a UI edit/conflict — otherwise
  push would stay blocked forever after the warned pull. Consequence: after a
  warned pull, push *will* overwrite the remote edits; `code/<node>.remote.js`
  + git history are the safety net. This matches the "pull first" guard message.
- **Sync hashes are recorded from the PUT *response*** (server-canonical
  form), not the request body, to avoid false drift when the server
  normalizes the workflow.
- **Extension transitions are never auto-renamed.** Remote marker appears but
  locally there's only a `.js` (or no file): remote code goes to
  `code/<node>.remote.js` + warning, nothing is silently relabeled as TS source.
  Reverse (local `.ts`, remote without marker — e.g. node re-created in the
  UI): remote goes to `.remote.js`, the `.ts` is never clobbered.
- **Filename sanitization** (open question resolved by decision):
  `/ \ : * ? " < > |` → `-`, control chars stripped, trailing dots stripped,
  empty → `unnamed`. Same-name collisions get `-<first 8 chars of node id>`.
  Workflow *folders* use the sanitized name as-is (human-readable); node
  *files* additionally go through kebab-case (see next bullet).
- **Kebab-case `code/` layout (added 2026-07-18, backlog)**: node sources live
  in `<workflow>/code/`, named `kebabCase(sanitizeFilename(node name))` —
  camelCase/acronym boundaries split, Unicode letters kept, non-alphanumerics
  collapsed to `-` (`Transform: EU/US` → `code/transform-eu-us.js`). The
  `//@file:` placeholders and `.decanter.json` `file` entries carry the
  `code/` prefix (always `/`-separated). Migration is free: the existing
  node-rename machinery in pull renames old flat files into `code/`, and the
  compliance guard hard-errors on node files outside `code/` (pointing at
  pull). Everything that located a node file's `.decanter.json`/
  `workflow.json` as a *sibling* (watch, run, `scripts/typecheck.mts`, the
  template verify hook) also looks one level up from a dir named `code/`.
- **`run` staticData (2026-07-18, plans/3 A)**: `$getWorkflowStaticData` is
  seeded from `workflow.json`'s `staticData` using n8n's own key scheme
  (`global`, `node:<node name>`); string-form staticData (the DB-serialized
  shape some API responses carry) is parsed. A fixture `staticData` field
  (`{ global?, node? }` — `node` meaning the node being run) replaces the
  matching slice whole, no merging. Mutations are visible during the run,
  never persisted — `run` stays offline.
- **Name resolution is composed, not monolithic (2026-07-18, plans/11)**:
  `lib/state.mts` exports `listWorkflowRefs` (dir scan; names from folder
  basename + `workflow.json`), pure `matchWorkflowRef` (the tiered matcher,
  throws on ambiguity), and `looksLikeWorkflowId`; the dispatcher composes
  them per verb (only `pull` consults the API). Version for the `init`
  banner walks up from `import.meta.url` to the nearest `package.json` —
  required since plans/13's publish build also runs the CLI from `dist/`.
- **Nodes deleted remotely** are dropped from `.decanter.json` with a warning;
  their files stay on disk (git is the safety net).
- **Watch** resolves a workflow by id and watches its `code/` dir and
  `workflow.json` with native `fs.watch`, mapping each changed code file back
  to its node (state re-read per change, so mid-session renames resolve) and
  pushing just that node; `workflow.json` saves take the structural 3-way
  path (see Watch mode). Atomic editor saves replace the inode and break
  plain *file* watches, so it watches the dirs and filters by name; 200 ms
  debounce, per-run overlap guard, a dirty set so saves landing during a push
  aren't lost — a pending structural push subsumes queued node pushes (full
  push covers all nodes). No chokidar dependency. (Workflow-id scope since
  plans/5 — a single node file before; structural watch since plans/12, which
  also dropped the "no Code nodes to watch" error — a code-less workflow is
  watchable for structure.)
- **Browser live-reload proxy (added 2026-07-18, plans/5)**: `lib/proxy.mts`, a
  native-Node reverse proxy that watch boots when `browserReload: "proxy"` (see
  Watch mode). Deliberate deviations from the plan sketch, all to stay
  dependency-free and self-contained: SSE (not a WebSocket) for the reload
  channel, the client inlined in the module (no `src/templates/` asset), and a
  typed `notifyPushed` module singleton instead of `global.__decanterProxy` —
  no-op without a running proxy, so plain `push` calls it safely. HTML is
  buffered to inject before `</body>` (`accept-encoding` stripped so it arrives
  uncompressed); non-HTML and `HEAD` stream through untouched. Dirty detection
  is a best-effort synthetic-`beforeunload` probe (framework-agnostic but
  version-sensitive; fails toward *not* reloading). `test/proxy.mts` covers
  injection, passthrough, client/SSE, and graceful port-bind failure; live
  auth/WebSocket passthrough is unverified (mock can't answer it).
- **Piped stdin for init prompts**: `readline/promises` drops lines that
  arrive before `question()` is called and hangs on stdin EOF → init uses a
  small buffering prompt helper so `printf "host\nkey\n" | n8n-decanter init`
  works.
- **Layout deviation**: implementation is split into `lib/*.mts` modules with
  a thin CLI entry instead of one big `n8n-decanter.mts`.
- **Id-first argument order (added 2026-07-17, backlog)**: the dispatcher
  takes the *first* positional token that matches a known verb as the
  command, wherever it sits — `wf123 push` ≡ `push wf123`; flags may appear
  in any position too. Consequence of first-verb-wins: an id/path that
  literally equals a verb name must be passed *after* the verb (accepted —
  n8n ids are nanoid-style and can't collide). Docs (CLI help, README)
  present id-first as the canonical form; verb-first is the accepted
  alternative.
- **TypeScript CLI (added 2026-07-17, plans/6)**: the CLI's own sources are
  `.mts`, executed natively via Node's type stripping — no build step;
  engines `>=22.18` (the first line where stripping is on by default; Node
  18/20 are EOL). `tsconfig.cli.json` holds the strict NodeNext project:
  `erasableSyntaxOnly` keeps the sources strippable (no enums, namespaces,
  or parameter properties — a permanent style rule), and
  `allowImportingTsExtensions` matches the runtime's literal `.mts` import
  specifiers. `composite` + declaration-only emit into `node_modules/.cache`
  exists solely so the root `tsconfig.json` can list the project under
  `references` — that is what lets tsserver bind the `.mts` files to it.
  The root `tsconfig.json`'s name and role are unchanged: it is the workflow
  node-file config, discovered *by name* by `scripts/typecheck.mts` and by
  the sync-dir upward search in `lib/validate.mts`. Shared data-model shapes
  (`Workflow`, `JsCodeNode`, `DecanterState`, `DecanterConfig`, …) live in
  `lib/types.mts`; `isJsCodeNode` is a type guard.
- **Testing note**: the e2e test binds a localhost port and must exec the CLI
  *asynchronously* (the mock server shares the test process; a sync exec
  deadlocks). Sandboxed environments may block the port bind.
- **Structure drift detection** hashes the sanitized, code-stripped workflow
  with recursively sorted keys, so key order never causes false drift.
- **Compliance guard** (milestone 7): `--force` deliberately does *not*
  bypass it — force is for "I know the remote changed", not for pushing a
  malformed tree. The guard's checks live in `lib/validate.mts`, shared by
  push (full validation), watch (per-node subset, no typecheck), and `check`.
  `check` loads config without requiring credentials.
- **Structural guard + `rename` (added 2026-07-18, plans/2)**: the guard's
  new integrity checks and `rename` share one `$('…')` regex
  (`findNodeRefs`/`renameNodeRefs` in `lib/util.mts`), kept exported for the
  planned `run`/`simulate` work (plans 3/7). The e2e mock originally renamed
  a node without updating `connections`; the connection-integrity check
  caught it — real n8n rewrites connections on rename, the mock now mirrors
  that.
- **`shared/` code in `.ts` nodes is bundled on push (plans/14, 2026-07-18)**.
  This replaces an earlier, wrong note claiming type-only imports worked and
  value imports failed at n8n runtime — in truth esbuild rejects *any*
  top-level import (even `import type`) next to a top-level `return`, so
  `.ts` nodes could import nothing at all; only JSDoc `@typedef` in `.js`
  nodes ever worked. Mechanism (`lib/compile.mts`): hoist the leading import
  block, wrap the body in an async arrow **assigned onto a plain shim
  object** (`__n8n_node.default = …` — deliberately no `export` in the
  entry), esbuild-bundle as an iife (`absWorkingDir` = sync root →
  machine-stable output and hashes), rewrite esbuild's `__copyProps`
  CJS-interop helper to eager data assignment, prepend the shim var, append
  `return __n8n_node.default();` — the artifact remains a function body, so
  the marker, `run`, and push contracts are untouched, and n8n globals pass
  through as free identifiers. The export-free entry and the interop rewrite
  are load-bearing (verified against real n8n 2.30.7, plans/15): **n8n's
  task-runner sandbox neuters getter property descriptors** — reading a
  `defineProperty`-getter yields undefined — and esbuild lowers module
  exports and CJS interop to exactly such getters. **No-import nodes keep
  the plain-transform output byte-identically** (zero drift on upgrade).
  Rules (shared by
  `check` and the compiler): imports at the top of the file only; relative
  imports stay inside the sync dir; npm packages opt in per package via
  config `bundleDependencies` (pure JS only — no native addons); Node
  builtins always error (bundling can't include them; runtime allowance is
  the instance's `NODE_FUNCTION_ALLOW_BUILTIN` policy). Shared edits
  surface as push-pending drift on every importing node — that is the
  propagation mechanism. `.js` nodes never bundle (lossless tier); the
  typecheck wrapper inserts its function header *after* the import block so
  imports stay module-scoped and diagnostic lines keep mapping.
- **n8n 2.x publish semantics (researched 2026-07-18 in the n8n source)**:
  n8n 2.x splits workflows into a draft (`versionId`) and a published version
  (`activeVersionId`) — UI Save = draft, UI Publish = live. The public API is
  blunter than the UI:
  - `PUT /workflows/:id` hardcodes `publishIfActive: true` server-side →
    pushing to a *published* workflow **auto-publishes immediately**; there
    is no draft-only update on a published workflow via the public API. An
    *unpublished* workflow only gets its draft updated and stays unpublished.
  - `GET` returns the **draft** — pull can pick up unpublished UI edits, and
    the next push to a published workflow publishes them along.
  - The PUT also hardcodes `forceSave: true`, and the body schema has no
    checksum field (`versionId` is readOnly) → **n8n's own optimistic
    locking is unreachable through the public API**; decanter's drift guard
    is the only conflict protection, which is why it exists.
  - Surfaced in decanter (2026-07-18): `publicationState` in `lib/util.mts`
    reads the `active` flag; push result lines append `— published: code is
    live now` / `— unpublished: draft only`, watch warns at start on a
    published workflow, `status` shows the state. Servers without an
    `active` field (mocks, exotic versions) get unchanged output.
  - Upstream: PR n8n-io/n8n#31954 (`publishBehavior: "skip"` on
    `WorkflowService.update`) was closed unmerged and never exposed the
    choice to API clients anyway; draft-only pushes need a new upstream
    change (feature request candidate). Staged rollouts today require
    unpublish → push → publish (triggers down in between) or a staging-copy
    workflow.

## Open questions (verify against a live instance)

- ~~Does this n8n version's public API expose folder placement
  (`parentFolderId`/project) on `GET /workflows/:id`?~~ **Answered for n8n
  2.30 (2026-07-19, raw GET via the plans/15 smoke rig): no placement field
  in the response** (`parentFolderId`/`project` absent) — flat layout stands;
  [Plan 8](plans/OPEN-8-folder-hierarchy-in-sync-layout.md)'s push-driven
  inversion is confirmed. Re-check on version bumps via the smoke suite.
- ~~Node name characters that need filename sanitization beyond `/` and `:`.~~
  Resolved by decision, see Implementation notes.
- ~~Whether `PUT` preserves workflow fields that are neither sent nor
  whitelisted (tags, pinned data) on an untouched round-trip.~~ **Verified
  against n8n 2.30.7 (2026-07-19, plans/15 smoke suite): tags survive an
  untouched pull→push round-trip** (asserted weekly by the suite), and
  pinned data is preserved *by construction* — the 2.x GET returns
  `pinData`, the PUT whitelist never sends it, so the server keeps its copy.
