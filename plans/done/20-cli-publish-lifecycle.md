# Plan 20 — CLI publish lifecycle

| | |
|---|---|
| **Priority** | P2 |
| **Status** | Done |
| **Theme** | Close the n8n 2.x workflow lifecycle from the CLI: `publish` / `unpublish`, `create` / `delete` verbs, a version-aware `status` line, and a stale-fixture warning for `executions` — all hanging off the publish/API semantics already researched and recorded in `PLAN.md`. |
| **Model** | **Sonnet** — well-scoped, API-shaped work (thin verbs, a couple of threaded response fields, one warning) gated on smoke verification, no novel design; the semantics are already nailed in `PLAN.md`. Give the destructive `delete` path (confirmation gate, irreversibility) a careful review pass — Opus if you want a second set of eyes on that one verb. |

## Why

`PLAN.md` ("n8n 2.x publish semantics", researched 2026-07-18) already nails
the model: 2.x splits a workflow into a **draft** (`versionId`) and a
**published** version (`activeVersionId`); the public `PUT` hardcodes
`publishIfActive: true`, so a push to a *published* workflow auto-publishes,
while a push to an *unpublished* one only updates the draft.

Today the CLI can **observe** that bit but not **act** on it:

- `publicationState` (`lib/util.mts`) reads the `active` flag; push/`status`/
  `watch` append a published/unpublished note (`lib/push.mts` `liveNote`,
  `lib/status.mts`, `lib/watch.mts`). That's the whole surface.
- There is **no way to take a draft live** or pull a published workflow back to
  draft-only from the CLI — the loop ends at "draft updated", and finishing it
  means switching to the n8n UI.
- `status` reports only the **binary** published/unpublished flag, never
  "the live version is older than your draft", even though the 2.x GET exposes
  both `versionId` and `activeVersionId`.
- `executions` data (`lib/executions.mts`) records the `workflowVersionId` it
  ran — the *published* version — but nothing warns when that lags the draft
  the user is now editing (PLAN.md's "convenience data, not ground truth"
  caveat, currently unenforced).
- The lifecycle also has no first and last step: a workflow can't be **born**
  from the CLI (blank draft on the server, then pulled — still "born in n8n",
  just without opening the UI) and can't be **removed** from the CLI either.

The items are small individually and share one API/semantics surface, so they
belong in one plan.

## Source

- [Plan 0](../draft/): **`publish` / `unpublish` verbs** (2026-07-19).
- [Plan 0](../draft/): **Version-aware `status`** (2026-07-19).
- [Plan 0](../draft/): **Stale-fixture warning for executions** (2026-07-19).
- `PLAN.md` "n8n 2.x publish semantics" — the researched constraints this plan
  builds on (auto-publish on PUT, unreachable optimistic locking, GET returns
  the draft).
- Direct user request (2026-07-20): extend the plan with `create` and
  `delete` workflows.

## Tasks

