# Plan 21 — Local authoring helpers (`add` + `duplicate`)

| | |
|---|---|
| **Priority** | P2 |
| **Status** | Done |
| **Theme** | Two repo-side authoring conveniences that create new workflow surface **without inverting the pull-first model**: `add` scaffolds a Code node into a workflow (offline); `duplicate` clones an existing workflow into a brand-new remote one via the n8n 2.x `POST /api/v1/workflows` endpoint, landing the copy through a fresh pull. Neither touches the "born in n8n" invariant. |
| **Model** | **Sonnet** — both are mechanical wiring over machinery that already exists (uuid/kebab/rename for `add`; push-assembly + `createWorkflow` + pull for `duplicate`), gated on the same smoke work Plan 20 already carries. No novel design. |

## Why

The data model today is strictly **pull-first**: a workflow folder only exists
*after* a pull assigns it a remote id (`pullWorkflow` in `lib/pull.mts` writes
`.decanter.json` with the server's `workflowId`), and PLAN.md's guidance is
"workflows are born in n8n". Two frictions follow — both closable *without*
touching that model:

- **Adding a Code node** means a manual dance the CLI already has all the pieces
  for: mint a uuid (`uuid` verb), hand-write the node object in `workflow.json`,
  add a `//@file:code/<name>.js` placeholder, create the source file, keep
  `.decanter.json` consistent — then `check`. The `rename` verb proved the
  value of collapsing exactly this kind of multi-file edit into one atomic,
  guard-checked command.
- **Forking a workflow** — clone one to iterate on a variant, or restore a
  git-tracked workflow that was deleted remotely — is a manual UI round-trip
  today (duplicate in the editor, then re-pull). Because `duplicate` starts
  from an already-pulled, **id-bearing** folder and lands the copy through a
  fresh **pull**, it preserves pull-first exactly: the source folder came from
  a pull, and so does the new one. Nothing is born outside n8n.

**Dropped (2026-07-20, user decision):** an earlier draft proposed
`push --create` — creating a workflow from an **id-less** repo folder, which
*would* have inverted the pull-first / "born in n8n" model and needed sign-off.
It earns nothing now: Plan 20's `create` gives CLI-native genesis of a blank
workflow without inverting the model, and `duplicate` covers the clone case, so
the inverting variant was cut entirely.

## Source

- [Plan 0](../draft/): **`add` verb** — "scaffold a Code node (uuid → node
  object → `//@file:` placeholder → source file) in one step."
- [Plan 0](../draft/): **Create workflows from the repo** (2026-07-19; n8n
  2.x-only) — split by outcome: blank CLI-native create → Plan 20's `create`;
  clone an existing workflow → this plan's `duplicate`; the
  repo-as-source-of-truth (`push --create`) variant → dropped.

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

2. **`duplicate` verb (P2, needs credentials).** `n8n-decanter <ref>
   duplicate ["<new name>"]`: resolve the source ref (REF_VERBS), assemble the
   workflow body from the **local** folder exactly as `push` does (placeholders
   reconstituted from `code/`, `.ts` nodes compiled), run it through
   `sanitizeForPut`, and set a new name (the argument, or default
   `"<name> (copy)"`, matching the n8n UI). Create it remotely with
   `N8nApi.createWorkflow(body)` (`POST /api/v1/workflows`), then immediately
   **pull the returned id** so a fresh folder + `.decanter.json` materialize
   (pull-first preserved) and print the new id. Born **unpublished**, like any
   create. The source folder and the remote source workflow are left untouched.
   **`createWorkflow` + the POST smoke gate are shared with Plan 20's `create`
   — whichever plan lands first introduces the method; they must not both add
   it, nor re-verify the same endpoint.**

## Acceptance / verification

- `add` creates a compliant, checkable Code node in one command (node object +
  `code/` file + `.decanter.json` entry + placeholder), disconnected, and a
  subsequent `push` sends it. Colliding kebab names get the `-<id8>` suffix.
- `duplicate <ref> "<name>"` creates a new remote workflow carrying the
  source's content under the new name, and — via the pull it runs — leaves a
  new folder that round-trips byte-clean; the source folder and source remote
  workflow are unchanged; the new workflow reads unpublished. Colliding folder
  names get pull's usual handling.
