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
decision or observation, update the PLAN.md.
Never let PLAN.md silently drift from the code, update it unasked.**

## Changelog

Maintain CHANGELOG.md (Keep a Changelog format) in the same change as the
code, without being asked: every user-facing change — CLI commands/flags,
sync behavior, data model (`.decanter.json`, markers, placeholders), guard
rules, template contents — gets an entry under `[Unreleased]` in the fitting
category (Added/Changed/Fixed/Removed), written for users, not a commit log.
Internal refactors and test-only changes get no entry. Prefix breaking
changes with **Breaking:**. On release, rename `[Unreleased]` to
`[<version>] - <date>` and start a fresh `[Unreleased]`.

## Documentation site

The user-facing docs live in **`/docs`** as plain Markdown (repo root, outside
`website/` so they outlive the Astro tooling — Astro reads them via a `glob`
loader). **Keeping them current is a PR acceptance criterion**, on par with the
changelog: any change to CLI commands/flags, sync behavior, the data model,
guards, or config that a user would look up must update the matching page(s)
under `/docs` in the *same* PR — add a page for a new verb, revise the
[overview](docs/cli/overview.md) command surface, etc. Same test as the
changelog: user-facing → docs; internal refactor/test-only → none. Docs stay
usage-level; PLAN.md remains the internal design source of truth. Keep it plain
Markdown (no bespoke MDX components) so the corpus stays generator-agnostic.

## Git workflow & releases

- **main is protected — never commit to or push main directly.** Every change
  lands via PR from a short-lived branch (`feat/…`, `fix/…`, `docs/…`,
  `chore/…`), squash-merged so main stays linear: one commit per PR. A local
  `pre-commit` hook (`scripts/hooks/pre-commit`, enabled via `git config
  core.hooksPath scripts/hooks`) refuses commits made on main — see AGENTS.md
  "main is guarded locally too".
- **Merging a PR with a non-empty `[Unreleased]` section is a release.** That
  PR itself rolls `[Unreleased]` → `[x.y.z] - <date>` and bumps
  `package.json` (semver; while 0.x: breaking → minor, everything else →
  patch). After merge, tag the squash commit `vX.Y.Z` on main, push the tag,
  and create the GitHub Release from it with that version's changelog
  section as the notes (`gh release create vX.Y.Z --verify-tag --notes-file
  <section>`). Once the package is on npm (plans/OPEN-13), publishing joins
  this step. Internal-only PRs (no `[Unreleased]` entries per the Changelog
  rules) merge without a version bump — so user-facing work never sits
  unreleased on main.
- CI (typecheck + `npm test`) must be green before merge, now enforced
  GitHub-side (see the ruleset bullet below). **The docs fast path no longer
  skips the wait** — markdown-only changes still can't *fail* the checks, but
  the ruleset gates every merge on them, so watch them to green (`gh pr checks
  <n> --watch`) before merging.
- **Docs fast path:** a change touching only Markdown (`plans/`, `*.md`)
  skips the worktree — branch directly in the main checkout
  (`git switch -c chore/x`), commit, PR, wait for the required checks
  (`gh pr checks <n> --watch` — markdown can't fail them), merge, then
  `git switch main && git pull` (merged branches auto-delete on GitHub).
  **Never commit to main directly, fast path included.**
- **Worktrees for code:** any other repo-modifying task (code, config,
  tests, template, or anything mixing code with docs) starts by
  creating a worktree in the gitignored `.worktrees/` dir (`git worktree
  add -b feat/x .worktrees/feat-x main`) and working there — don't edit
  the main checkout unless the user explicitly says to. Read-only work
  (questions, reviews, exploration) needs no worktree. Claude Code enters
  it via `EnterWorktree` with `path: .worktrees/feat-x`. After the PR is
  merged, remove the worktree and delete the branch. Each worktree needs
  its own `npm install`. Concurrent `npm test` across worktrees is safe
  (tests bind ephemeral ports), and so is concurrent `test:smoke`
  (PID-suffixed container name, ephemeral host port, mkdtemp work dir).
  **Never run `git clean -fdx`/`-fdX` from the repo root** — it deletes
  `.worktrees/` including uncommitted work; clean inside subdirs (e.g.
  `dist/`) instead.
- GitHub-side enforcement (require PR + green required checks, block
  force-push) is **live** via the public-repo ruleset (plans/OPEN-13).
  Auto-merge is not enabled on the repo and admin-bypass is disallowed, so a
  blocked merge means "checks still pending" — wait them out, don't try to
  force it.
- **Sandboxed shells:** `git push`/`gh` fail in the command sandbox
  (credential helper unreachable — "could not read Username"); rerun that
  command with sandbox escalation. Details + `.git/config` gotcha:
  AGENTS.md "Sandboxed shells".

## Backlog

`plans/` is the backlog (see `plans/README.md` for conventions);
`plans/BACKLOG.md` is the grab-bag of items without their own
plan. A feature **distinct from n8n and the n8n-as-code (git-sync) concept**
gets its own backlog group (see `AGENTS.md`). When your work **fully**
completes a Plan 0 entry (implemented, tested,
documented as applicable), check it off (`- [x]`). Partially done is not done:
leave the box unchecked and append a short parenthetical status instead. Don't
delete, reword, or reorder the user's entries, and don't add ideas of your own
unasked.

## Agent tooling

When adding agentic/LLM-facing material for this repo (a skill, recipe,
hook, instruction file), **never add it for one agent only** (e.g. just a
Claude `SKILL.md`): put the substance in the tool-agnostic root `AGENTS.md`
(same convention as the template's sync-dir `AGENTS.md` — Codex/opencode
read it natively) and keep per-agent files (`.claude/skills/*`, opencode
config, …) as thin pointers to it, so every agent stays in sync.

## Commands

```sh
npm test              # unit tests (node:test, test/unit/) + e2e suite
                      #   (test/e2e.mts) + proxy suite (test/proxy.mts) +
                      #   interactive picker suite (test/interactive.mts,
                      #   PassThrough streams — no pty); e2e and proxy bind
                      #   localhost ports, and one e2e step uses fs.watch
                      #   (macOS FSEvents) — sandboxes that block port binding
                      #   or FSEvents break them (unit tests and the
                      #   interactive suite run fine sandboxed).
                      #   STEP=<substring> (env or --step=) runs a single
                      #   step/scenario of e2e/proxy/smoke in isolation
npm run typecheck     # tsc -p tsconfig.cli.json (CLI sources) + scripts/
                      #   typecheck.mts (node files — NOT plain tsc, see below)
npm run test:smoke    # OPT-IN, dev-only: real n8n in Docker (test/smoke-n8n.mts,
                      #   plans/15); needs a running Docker daemon; never part
                      #   of npm test

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
