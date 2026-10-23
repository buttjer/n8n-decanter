# Plan 95 — n8n 2.44: two smoke failures, and whether `publish` returns before the version is live

**Status:** In progress — code, docs and smoke done; the `ci.yml` matrix line is the operator's
**Priority:** P2 — the second failure is test-only. The first one could mean
`publish` reports success before the new version runs, which users would feel.
Unproven either way; reproduce before building.
**Source:** local smoke runs against `n8nio/n8n:2.44.5` during the #327 fix
(PR #338, 2026-10-21). The CI smoke matrix still stops at 2.31.4 (2.30.7,
2.31.0, 2.31.4), so neither failure shows up in CI.
**Snapshot:** 2026-10-22T06:00Z @ 0e257dc

With #338 applied, `test/smoke-n8n.mts` passes 36/36 on 2.31.4. On 2.44.5 it
passes 19 steps and then fails twice. With both bypassed in a throwaway copy,
it passes 36/36, so nothing else in the suite is version-blocked.

## Findings, as measured

1. **"executions API: shape matches what Plan 3 C designs against"** fails with
   `runData keyed by node name: Webhook,Compute,Respond`. The step takes the
   first `success` execution of `wfId` among the newest five from
   `GET /api/v1/executions?includeData=true&limit=5`, and expects the node name
   the earlier rename step set (`Ümläut Nödé`). It found the pre-rename name
   `Compute`. The agent that ran it reported that the webhook run straight after
   the rename and `publish` also recorded `Compute`, but did not keep the
   evidence. Two explanations, not yet told apart:
   - **(a) Publishing is asynchronous on 2.44.x.** `publish_workflow` returns
     before the new version is live, so the first run executes the old one. If
     true, `n8n-decanter publish` / `push --publish` report success too early.
   - **(b) The test picks the wrong execution.** It does not pin an execution
     id or order. On 2.44.x the list order, or an execution still `running`,
     could hand it an older success.
2. **The cleanup in "MCP read semantics…"** fails with `DELETE
   /api/v1/workflows/<id> -> 409 "Cannot delete a published workflow.
   Unpublish it before deleting."`. Straight after an unpublish, n8n answers
   `409 "Workflow is still being unpublished. Please try again in a few
   moments."`. That is the same asynchronous lifecycle as (a), on the unpublish
   side. Only the test's cleanup breaks.

## Rough scope

- **Reproduce 1 first:** on 2.44.5, rename → `publish` → trigger once and read
  the execution by id. Compare `workflowVersionId` with `activeVersionId` to tell
  (a) from (b).
- If (a): find what n8n exposes to say the new version is live, and have
  `publish` wait on it, bounded by a timeout. Changelog **Fixed** entry, plus a
  smoke step that pins the behaviour.
- If (b): have the test read the execution it triggered, by id.
- Finding 2: retry the cleanup `DELETE` on that specific 409, bounded.
- Then add `"2.44.5"` (or the newest stable by then) to `n8n_tag` in
  `.github/workflows/ci.yml`. **An agent's push token lacks the `workflow`
  scope, so this edit is the operator's**, or needs a token that has it.

## Findings (2026-10-22, main 0e257dc)

**It is (a): publishing is asynchronous from n8n 2.40.** Probe: rename +
change the code tag → MCP `publish_workflow` → one webhook call at once, then
more at +250 ms, +1 s, +3 s. The response body carries the code tag, so it
says which version ran without trusting the executions list.

| n8n | immediate call ran | switched by |
|---|---|---|
| 2.44.5 | old version, 3 of 3 rounds | +250 ms (2 rounds), +1 s (1 round) |
| 2.31.4 | new version, 3 of 3 rounds | — |

- **Cause:** `N8N_USE_WORKFLOW_PUBLICATION_SERVICE`, default `true` from
  2.40.0 (`false` through 2.39.5). `publish_workflow` commits
  `activeVersionId` and an outbox record, then returns; the leader drains the
  outbox and activates the new version (woken at once, 15 s fallback poll).
- **No client-reachable "is it live" signal.** n8n has one —
  `GET /rest/workflows/:id/publication-status` (`status`, `liveVersionId`,
  `pendingVersionId`) — but it is cookie-authed internal REST. MCP
  `publish_workflow` returns only `activeVersionId` (already moved), and
  neither `get_workflow_details` nor the public API exposes the status. So
  `publish` cannot wait on it. **Decision (operator, 2026-10-22):** make the
  success line honest instead of adding a guessed delay.
- **(b) was real too, as a second layer:** the list's newest success lags the
  webhook response, so "newest success" can be an older run even once the
  version is live. The smoke test now reads the run it triggered, by id.
- **Finding 2** is the same lifecycle: from 2.40, `DELETE` on a published
  workflow answers 409 "Cannot delete a published workflow", and for ~450 ms
  after an unpublish 409 "still being unpublished". 2.31.4 deletes a
  published workflow directly.

## Done

- `publish` / `push --publish` success line: "n8n activates it in the
  background; the previous version may still run for about a second" — on
  every n8n, no version check (operator, 2026-10-23: optimise for the latest
  n8n) instead of "code is live now". CHANGELOG Fixed, `docs/cli/publish.md`,
  `docs/cli/push.md`, PLAN.md.
- Smoke: `webhookExecution` (trigger once, read that run by id), `webhookLive`
  (trigger until a run executes the current `activeVersionId`, 20 s budget) —
  the rename step uses it and pins the version; the executions step reads that
  run by id. `deleteWorkflow` unpublishes a published workflow and retries only
  the "still being unpublished" 409, bounded (40 × 500 ms).
- Smoke 36/36 on 2.44.5 and 2.30.7.

## Left

- Add `"2.44.5"` to `n8n_tag` in `.github/workflows/ci.yml` — needs a token
  with the `workflow` scope (the operator's). Then this plan moves to `done/`.
