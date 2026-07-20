# Plan 21 — Repo-authored workflows (`add` + `push --create`)

**Priority:** P2 (`add`) / P3 (`push --create`, data-model change)
**Status:** Not started
**Theme:** Let Code nodes and whole workflows be **born in the repo**, not only
in n8n: an `add` verb scaffolds a Code node in-place, and `push --create`
creates a brand-new workflow remotely from a repo folder via the n8n 2.x
`POST /api/v1/workflows` endpoint — inverting today's "born in n8n, then
pulled" rule.
**Model:** split by task. **Sonnet** for `add` (task 1) — mechanical
scaffolding that reuses the existing uuid/kebab/rename machinery against a
concrete spec. **Opus** for `push --create` (task 2) — it inverts the
pull-first data model, needs user sign-off, and the round-trip/id-capture
edges reward the stronger model.

## Why

The data model today is strictly **pull-first**: a workflow folder only exists
*after* a pull assigns it a remote id (`pullWorkflow` in `lib/pull.mts` writes
`.decanter.json` with the server's `workflowId`), and PLAN.md's guidance is
"workflows are born in n8n". Two frictions follow:

- **Adding a Code node** means a manual dance the CLI already has all the pieces
  for: mint a uuid (`uuid` verb), hand-write the node object in `workflow.json`,
  add a `//@file:code/<name>.js` placeholder, create the source file, keep
  `.decanter.json` consistent — then `check`. The `rename` verb proved the
  value of collapsing exactly this kind of multi-file edit into one atomic,
  guard-checked command.
- **Authoring a workflow from scratch in the repo** is impossible end-to-end:
  you must create it in the UI first to get an id. But PLAN.md records
  (2026-07-19) that the 2.x public API *does* offer `POST /api/v1/workflows`
  (smoke-verified), so a repo-born workflow is now technically possible — the
  only blocker is the id-first data model, not the API.

## Source

- [Plan 0](BACKLOG.md): **`add` verb** — "scaffold a Code node (uuid → node
  object → `//@file:` placeholder → source file) in one step."
- [Plan 0](BACKLOG.md): **Create workflows from the repo** (2026-07-19; n8n
  2.x-only) — "`push --create` … let a workflow folder authored in the repo
  become the source of truth end to end … Touches the id-first data model and
  the 'born in n8n' guidance in PLAN.md + template AGENTS.md."

## Tasks

1. **`add` verb (P2, offline).** `n8n-decanter <ref> add "<Node name>"
   [--ts]`: mint a v4 uuid (reuse `randomUUID`), append a
   `n8n-nodes-base.code` node object to `workflow.json` (default parameters,
   `mode: runOnceForAllItems`, a `//@file:` placeholder), create the source
   file under `code/` via the existing kebab-case naming
   (`resolveNodeFile`/`kebabCase`), and register the node in `.decanter.json`.
   No connections are wired (that's a manual/editor step) — the node lands
   disconnected but compliant. Re-run `validateWorkflowDir` afterward and fail
   loudly on any violation, exactly like `rename`. Push propagates. Shares the
   filename-collision handling (`-<id8>` suffix) with pull/rename.

2. **`push --create` (P3, data-model change — needs user sign-off).**
   When a workflow folder has **no `workflowId`** (or a sentinel "unassigned"
   marker), `push --create` calls `N8nApi.createWorkflow(sanitizeForPut(wf))`
   (`POST /api/v1/workflows`), then writes the returned id into
   `.decanter.json`, records sync hashes from the POST response (same
   server-canonical rule as PUT), and — optionally — appends the id to
   `decanter.config.json`. Without `--create`, a missing id stays a hard error
   ("pull first"), so nothing changes for the pull-first flow. Scaffolding a
   fresh folder (no pull) needs a tiny `new`/`init-workflow` helper or a
   documented minimal `workflow.json` skeleton.

## Acceptance / verification

- `add` creates a compliant, checkable Code node in one command (node object +
  `code/` file + `.decanter.json` entry + placeholder), disconnected, and a
  subsequent `push` sends it. Colliding kebab names get the `-<id8>` suffix.
- `push --create` on an id-less folder creates the workflow remotely, captures
  the assigned id into `.decanter.json`, and a follow-up `pull` round-trips it
  byte-cleanly. Existing (id-bearing) folders are unaffected by the flag.
- `npm test` grows an e2e step for each (mock server gains a `POST /workflows`
  handler for task 2); the smoke suite exercises the real `POST` on the pinned
  version.

## Non-goals

- Full graphical authoring (connections, node positioning, trigger wiring) —
  `add` lands a disconnected node; wiring stays in the editor or manual JSON.
- Non-Code node scaffolding — `add` is Code-node-specific (the tool's domain).

## Notes

- **PLAN.md data-model change (task 2):** repo-born workflows invert the
  "born in n8n" rule and the id-first assumption (folders currently exist only
  after a pull assigns an id). This **must be raised with the user before
  landing** (per `CLAUDE.md`) — the plan file is a proposal, not approval. The
  template `AGENTS.md` "born in n8n" guidance would need updating alongside.
- **CHANGELOG:** the `add` verb and the `push --create` flag are user-facing →
  `Added` under `[Unreleased]` when they land.
- Pairs with [Plan 20](OPEN-20-cli-publish-lifecycle.md): `add` →
  `push --create` → `publish` would make the whole author→create→publish loop
  CLI-native.
- Keep `add` strictly offline (like `rename`): no credentials, push does the
  network half — preserves the offline-verb set the agent permission configs
  rely on.
