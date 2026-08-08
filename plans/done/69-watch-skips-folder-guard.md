# Plan 69 — A `watch` save skips the folder-wide compliance guard; four surfaces say it doesn't

**Status:** Done — watch runs the folder guard with a scoped abort; all four
surfaces corrected to describe that scoping rather than implying full parity.
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

## Resolution (2026-08-08) — neither option as written

Both framings were wrong in the same way: they treated it as one switch. Running
the folder guard is right, but **failing on the whole folder is not**, and the
plan's own "too strict for a hot save loop" worry is the reason. Mid-repair after
a rename, several files are stranded at once; a folder-wide abort stops every save
until the last fix, disabling `watch` during exactly the job it exists for.

So the guard is folder-wide and the **abort is scoped**:

- `validateWorkflowDir` gained `errorsByFile` — built where the errors are
  produced, not by matching message text, which would silently re-classify itself
  the next time a message is reworded.
- `pushSingleNode` fails on the errors attributed to the file being saved and
  prints the rest with `— not blocking this save; \`push\` and \`preflight\` gate
  on it`.
- Folder-level errors (duplicate names, connection integrity, orphans, and a node
  whose snapshot carries inline code and so names no file) stay unattributed by
  design: they belong to the folder, not to one save.

All four surfaces now describe *that*, rather than claiming a parity that would
be false in the other direction. An e2e step pins both halves at the real push
path — refused when the ref is in the saved file, allowed (and reported) when it
is in a sibling — because getting only one half right is what made watch lax in
the first place.
