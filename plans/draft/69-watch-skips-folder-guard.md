# Plan 69 — A `watch` save skips the folder-wide compliance guard; four surfaces say it doesn't

**Status:** Draft
**Priority:** P2
**Source:** fell out of verifying claim B1 of the 2026-07-30 field report — the
reporter said the layout check missed stale parameter expressions; it doesn't,
but `watch` never runs it.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

`push`, `preflight` and `backup restore` run the folder-wide
`validateWorkflowDir`. A **watch save does not** — it guards with
`validateNodeFile` only, a strict Code-file-only subset. So watch will happily
push a node whose source references `$('Missing Node')`, or a folder with
duplicate names, broken connections, orphans or a retired `fixtures/` dir — all
of which a manual `push` refuses.

## Evidence

`watchWorkflow` → `pushSingleNode` ([`lib/watch.mts:89`](../../lib/watch.mts)) →
`assertCompliant(validateNodeFile(dir, nodeState.file), …)`
([`lib/push.mts:225`](../../lib/push.mts)). `validateNodeFile` has no access to
`workflow.json` and checks none of the folder-wide rules. Verified empirically: a
`code/main.js` containing `return $('Deleted Node').all();` returns
`{errors: [], warnings: []}` from `validateNodeFile` while `validateWorkflowDir`
on the same folder errors.

Four surfaces overstate it: `AGENTS.md:511`, `PLAN.md:538`,
[`docs/cli/preflight.md:140`](../../docs/cli/preflight.md) ("the same guard push
and watch run before writing"), [`docs/cli/watch.md:34`](../../docs/cli/watch.md)
("guarded by the same compliance rules as a manual push"). This split has existed
since the guard shipped (`a6c4050`) — the claim was **never** accurate.

## The decision

Either make it true or say the truth:

- **Make it true** — `pushSingleNode` runs `validateWorkflowDir`. Pure fs reads,
  no network, and the folder is freshly pulled at watch start. Question is whether
  that's too strict for a hot save loop (a broken connection elsewhere in the
  folder would block an unrelated node's save).
- **Say the truth** — correct all four surfaces to "a watch save runs the
  per-file subset; folder-wide rules are checked by `push`/`preflight`".

Worth noting for scoping: decanter has no code path that pushes a non-Code node's
parameters, so watch cannot *ship* a stale parameter ref anywhere — the exposure
is limited to Code sources and folder-level state. That argues the risk is lower
than it first reads, but it doesn't make the docs true.
