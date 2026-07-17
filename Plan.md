# n8n-decanter — Plan

Standalone CLI that keeps n8n workflows in git: pull **full workflows** into a
folder-per-workflow layout, keep every Code node's source as its own file
(`.js` with JSDoc, or `.ts` compiled one-way), and push them back.

## Project layout

```
n8n-decanter/
  package.json            # deps: esbuild; devDeps: typescript
  .env                    # N8N_HOST, N8N_API_KEY (gitignored; written by init)
  .env.example
  decanter.config.json
  n8n-decanter.mjs        # CLI entry: init | pull | push | status | check | watch
  lib/                    # implementation: api, config, state, util, compile,
                          #   pull, push, status, watch, init, validate (one .mjs each)
  scripts/typecheck.mjs   # tsc wrapper — see Type checking
  template/               # copied verbatim by init: AGENTS.md, CLAUDE.md
                          #   (references AGENTS.md), workflows/ — anything
                          #   added here later is copied too
  test/e2e.mjs            # mock-API end-to-end test (npm test)
  tsconfig.json           # allowJs + checkJs, includes workflows/
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

## Synced content layout

```
workflows/
  <n8n folder path>/            # only if the API exposes it, see Open questions
    <Workflow Name>/
      workflow.json             # full workflow, jsCode replaced by "//@file:<Node Name>.js"
      <Node Name>.js            # JSDoc-typed Code node (lossless)
      <Node Name>.ts            # TS Code node (one-way)
      <Node Name>.remote.js     # written by pull on conflict/UI-edit, visible on purpose
      .decanter.json                # state, see below
