# Plans

This folder is the whole backlog (the former `IDEAS.md` was absorbed here,
2026-07-17). A numbered plan is an item (or batch of related items) fleshed out
enough to start; [Plan 0](BACKLOG.md) is the grab-bag of open
items not yet claimed by one. Recommended order:

1. [Trustworthy edit loop](DONE-1-trustworthy-edit-loop.md) — make the hook/typecheck
   feedback green-by-default and scoped to the workflow being edited. Everything
   else the reviewer asked for only pays off once green is the default state, so
   this goes first.
2. [Offline validation + rename](DONE-2-offline-validation-and-rename.md) — turn the
   most fragile manual invariants (renames, connection integrity, orphan files,
   `$('…')` references) into machine-checked ones, then add an atomic `rename`.
3. [Local run/diff fidelity](OPEN-3-local-run-and-diff-fidelity.md) — make offline
   iteration trustworthy: seed staticData in `run`, add `status --diff`, and pull
   real execution datasets as fixtures.
4. [Editor node diagnostics](OPEN-4-editor-node-diagnostics.md) — a TS
   language-service plugin that suppresses the editor-only TS1108/1375/1378 false
   positives on node files. Related to Plan 1's edit-loop work but larger
   (needs a load-path spike), so it trails the first three.
5. [Browser refresh after push](OPEN-5-browser-refresh-after-push.md) — auto-refresh
   the n8n editor tab after a successful push. Direction still open (six
   candidates compared in the plan); starts with a live-instance spike, so it
   trails the offline work.
6. [TypeScript migration](DONE-6-typescript-migration.md) — convert the CLI's own
   source to strict `.mts` run natively via Node type stripping (no build
   step).
7. [Engine-true simulation suite](OPEN-7-engine-true-simulation-suite.md) —
   replay a whole workflow through the real n8n engine offline: network nodes
   pinned from captured executions (LLM guesses fill gaps), pure nodes run for
   real, enforced no-side-effects. Depends on Plan 3's execution-dataset
   capture, so it goes last.
8. [Folder hierarchy in sync layout](OPEN-8-folder-hierarchy-in-sync-layout.md) —
   local dirs above a workflow folder become its n8n folder path, pushed
   one-way via the folders public API (the API can write placement but not
   read it); pull mirroring ships feature-detected so it self-activates once
   upstream exposes reads. Gated on a live-instance spike, so it trails the
   offline work.
9. [Test & stability quick wins](OPEN-9-tests-stability-refactoring.md) —
   the no-brainer hardening half: fast `node:test` unit tests for the pure
   core, the corrupt-`.decanter.json` crash fix (one broken state file
   currently breaks every command), small e2e/proxy coverage gaps, and
   mechanical dedupes. Fully offline, no decisions needed — can interleave
   with any other plan.
10. [Hardening: bigger refactors & decision-gated work](OPEN-10-hardening-bigger-refactors.md) —
    the rest of the hardening split: behavior changes (timeouts, `status`
    exit codes, debug switch), the deliberately-diverged dedupes
    (kebab-rename machinery, `code/`-parent lookup), watch testability, and
    CI. Each task needs a decision or checking first; lands after Plan 9's
    tests exist as the safety net.
11. [CLI look & feel](OPEN-11-cli-look-and-feel.md) — color, progress, and a
    logo strictly TTY-gated; workflow-name arguments, shell completion, and a
    `list` verb. Piped output stays plain and line-oriented (LLM/script safe —
    and fixes today's ANSI leak into pipes).

## Conventions

Every plan in this folder follows the same shape so they stay scannable and
mergeable:

- **Filename:** `STATUS-NN-kebab-title.md`, where `STATUS` is `OPEN` /
  `INPROGRESS` / `DONE` (mirrors the `**Status:**` header field; the backlog is
  the unprefixed `BACKLOG.md`). `NN` is the plan's stable id and rough
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
  - `## Source` — the backlog entries ([Plan 0](BACKLOG.md), or
    the retired `IDEAS.md` in older plans) and any `PLAN.md` refs this plan
    closes, so nothing is orphaned when an item leaves the backlog.
  - `## Tasks` — numbered, each grounded in the real files it touches.
  - `## Acceptance / verification` — how you know it's done.
  - `## Notes` — CHANGELOG/PLAN.md implications, decisions, deferrals.
  - Optional as needed: `## Design decision`, `## Non-goals`, `## Rollout`.
- **Cross-link** related plans by relative path (e.g. Plan 1 ↔ Plan 4 share the
  TS1108 story).

When a plan is fully implemented, tested, and documented, flip its `**Status:**`
to `Done`, rename the file's prefix to `DONE-` (update inbound links), and check
off any matching [Plan 0](BACKLOG.md) box (per `CLAUDE.md`).

These are scoped work plans, not design changes — anything that alters the data
model or flows in `PLAN.md` must be raised with the user first (see `CLAUDE.md`).