1. **`publish` / `unpublish` verbs.** Add `N8nApi.activateWorkflow(id)` /
   `deactivateWorkflow(id)` in `lib/api.mts` (`POST
   /api/v1/workflows/:id/activate` and `.../deactivate` — **verify the exact
   endpoint + response shape against the Plan 15 smoke rig before coding**; the
   public API surface is the source of truth, not this note). Register the
   verbs in `VERBS` (and `REF_VERBS` for name resolution) in
   `n8n-decanter.mts`, dispatch to a thin `lib/` handler. Semantics to hold:
   `publish` = "take this draft live"; `unpublish` = "back to draft-only". Only
   meaningful on an **unpublished** workflow — a push to an already-published
   one auto-publishes, so `publish` on it is a no-op (say so, don't error).
   Both need credentials (not offline). Emit the same
   published/unpublished note the push path already prints.

2. **Version-aware `status`.** The 2.x GET carries `versionId` (draft) and
   `activeVersionId` (published). Thread them into `Workflow`
   (`lib/types.mts`) and `publicationState` (or a sibling), then upgrade the
   `status` line in `lib/status.mts` from the binary
   published/unpublished string to "published version is older than the draft
   — push or `publish` to go live" when `activeVersionId !== versionId` on a
   published workflow. **Confirm both fields are present** in the smoke GET
   response first (PLAN.md's folder-placement question was answered exactly
   this way — a raw GET via the smoke rig); degrade to today's line when the
   server omits them (mocks, exotic versions), same defensive stance as
   `publicationState`.

3. **`create` verb — a blank draft born on the server.**
   `n8n-decanter create "<name>"`: `N8nApi.createWorkflow(name)` (`POST
   /api/v1/workflows` with a minimal body — name, empty `nodes` /
   `connections`, `settings`; **verify the minimal accepted body + response
   shape against the Plan 15 smoke rig first**; the pinData research already
   confirmed the API accepts create), then immediately pull the returned id so
   the folder + `.decanter.json` exist and the id is printed. The workflow is
   born **unpublished** (draft-only) — `publish` (task 1) takes it live, so
   create → edit → push → publish is a complete CLI loop. This does *not*
   invert PLAN.md's "born in n8n" rule: the server still assigns the id and
   owns the birth; the CLI just triggers it. **Boundary to
   [Plan 21](../done/21-repo-authored-workflows.md):** `create` starts from
   nothing; Plan 21's `duplicate` starts from an existing (already-pulled)
   workflow and clones it — both preserve pull-first, and both call this same
   `createWorkflow` method (this plan introduces it; `duplicate` reuses it —
   don't add it or its smoke gate twice). Duplicate names are allowed
   server-side — no client-side uniqueness check beyond what pull's folder
   naming already handles.

4. **`delete` verb — remove a workflow, deliberately.**
   `n8n-decanter <ref> delete`: resolve the ref (REF_VERBS), then
   `N8nApi.deleteWorkflow(id)` (`DELETE /api/v1/workflows/:id` — **verify
   via the smoke rig first**, including what 2.x actually does to a
   *published* workflow: hard delete, refusal until unpublished, or
   archive semantics — the answer shapes the UX and must be recorded in
   PLAN.md). Destructive and outward-facing, so consent is explicit: on a
   TTY, a `y/N` confirmation naming the workflow (name + id, via
   `lib/prompt.mts` — precedent: watch's conflict prompt); non-interactive
   runs require `--force` and abort with a clear error without it. The
   **local folder is never touched** — it stays as the git-tracked record;
   the result line says so and reminds about a stale
   `decanter.config.json` `workflows` entry if one exists. No cascade, one
   workflow per invocation (no `delete` without a ref, even if the config
   lists workflows — too much blast radius for a default).

5. **Stale-fixture warning for `executions`.** Executions record the
   `workflowVersionId` they ran (the published version). In `fetchExecutions` /
   `fetchExecutionById` (`lib/executions.mts`), after writing a file, compare
   its `workflowVersionId` against the current workflow's draft `versionId`
   (available from the pulled `workflow.json`, or a cheap GET) and `warn` when
   they differ: "execution ran published version X; your draft is Y — the
   captured data may not match the code you're editing." Keep it a warning, not
   an error — the data is still useful. This is the enforcement of PLAN.md's
   already-recorded caveat.

## Acceptance / verification

- `n8n-decanter <ref> publish` takes an unpublished workflow live; `unpublish`
  returns it to draft-only; both are no-ops-with-a-note on a workflow already
  in the target state. Verified against the pinned instance via the Plan 15
  smoke suite (which can already read `active`).
- `status` on a published workflow whose live version lags the draft prints the
  "older than draft" line; on an in-sync one it keeps the plain published note;
  a server without `activeVersionId` falls back to today's output.
- Fetching an execution whose `workflowVersionId` differs from the draft emits
  the stale-data warning; a matching one is silent.
- `create "<name>"` leaves a pulled folder + state file behind and prints the
  new id; the created workflow reads **unpublished**, and `publish` then takes
  it live (smoke: create → push code → publish → delete round-trip on the
  pinned instance).
- `delete <ref>` asks for confirmation on a TTY (naming name + id) and
  refuses without `--force` when non-interactive; after it, the remote
  workflow is gone while the local folder is untouched; `delete` with no ref
  errors, config or not.
- `npm test` stays green (mock server grows `activate`/`deactivate`, `POST`
  create, and `DELETE` handlers plus the version fields on its GET); the
  smoke suite asserts the real endpoints and fields exist on the pinned n8n
  version.

## Notes

- **Held invariant (do not design against it):** the public `PUT` hardcodes
  `publishIfActive: true` — updating an already-published workflow **always
  auto-re-publishes**; there is no draft-only update on a published workflow
  via the public API. Every task here respects that: `publish` only matters
  on unpublished workflows, `create` births an unpublished draft, `delete`
  and the `status`/`executions` work don't touch publish state. If upstream
  `publishBehavior: "skip"` (n8n-io/n8n#31954) ever ships, that's a *new*
  plan, not a silent assumption change here.
- **CHANGELOG:** the four verbs, the richer `status` line, and the executions
  stale-warning are all user-facing → `Added`/`Changed` under `[Unreleased]`
  when they land.
- **PLAN.md:** new verbs, a `status` semantics change, and two new
  API-response fields (`versionId`/`activeVersionId`) touch the design doc —
  **raise with the user before landing** (per `CLAUDE.md`; these plans are work
  scopes, not sanctioned design changes).
- **Live-verification gates (do not code blind):** the exact
  activate/deactivate endpoint shape (task 1), the presence of
  `versionId`/`activeVersionId` in the GET (task 2), the minimal `POST`
  create body (task 3), and `DELETE`'s behavior on a published workflow
  (task 4) must be confirmed via the Plan 15 smoke rig first — mirrors how
  the folder-placement question was resolved.
- Pairs naturally with [Plan 21](../done/21-repo-authored-workflows.md)'s
  **`add`** (scaffold a node) and **`duplicate`** (clone an existing workflow)
  verbs: together they'd make the whole author→create→publish loop CLI-native.
  `create` (from nothing) and `duplicate` (from an existing workflow) share the
  `createWorkflow` method + POST smoke gate — this plan owns them; Plan 21
  reuses. The dropped `push --create` (create from an id-less repo folder,
  which *would* have inverted the model) is gone from both plans.
- `--force` has no role in publish/unpublish — explicit user intents, not
  drift overrides. For `delete` it means exactly one thing: "skip the
  confirmation" (the non-interactive consent switch), a third meaning next
  to init's overwrite and push's drift bypass — the help text must say so.
- **Picker integration (Plan 19).** These verbs act on a picked workflow, so
  the verb menu should grow with them (it's already slated to gain
  `executions` — see [Plan 0](../draft/)):
  - **`publish` / `unpublish` → add as one state-aware toggle.** The
    version-aware GET (task 2) already knows the publish state, so the menu
    shows `publish` on a draft-only workflow and `unpublish` on a live one —
    one entry, not two. Safe, ref-taking, the picker's natural job.
  - **`delete` → stays out of the menu.** Destructive one keystroke from a
    fast-moving list is the risk the picker should avoid; it keeps its `y/N`
    gate as a typed verb. Include it (last, still confirmed) only as a
    deliberate later decision.
  - **`create` → not a verb-menu item** (no workflow to pick). It belongs in
    the picker's *workflow-list* stage instead — a "new workflow" affordance
    (dedicated key, or "type a name that matches nothing → create") — a
    separate, optional picker enhancement.
  Wiring the menu is Plan 19's surface, not this plan's tasks; land the verbs
  first, then add the menu entries in the same or a follow-up change.
- **PLAN.md:** beyond the task-1/2 notes above, `create`/`delete` extend the
  verb list and the "born in n8n" prose needs the one-line clarification
  that birth can now be *triggered* from the CLI — same raise-with-the-user
  gate as the rest of this plan.
