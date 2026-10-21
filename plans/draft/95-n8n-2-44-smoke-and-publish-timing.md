# Plan 95 — n8n 2.44: two smoke failures, and whether `publish` returns before the version is live

**Status:** Draft
**Priority:** P2 — the second failure is test-only. The first one could mean
`publish` reports success before the new version runs, which users would feel.
Unproven either way; reproduce before building.
**Source:** local smoke runs against `n8nio/n8n:2.44.5` during the #327 fix
(PR #338, 2026-10-21). The CI smoke matrix still stops at 2.31.4 (2.30.7,
2.31.0, 2.31.4), so neither failure shows up in CI.
**Snapshot:** 2026-10-21T14:50Z @ 14b6bc9

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
