# Plan 20 — CLI publish lifecycle

**Priority:** P2
**Status:** Not started
**Theme:** Close the n8n 2.x draft→published loop from the CLI: `publish` /
`unpublish` verbs, a version-aware `status` line, and a stale-fixture warning
for `executions` — three backlog items that all hang off the publish semantics
already researched and recorded in `PLAN.md`.

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

The three items are small individually and share one API/semantics surface, so
they belong in one plan.

## Source

- [Plan 0](BACKLOG.md): **`publish` / `unpublish` verbs** (2026-07-19).
- [Plan 0](BACKLOG.md): **Version-aware `status`** (2026-07-19).
- [Plan 0](BACKLOG.md): **Stale-fixture warning for executions** (2026-07-19).
- `PLAN.md` "n8n 2.x publish semantics" — the researched constraints this plan
  builds on (auto-publish on PUT, unreachable optimistic locking, GET returns
  the draft).

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

3. **Stale-fixture warning for `executions`.** Executions record the
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
- `npm test` stays green (mock server grows `activate`/`deactivate` handlers and
  the version fields on its GET); the smoke suite asserts the real endpoints and
  fields exist on the pinned n8n version.

## Notes

- **CHANGELOG:** the two verbs, the richer `status` line, and the executions
  stale-warning are all user-facing → `Added`/`Changed` under `[Unreleased]`
  when they land.
- **PLAN.md:** new verbs, a `status` semantics change, and two new
  API-response fields (`versionId`/`activeVersionId`) touch the design doc —
  **raise with the user before landing** (per `CLAUDE.md`; these plans are work
  scopes, not sanctioned design changes).
- **Live-verification gates (do not code blind):** the exact
  activate/deactivate endpoint shape (task 1) and the presence of
  `versionId`/`activeVersionId` in the GET (task 2) must be confirmed via the
  Plan 15 smoke rig first — mirrors how the folder-placement question was
  resolved.
- Pairs naturally with the backlog's **Create workflows from the repo** /
  **`add` verb** items (see [Plan 21](OPEN-21-repo-authored-workflows.md)):
  together they'd make the whole author→create→publish loop CLI-native.
- `--force` has no role here — publish/unpublish are explicit user intents, not
  drift overrides.