- `npm test` grows an e2e step for each (mock server gains the `POST
  /workflows` handler, shared with Plan 20's `create`); the smoke suite
  exercises the real `POST` on the pinned version (create/duplicate share it).

## Non-goals

- Full graphical authoring (connections, node positioning, trigger wiring) —
  `add` lands a disconnected node; wiring stays in the editor or manual JSON.
- Non-Code node scaffolding — `add` is Code-node-specific (the tool's domain).
- Selective copy — `duplicate` clones the **whole** workflow, not a node subset.

## Notes

- **No PLAN.md data-model change.** Both verbs preserve pull-first — `add` is a
  local edit that `push` propagates; `duplicate` births the copy server-side
  and materializes it via pull. The "born in n8n" rule and the id-first
  assumption stand; only the verb list grows. (This is the whole reason
  `push --create`, which *would* have inverted the model, was dropped.)
- **`createWorkflow` ownership.** The `N8nApi.createWorkflow` method and its
  `POST /api/v1/workflows` smoke verification are shared with
  [Plan 20](../done/20-cli-publish-lifecycle.md)'s `create`. One plan introduces
  them; the other reuses. Don't duplicate the method or the gate.
- **CHANGELOG:** the `add` and `duplicate` verbs are user-facing → `Added`
  under `[Unreleased]` when they land.
- **Picker integration (Plan 19).** `duplicate` acts on a picked workflow and
  is non-destructive, so it belongs in the verb menu — default the copy name
  to `"<name> (copy)"` so it clones the highlighted workflow in one keystroke,
  no prompt. `add` does *not* (scaffolding a node needs a node name and lands
  disconnected — a typed verb, not a menu pick). Wiring is Plan 19's surface;
  land the verb first. (Plan 20's picker note covers the publish-toggle,
  `delete`, and `create` sides of the same menu question.)
- Pairs with [Plan 20](../done/20-cli-publish-lifecycle.md): `create` (blank) /
  `duplicate` (from an existing workflow) / `add` (a node) / `publish` together
  make the whole author→create→publish loop CLI-native.
- Keep `add` strictly offline (like `rename`): no credentials, `push` does the
  network half — preserves the offline-verb set the agent permission configs
  rely on. `duplicate` needs credentials (it POSTs), like the other create-side
  verbs.

## Outcome (2026-07-20)

- **`add`** (`lib/add.mts`, offline): mints a v4 uuid, writes the kebab-case
  `code/` source (with the `-<id8>` collision suffix shared with pull/rename),
  appends the `n8n-nodes-base.code` node object (`typeVersion: 2`, `mode:
  runOnceForAllItems`, a `//@file:` placeholder) to `workflow.json`, registers
  it in `.decanter.json`, then re-runs `validateWorkflowDir` and fails loudly
  on any violation — the same shape as `rename`. `--ts` scaffolds a `.ts`
  source. Lands disconnected; `push` propagates.
- **`duplicate`** (`lib/lifecycle.mts`, needs credentials): assembles the body
  from the local folder exactly as `push` does (reusing the now-exported
  `assertCompliant` + `buildNodeCode`), sets the new name (arg or `"<name>
  (copy)"`), POSTs via `N8nApi.createWorkflow`, then pulls the returned id.
- **`createWorkflow` generalized** to take a full `WorkflowPut` body (was
  name-only); `create` now passes the minimal `{ name, nodes: [], connections:
  {}, settings: {} }`, `duplicate` passes the sanitized clone body. The
  `POST /workflows` gate stays shared — not re-introduced.
- **Tests:** e2e gains self-contained `add` + `duplicate` steps; new
  `test/unit/add.test.mts` and a `duplicateWorkflow` block in
  `lifecycle.test.mts`. Two dedicated smoke steps prove the real-n8n-only
  facts: a scaffolded node's **default body executes** in the Code sandbox
  (webhook-triggered) and a `duplicate` clone is **born unpublished from a
  published source** and **independent** (editing the clone leaves the source
  untouched; connections preserved; `.js` byte-clean round-trip). All green —
  `npm test` (186 unit + 69 e2e + 10 proxy + 12 interactive) and
  `npm run test:smoke` (21/21 against `n8nio/n8n:2.30.7`).
- **Picker menu wiring left to Plan 19** as noted (verb landed first).
- **`uuid` verb retired (breaking).** Its sole purpose — minting a node id for
  hand-adding a Code node — is now subsumed by `add` (which mints the id as
  part of the scaffold), so the bare generator was removed rather than left as
  a redundant surface. CLI, docs, agent template, and the offline-verb sets
  updated to point at `add`.
