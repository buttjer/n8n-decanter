# Plans

This folder is the whole backlog (the former `IDEAS.md` was absorbed here,
2026-07-17). A numbered plan is an item (or batch of related items) fleshed out
enough to start; [Plan 0](0-backlog.md) is the grab-bag of open
items not yet claimed by one. Recommended order:

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
4. [Editor node diagnostics](4-editor-node-diagnostics.md) — a TS
   language-service plugin that suppresses the editor-only TS1108/1375/1378 false
   positives on node files. Related to Plan 1's edit-loop work but larger
   (needs a load-path spike), so it trails the first three.
5. [Browser refresh after push](5-browser-refresh-after-push.md) — auto-refresh
   the n8n editor tab after a successful push. Direction still open (six
   candidates compared in the plan); starts with a live-instance spike, so it
   trails the offline work.
6. [TypeScript migration](6-typescript-migration.md) — convert the CLI's own
   source to strict `.mts` run natively via Node type stripping (no build
   step).

## Conventions

Every plan in this folder follows the same shape so they stay scannable and
mergeable:

- **Filename:** `NN-kebab-title.md`. `NN` is the plan's stable id and rough
  running order (how it's referenced, e.g. "Plan 3"). It is *not* the priority —
  priority lives in the header field below, so a low-numbered plan can be P2 and
  vice versa. Numbers don't get reused once assigned.
- **Header block** (before the first `##`, one bold field per line):
  - `# Plan N — Title`
  - `**Priority:**` `P1` (do first: small, clearly-right, high-value, offline) /
    `P2` (valuable, more scope/design) / `P3` (deferred). A plan may split
    priorities per task (e.g. "P1 (validator) / P2 (rename)").
  - `**Status:**` `Not started` / `In progress` / `Done`.
  - `**Theme:**` one-line what-and-why.
- **Sections**, in order:
  - `## Why` — the motivation/context.
  - `## Source` — the backlog entries ([Plan 0](0-backlog.md), or
    the retired `IDEAS.md` in older plans) and any `PLAN.md` refs this plan
    closes, so nothing is orphaned when an item leaves the backlog.
  - `## Tasks` — numbered, each grounded in the real files it touches.
  - `## Acceptance / verification` — how you know it's done.
  - `## Notes` — CHANGELOG/PLAN.md implications, decisions, deferrals.
  - Optional as needed: `## Design decision`, `## Non-goals`, `## Rollout`.
- **Cross-link** related plans by relative path (e.g. Plan 1 ↔ Plan 4 share the
  TS1108 story).

When a plan is fully implemented, tested, and documented, flip its `**Status:**`
to `Done` and check off any matching [Plan 0](0-backlog.md) box
(per `CLAUDE.md`).

These are scoped work plans, not design changes — anything that alters the data
model or flows in `PLAN.md` must be raised with the user first (see `CLAUDE.md`).
