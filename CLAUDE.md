# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Response style

- Very compact — no long conclusions or wrap-up prose.
- Prefer bullet points over paragraphs.
- **Highlight** important things and decisions so they stand out.

## What this is

Standalone CLI that syncs n8n workflows into a git-friendly, folder-per-workflow
layout: Code node sources become individual `.js`/`.ts` files and get pushed
back via the n8n public API. **PLAN.md is the design document and source of
truth** — it also records past decisions/observations so the project could be
rebuilt from it.

**When your work changes the design, data model, flows, or surfaces a new
decision or observation, ask the user whether PLAN.md should be updated.
Never let PLAN.md silently drift from the code, and don't rewrite it unasked.**

## Changelog

Maintain CHANGELOG.md (Keep a Changelog format) in the same change as the
code, without being asked: every user-facing change — CLI commands/flags,
sync behavior, data model (`.decanter.json`, markers, placeholders), guard
rules, template contents — gets an entry under `[Unreleased]` in the fitting
category (Added/Changed/Fixed/Removed), written for users, not a commit log.
Internal refactors and test-only changes get no entry. Prefix breaking
changes with **Breaking:**. On release, rename `[Unreleased]` to
`[<version>] - <date>` and start a fresh `[Unreleased]`.

## Backlog

`plans/` is the backlog (see `plans/README.md` for conventions);
`plans/BACKLOG.md` is the grab-bag of items without their own
plan. When your work **fully** completes a Plan 0 entry (implemented, tested,
documented as applicable), check it off (`- [x]`). Partially done is not done:
leave the box unchecked and append a short parenthetical status instead. Don't
delete, reword, or reorder the user's entries, and don't add ideas of your own
unasked.

## Commands

```sh
npm test              # e2e suite (test/e2e.mts) — spins up a mock n8n API on a
                      #   localhost port; sandboxes that block port binding break it
npm run typecheck     # tsc -p tsconfig.cli.json (CLI sources) + scripts/
                      #   typecheck.mts (node files — NOT plain tsc, see below)
node n8n-decanter.mts <init|pull|push|status|check|watch> …
```

The e2e suite is one sequential, stateful scenario (each step builds on the
previous); individual steps can't be run in isolation. It execs the CLI as a
subprocess — exec must stay async, a sync exec deadlocks against the in-process
mock server.

## Architecture

- The CLI is TypeScript (`.mts`), run natively via Node's type stripping —
  no build step; requires Node >= 22.18. Only erasable TS syntax is allowed
  (`erasableSyntaxOnly`: no enums, namespaces, or parameter properties), and
  relative imports name the real `.mts` file. `tsconfig.cli.json` checks the
  CLI's own sources; the root `tsconfig.json` stays the workflow node-file
  config — its name is load-bearing (discovered by name by
  `scripts/typecheck.mts` and the sync-dir upward search).
- `n8n-decanter.mts` — thin CLI dispatcher; one module per concern in `lib/`;
  shared data-model types in `lib/types.mts`.
- Data model (the part that spans files):
  - `workflows/<Name>/workflow.json` — full workflow, each Code node's
    `jsCode` replaced by a `//@file:code/<node>.js` placeholder; node sources
    live kebab-case-named in the folder's `code/` subdir.
  - `workflows/<Name>/.decanter.json` — state: node-id → file-path map
    (`code/` prefix included) plus sync hashes. `lastPushedHash` means "hash
    of the *remote* code at last sync (push **or** pull)", not only push.
    `lastPulledWorkflowHash` is the code-stripped, key-sorted structure hash.
  - `.js` node files are lossless (byte-identical round-trip). `.ts` files
    are one-way: push compiles via esbuild (`bundle: false`) and appends a
    `// @ts-n8n sha256:<hash of compiled JS>` marker line — marker presence
    is what identifies a TS-managed node on pull.
- Push runs two independent gates, in order:
  1. Compliance guard (`lib/validate.mts`, shared with `check` and watch):
     layout violations are hard errors that `--force` does NOT bypass.
  2. Drift guard: remote changed since last sync → abort; only this one is
     bypassed by `--force`.
- Pull never touches `.ts` sources; unmergeable remote changes surface as
  `code/<node>.remote.js` files. Pull re-baselines `lastPushedHash` even on
  conflict — meaning the next push overwrites remote edits by design. Pull's
  rename machinery also migrates pre-`code/` flat layouts.
- Sync hashes are recorded from the PUT *response*, not the request.
- `template/` is copied by `init` into new sync dirs. Files named
  `X.example` are inert in this repo on purpose (so agent tooling ignores
  them here) and materialize as `X` in the target — keep that suffix
  convention when adding agent/tool config to the template, and always use
  the full real filename before `.example` (`settings.local.json.example`).

## Type checking

n8n Code node source is a *function body* (top-level `return`/`await`), which
`tsc` rejects in `.ts` files (TS1108). `scripts/typecheck.mts` wraps node
files in an in-memory `async function` via a custom CompilerHost and maps
diagnostic lines back; node files are recognized by a `.decanter.json`
sibling (directly, or in the parent of their `code/` dir). Files on disk must
stay verbatim — never "fix" a node file by wrapping it on disk or stripping
its top-level return.
