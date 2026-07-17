# Plans

Actionable plans split out from [`IDEAS.md`](../IDEAS.md), grouped into batches
you can land as coherent units. Recommended order:

1. [Trustworthy edit loop](1-trustworthy-edit-loop.md) — make the hook/typecheck
   feedback green-by-default and scoped to the workflow being edited. Everything
   else the reviewer asked for only pays off once green is the default state, so
   this goes first.
2. [Offline validation + rename](2-offline-validation-and-rename.md) — turn the
   most fragile manual invariants (renames, connection integrity, orphan files,
   `$('…')` references) into machine-checked ones, then add an atomic `rename`.
3. [Local run/diff fidelity](3-local-run-and-diff-fidelity.md) — make offline
   iteration trustworthy: seed staticData in `run`, add `status --diff`, and pull
   real execution datasets as fixtures.

Each plan links back to its source items in `IDEAS.md`. These are scoped work
plans, not design changes — anything that alters the data model or flows in
`PLAN.md` should be raised with the user first (see `CLAUDE.md`).

## Other plans (not in the first three batches)

- [TS language-service plugin to suppress spurious node-file diagnostics](ts-plugin-suppress-node-diagnostics.md)
  — the deeper fix for the editor-only TS1108 squiggle. Related to Batch 1's
  edit-loop work but larger; kept separate.