```

- Workflow **id** lives in `workflow.json` itself → folder name is cosmetic.
  Pull matches folders by id and renames the folder when the workflow was renamed.
- Node files are named after the node name, sanitized (`/`, `:` → `-`). Node **id**
  (stable in the workflow JSON) is the real key; `.decanter.json` maps node-id → filename,
  so node renames rename the file instead of orphaning it.
- `workflow.json` is pretty-printed with stable key order → clean diffs.
- No per-file header comments needed: which workflow/node a file belongs to is
  resolved from `.decanter.json` + the placeholders in `workflow.json`.

### `.decanter.json` (per workflow)

```json
{
  "workflowId": "0cXNQKKzmO0pXiCq",
  "nodes": {
    "<node-id>": { "file": "Amazon Feed.ts", "lastPushedHash": "sha256:…" }
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

Ids only — names, folders, node lists are all derived on pull.

## Pull flow (`n8n-decanter pull [id…]`)

For each configured workflow:

1. `GET /api/v1/workflows/:id` (header `X-N8N-API-KEY`).
2. Locate the local folder by id (scan `.decanter.json`s under root). Rename/move the
   folder if name (or n8n folder, if available) changed. Create if new.
3. For each Code node (`n8n-nodes-base.code`), matched by node id:
   - **Marker present** → TS-managed:
     - `hash(remote jsCode minus marker) == hash(compile(local .ts))` → in sync, skip.
     - hashes differ, local compiled hash == `lastPushedHash` → **UI edit**: write
       `<Node>.remote.js`, print warning, leave `.ts` untouched.
     - both differ → **conflict**: same as above, louder warning.
   - **No marker** → plain/JSDoc JS: write `<Node>.js` verbatim (overwrite; git
     history is the safety net).
   - Node renamed → rename the file, update `.decanter.json`.
4. Write `workflow.json` with each `jsCode` replaced by `//@file:<filename>`.
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
  or anything that isn't `.js`/`.ts`.
- A `.js` node file ending with an `@ts-n8n` marker line (would be
  misidentified as TS-managed on the next pull).
- Missing/corrupt `workflow.json` or `.decanter.json`.

Warnings (don't block):

- Unresolved `*.remote.js` leftovers — push will overwrite those remote edits.

Typecheck gate: `push` and `check` run `scripts/typecheck.mjs` against the
nearest `tsconfig.json` at/above the config dir; skipped with an info message
when none exists (e.g. an init'ed sync dir), skippable with `--no-typecheck`.
Watch validates only its own node file and never typechecks (fast inner loop).

## Watch mode (`n8n-decanter watch <file>`)

Fast inner loop while developing a single node: watch one `.ts`/`.js` file,
resolve its workflow + node via the directory's `.decanter.json`, and on change
compile (if TS) and push **only that node** (GET workflow → replace `jsCode` →
sanitized PUT). Same drift guard as full push.

## Init flow (`n8n-decanter init [dir]`)

Bootstraps a sync directory (defaults to cwd, runs before any config exists):

1. Prompt for host + API key; values from an existing `.env` are offered as
   defaults (enter keeps them). Host is normalized (`https://` prepended when
   no scheme, trailing `/` stripped). Write `.env`.
2. Copy `template/` into the target **recursively and completely** — whatever
   the template contains ships as-is — but never overwrite files that already
   exist in the target (`cpSync` with `force: false`), so re-running init is
   safe. Template contents today: empty `AGENTS.md`, `CLAUDE.md` referencing
   AGENTS.md, empty `workflows/` (`.gitkeep`).
3. Create `decanter.config.json` (empty workflow list) and `.gitignore`
   (`node_modules/`, `.env`) if missing; if a `.gitignore` exists that doesn't
   ignore `.env`, warn (the file holds the API key).
4. Best-effort credential check: `GET /api/v1/workflows?limit=1`; failure is
   a warning, not an error.

Prompting must buffer piped stdin (plain `readline/promises` drops lines that
arrive before `question()` and hangs on EOF — see Implementation notes).

## Type checking

- `tsconfig.json`: `"allowJs": true, "checkJs": true`, includes `workflows/`,
  excludes `**/*.remote.js`.
- `n8n-globals.d.ts` covers `.ts` and JSDoc-`.js` files alike.
- `.js` node files start with `// @ts-check` + JSDoc types.
- `npm run typecheck` → `node scripts/typecheck.mjs` (**not** plain
  `tsc --noEmit`): node code is a function body, and `tsc` rejects top-level
  `return` in `.ts` files (TS1108; `.js` under checkJs is tolerated). The
  script wraps node files in `async function () { … }` in memory via a custom
  CompilerHost — files on disk stay verbatim — and maps diagnostic lines back
  (−1). Node files are recognized by a `.decanter.json` sibling. Known wart:
  IDE tsservers don't apply the wrapper, so editors show a spurious TS1108 on
  top-level `return` in `.ts` node files.

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

## Implementation notes (decisions & observations from the 2026-07-17 build)

Everything below was validated by `npm test` (`test/e2e.mjs`): an in-process
mock n8n API — including the strict PUT that rejects unknown fields — driven
through the real CLI as a subprocess. 11 scenarios: init (+ idempotent re-init),
pull, byte-identical `.js` round-trip, TS convert + marker, UI-edit and
conflict surfacing, structural drift abort, status, renames, single-node push.

- **Top-level `return`**: node code is a function body. esbuild
  (`transform`, `format: "cjs"`) accepts it; `tsc` rejects it in `.ts` files
  (TS1108) but tolerates it in checkJs `.js` files → `scripts/typecheck.mjs`
  wrapper (see Type checking).
- **`lastPushedHash` really means "remote code hash at last sync"** (push *or*
  pull). Pull updates it even when surfacing a UI edit/conflict — otherwise
  push would stay blocked forever after the warned pull. Consequence: after a
  warned pull, push *will* overwrite the remote edits; `<Node>.remote.js` +
  git history are the safety net. This matches the "pull first" guard message.
- **Sync hashes are recorded from the PUT *response*** (server-canonical
  form), not the request body, to avoid false drift when the server
  normalizes the workflow.
- **Extension transitions are never auto-renamed.** Remote marker appears but
  locally there's only a `.js` (or no file): remote code goes to
  `<Node>.remote.js` + warning, nothing is silently relabeled as TS source.
  Reverse (local `.ts`, remote without marker — e.g. node re-created in the
  UI): remote goes to `.remote.js`, the `.ts` is never clobbered.
- **Filename sanitization** (open question resolved by decision):
  `/ \ : * ? " < > |` → `-`, control chars stripped, trailing dots stripped,
  empty → `unnamed`. Same-name collisions get `-<first 8 chars of node id>`.
- **Nodes deleted remotely** are dropped from `.decanter.json` with a warning;
  their files stay on disk (git is the safety net).
- **Watch** uses native `fs.watch` on the *directory*, filtering for the file
  name (atomic editor saves replace the inode and break plain file watches),
  with 200 ms debounce and overlap protection. No chokidar dependency needed.
- **Piped stdin for init prompts**: `readline/promises` drops lines that
  arrive before `question()` is called and hangs on stdin EOF → init uses a
  small buffering prompt helper so `printf "host\nkey\n" | n8n-decanter init`
  works.
- **Layout deviation**: implementation is split into `lib/*.mjs` modules with
  a thin CLI entry instead of one big `n8n-decanter.mjs`.
- **Testing note**: the e2e test binds a localhost port and must exec the CLI
  *asynchronously* (the mock server shares the test process; a sync exec
  deadlocks). Sandboxed environments may block the port bind.
- **Structure drift detection** hashes the sanitized, code-stripped workflow
  with recursively sorted keys, so key order never causes false drift.
- **Compliance guard** (milestone 7): `--force` deliberately does *not*
  bypass it — force is for "I know the remote changed", not for pushing a
  malformed tree. The guard's checks live in `lib/validate.mjs`, shared by
  push (full validation), watch (per-node subset, no typecheck), and `check`.
  `check` loads config without requiring credentials.

## Open questions (verify against a live instance)

- Does this n8n version's public API expose folder placement
  (`parentFolderId`/project) on `GET /workflows/:id`? Check the raw response of a
  workflow that sits inside a folder. If not exposed → flat layout under `root`,
  hierarchy deferred. **Still open — needs live API.**
- ~~Node name characters that need filename sanitization beyond `/` and `:`.~~
  Resolved by decision, see Implementation notes.
- Whether `PUT` preserves workflow fields that are neither sent nor whitelisted
  (tags, pinned data) — confirm nothing is lost on a pull→push round-trip of an
  untouched workflow. **Still open — needs live API** (the mock can't answer
  server-side behavior).
