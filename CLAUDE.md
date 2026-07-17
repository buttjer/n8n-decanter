# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Ideas

IDEAS.md is the user's idea/todo backlog. When your work **fully** completes
an entry (implemented, tested, documented as applicable), check it off
(`- [x]`). Partially done is not done: leave the box unchecked and append a
short parenthetical status instead. Don't delete, reword, or reorder the
user's entries, and don't add ideas of your own unasked.

## Commands

```sh
npm test              # e2e suite (test/e2e.mjs) — spins up a mock n8n API on a
                      #   localhost port; sandboxes that block port binding break it
npm run typecheck     # scripts/typecheck.mjs — NOT plain tsc, see below
node n8n-decanter.mjs <init|pull|push|status|check|watch> …
```

The e2e suite is one sequential, stateful scenario (each step builds on the
previous); individual steps can't be run in isolation. It execs the CLI as a
subprocess — exec must stay async, a sync exec deadlocks against the in-process
mock server.

## Architecture

- `n8n-decanter.mjs` — thin CLI dispatcher; one module per concern in `lib/`.
- Data model (the part that spans files):
  - `workflows/<Name>/workflow.json` — full workflow, each Code node's
    `jsCode` replaced by a `//@file:<Node>.js` placeholder.
  - `workflows/<Name>/.decanter.json` — state: node-id → filename map plus
    sync hashes. `lastPushedHash` means "hash of the *remote* code at last
    sync (push **or** pull)", not only push. `lastPulledWorkflowHash` is the
    code-stripped, key-sorted structure hash.
  - `.js` node files are lossless (byte-identical round-trip). `.ts` files
    are one-way: push compiles via esbuild (`bundle: false`) and appends a
    `// @ts-n8n sha256:<hash of compiled JS>` marker line — marker presence
    is what identifies a TS-managed node on pull.
- Push runs two independent gates, in order:
  1. Compliance guard (`lib/validate.mjs`, shared with `check` and watch):
     layout violations are hard errors that `--force` does NOT bypass.
  2. Drift guard: remote changed since last sync → abort; only this one is
     bypassed by `--force`.
- Pull never touches `.ts` sources; unmergeable remote changes surface as
  `<Node>.remote.js` files. Pull re-baselines `lastPushedHash` even on
  conflict — meaning the next push overwrites remote edits by design.
- Sync hashes are recorded from the PUT *response*, not the request.
- `template/` is copied by `init` into new sync dirs. Files named
  `X.example` are inert in this repo on purpose (so agent tooling ignores
  them here) and materialize as `X` in the target — keep that suffix
  convention when adding agent/tool config to the template, and always use
  the full real filename before `.example` (`settings.local.json.example`).

## Type checking

n8n Code node source is a *function body* (top-level `return`/`await`), which
`tsc` rejects in `.ts` files (TS1108). `scripts/typecheck.mjs` wraps node
files in an in-memory `async function` via a custom CompilerHost and maps
diagnostic lines back; node files are recognized by a `.decanter.json`
sibling. Files on disk must stay verbatim — never "fix" a node file by
wrapping it on disk or stripping its top-level return.
