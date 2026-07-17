# n8n-decanter

Standalone CLI that keeps n8n workflows in git: pull full workflows into a
folder-per-workflow layout, keep every Code node's source as its own file
(`.js` lossless, or `.ts` compiled one-way), and push them back.
See [Plan.md](Plan.md) for the design.

## Setup

```sh
npm install
cp .env.example .env        # fill in N8N_HOST + N8N_API_KEY
```

Add workflow ids to `decanter.config.json`:

```json
{ "root": "./workflows", "workflows": ["0cXNQKKzmO0pXiCq"] }
```

## Commands

```sh
node n8n-decanter.mjs pull [id...]           # remote -> workflows/<Name>/
node n8n-decanter.mjs push [id...] [--force] # workflows/<Name>/ -> remote
node n8n-decanter.mjs status [id...]         # local vs remote drift report
node n8n-decanter.mjs watch <node-file>      # push one node on every save
npm run typecheck
```

Without ids, all workflows from the config are processed.

## How node files work

- `<Node>.js` — lossless: pulled/pushed byte-identical. Type-checked via
  JSDoc + `checkJs`.
- `<Node>.ts` — one-way: local file is the source of truth. `push` compiles it
  (esbuild, comments stripped) and appends a
  `// @ts-n8n sha256:...` marker line; `pull` never touches the `.ts`.
  To convert a node, replace `<Node>.js` with `<Node>.ts` and change its
  `//@file:` placeholder in `workflow.json` to the `.ts` name.
- `<Node>.remote.js` — written by `pull` when the remote code changed in ways
  it can't merge (UI edit of a TS-managed node, conflict, missing local `.ts`).
  Port the changes manually, then push; the file is removed on the next
  in-sync pull.
- `.decanter.json` — per-folder state (node-id → file map, sync hashes).
  Commit it; don't edit it.

Push refuses to overwrite remote changes made since the last sync
(`pull first`, or `--force`). Pulling records the remote state as the new
sync base — after a warned pull, push *will* overwrite the surfaced remote
edits, with `.remote.js` + git as the safety net.

## Type checking

n8n Code node source is a function body (top-level `return`/`await`), which
plain `tsc` rejects in `.ts` files (TS1108). `npm run typecheck` therefore
runs [scripts/typecheck.mjs](scripts/typecheck.mjs), which wraps node files in
an `async function` in memory (sibling `.decanter.json` marks a folder's files
as node files) and maps diagnostics back to real line numbers. Known
limitation: the IDE's own tsserver doesn't apply the wrapper, so editors show
a spurious TS1108 on top-level `return` in `.ts` node files.

## Open questions (need a live n8n instance)

Still unverified, from Plan.md — check once `.env` points at the real host:

- Whether `GET /api/v1/workflows/:id` exposes folder placement
  (`parentFolderId`/project). Until then the layout is flat under `root`.
- Whether `PUT` preserves fields that are neither sent nor whitelisted
  (tags, pinned data) — round-trip an untouched workflow and diff.
