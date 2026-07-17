# n8n-decanter — Plan

Standalone CLI that keeps n8n workflows in git: pull **full workflows** into a
folder-per-workflow layout, keep every Code node's source as its own file
(`.js` with JSDoc, or `.ts` compiled one-way), and push them back.

## Project layout

```
n8n-decanter/
  package.json            # deps: esbuild; devDeps: typescript; optional: chokidar
  .env                    # N8N_HOST, N8N_API_KEY
  decanter.config.json
  n8n-decanter.mjs            # CLI: pull | push | status | watch
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

## Watch mode (`n8n-decanter watch <file>`)

Fast inner loop while developing a single node: watch one `.ts`/`.js` file,
resolve its workflow + node via the directory's `.decanter.json`, and on change
compile (if TS) and push **only that node** (GET workflow → replace `jsCode` →
sanitized PUT). Same drift guard as full push.

## Type checking

- `tsconfig.json`: `"allowJs": true, "checkJs": true`, includes `workflows/`.
- `n8n-globals.d.ts` covers `.ts` and JSDoc-`.js` files alike.
- `.js` node files start with `// @ts-check` + JSDoc types.
- `npm run typecheck` → `tsc --noEmit -p .`.

## Milestones

1. **Scaffold + pull, single workflow, flat layout** — project setup, fetch,
   extract code files, placeholders, marker detection, `.decanter.json`.
   (Validates the whole data model.)
2. **push** — reassembly, compile+marker, drift guard, PUT.
3. **multi-workflow loop + rename handling** (workflow + node renames by id).
4. **n8n folder hierarchy** — only if the API exposes it (see below).
5. **QoL**: `watch`, `status` (local vs remote drift report).

## Open questions (verify before/at milestone 1 & 4)

- Does this n8n version's public API expose folder placement
  (`parentFolderId`/project) on `GET /workflows/:id`? Check the raw response of a
  workflow that sits inside a folder. If not exposed → flat layout under `root`,
  hierarchy deferred.
- Node name characters that need filename sanitization beyond `/` and `:`.
- Whether `PUT` preserves workflow fields that are neither sent nor whitelisted
  (tags, pinned data) — confirm nothing is lost on a pull→push round-trip of an
  untouched workflow.
