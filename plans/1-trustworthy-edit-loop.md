# Plan 1 — Trustworthy edit loop

**Priority:** P1
**Status:** Not started
**Theme:** make the hook/typecheck feedback green-by-default and scoped to the
workflow being edited.

## Why

A fresh pull used to fail `check` with ~134 errors, and the PostToolUse verify
hook blocks on any non-zero exit while dumping the whole repo's error list — so
every edit was blocked from day one and people learned to route around the
guard. Commit `680f463` already fixed the green-by-default half (added `console`
+ `$getWorkflowStaticData` to the globals stub, set `noImplicitAny: false` /
`useUnknownInCatchVariables: false`). This plan finishes the job: close the last
stub gap, land the uncommitted redeclare fix, and scope the hook/typecheck to
one workflow so noise from unrelated workflows disappears.

## Source

- IDEAS: "js node files throw IDE errors … TS1108 / can't be redeclared … scope
  issue" (P1) — *redeclare half only; the TS1108 editor squiggle is
  [Plan 4](4-editor-node-diagnostics.md)*
- IDEAS: "the typecheck hook, just to the workflow it is currently worked on. Not
  global." (P1)
- IDEAS (new): `Duration`/`Interval` stub gap (P1)

## Tasks

1. **Duration/Interval stub gap.** Add `declare class Duration` and
   `declare class Interval` (Luxon subset) to **both** copies of the globals
   stub: root `n8n-globals.d.ts` and `template/n8n-globals.d.ts.example`.
   - `template/AGENTS.md.example` already advertises them and `lib/run.mts`
     (`buildGlobals`) already provides them via luxon — only the `.d.ts` lacks
     the stubs, so a node using `Duration`/`Interval` type-errors despite running
     fine. Keep the subset "pragmatic" (methods actually used); mirror the
     existing `DateTime` stub style.

2. **Commit the redeclare fix.** `moduleDetection: "force"` is currently
   uncommitted in `template/tsconfig.json.example` and root `tsconfig.json`.
   Making each node file its own module scope fixes the cross-file "cannot
   redeclare" errors — [Plan 4](4-editor-node-diagnostics.md) reports this half
   is already handled by `force`; confirm in-editor when you commit it. Commit it
   (with a CHANGELOG note if it changes the shipped template) and confirm the e2e
   "template content matches" assertion still passes.
   - The remaining TS1108 ("`return` outside function body") only affects the
     editor's own tsserver, not the CLI — `scripts/typecheck.mts` already wraps
     node bodies in an `async function`. `moduleDetection` / `module` knobs do
     **not** remove it (verified empirically in
     [Plan 4](4-editor-node-diagnostics.md)). The real editor-squiggle fix lives
     in that plan (a TS language-service plugin); until it lands, just document
     the false positive in the template's CLAUDE/AGENTS notes. Do **not** wrap
     files on disk (CLAUDE.md invariant).

3. **Scope the typecheck to a workflow.**
   - `scripts/typecheck.mts`: accept an optional path-filter argument. Still
     add every project file to the program (cross-file types need the whole
     graph), but only *report and count* diagnostics whose file resolves under
     the given dir(s).
   - `lib/validate.mts` `runTypecheck(startDir, log)`: add an optional
     `scopeDirs` param and forward it to the script.
   - `n8n-decanter.mts` `check`: it already resolves `dirs` from `[id...]`; pass
     those into `runTypecheck` so `check <id>` scopes typecheck as well as the
     layout checks. No-arg `check` stays project-wide.

4. **Scope the hook.** `template/.claude/hooks/verify.mjs.example` already locates
   the edited file's workflow folder (sibling `.decanter.json`). Read
   `workflowId` from that state file and call `n8n-decanter check <workflowId>`
   instead of bare `check`.
   - Note: `findWorkflowDir` matches on the state `workflowId`, **not** the
     folder name, so passing the folder basename would silently match nothing —
     read the id from `.decanter.json`.

## Acceptance / verification

- Fresh `init` → `pull` → `check` is green with zero errors out of the box.
- Introducing a type error in workflow A's node surfaces only A's diagnostics via
  the hook; an unrelated broken workflow B does not appear.
- `npm run typecheck` and `npm test` pass; e2e extended to cover scoped `check`.

## Notes

- CHANGELOG: the stub additions, the `moduleDetection` template change, and the
  new `check <id>` typecheck-scoping are user-facing (template contents / CLI
  behavior) — add entries under `[Unreleased]`.
- Deliberately **not** doing baseline-diffing (fail only on *new* errors): it
  institutionalizes red and drifts. Green-by-default + scoping is the fix.
