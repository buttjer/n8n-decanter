# n8n-decanter — agent & project guide (single source of truth)

This file is the **single source of truth** for coding agents working **on the
n8n-decanter CLI itself** (not on a synced workflow dir — that's the template's
`AGENTS.md`). It is tool-agnostic: Codex and opencode read it natively, and
Claude Code reads it through a one-line import in `CLAUDE.md`. Everything —
response style, project rules, changelog/docs/backlog duties, git workflow,
commands, architecture, and the shared recipes — lives here; keep the rules in
one place and let the per-agent files stay thin pointers.

`PLAN.md` is a separate, complementary source of truth: it is the CLI's
**design** document (data model, flows, past decisions). This file governs *how
to work on the repo*; `PLAN.md` governs *what the CLI is*. Keep both current and
don't let either drift from the code.

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

## Before you start: read your permission allowlist

Every task/plan execution starts by **reading the harness's permission config
so you know what's already pre-approved** — this is the single biggest lever
for not interrupting the user with questions about commands you were always
allowed to run. For Claude Code that's `.claude/settings.json` (shared) and
`.claude/settings.local.json` (per-machine): the `allow` / `deny` / `ask`
lists spell out which `Bash(...)`, `WebFetch`, and other calls run without a
prompt. Other harnesses (Codex, opencode) have their own allowlist config —
read whichever applies. Don't ask permission for something the allowlist
already grants, and don't re-run a variant just to dodge a prompt when the
plain command is allowed.

## Changelog

Maintain CHANGELOG.md (Keep a Changelog format) in the same change as the
code, without being asked: every user-facing change — CLI commands/flags,
sync behavior, data model (`.decanter.json`, markers, placeholders), guard
rules, template contents — gets an entry under `[Unreleased]` in the fitting
category (Added/Changed/Fixed/Removed), written for users, not a commit log.
Internal refactors and test-only changes get no entry. Prefix breaking
changes with **Breaking:**. On release, rename `[Unreleased]` to
`[<version>] - <date>` and start a fresh `[Unreleased]`.

## Documentation site — keep ALL surfaces in sync

The user-facing docs live in **`/docs`** as plain Markdown (repo root, outside
`website/` so they outlive the Astro tooling — Astro reads them via a `glob`
loader). **Keeping them current is a PR acceptance criterion**, on par with the
changelog. Docs stay usage-level; PLAN.md remains the internal design source of
truth. Keep it plain Markdown (no bespoke MDX components) so the corpus stays
generator-agnostic.

The command surface is described in **three independent places that must not
drift**. A user-facing change (any CLI command/flag, sync behavior, data model,
guard, or config a user would look up) updates **every one in the same PR** —
not just the one you happened to think of:

1. **`README.md`** — the `## Commands` block **and** the feature-bullet list up
   top. A new verb needs a command line; a notable capability needs a feature
   bullet. *(This is the one most easily forgotten — it's not generated from the
   others.)*
2. **`/docs`** (plain Markdown, rendered by the site in `website/`) — the
   matching `docs/cli/*` page(s) **and** the [overview](docs/cli/overview.md)
   command surface. New verb → new page.
3. **`CHANGELOG.md`** — an `[Unreleased]` entry in the right category.

Same bar throughout: user-facing → update all three; internal refactors and
test-only changes → none.

**Before opening a user-facing PR, grep the verb name across `README.md`,
`docs/`, and `CHANGELOG.md`** — every surface that lists sibling verbs should
list yours too. (The `simulate` verb once shipped in `/docs` + changelog but not
the README because the old rule named only `/docs`; this checklist exists so
that can't recur.)

## Backlog

`plans/` is the backlog (see `plans/README.md` for conventions);
`plans/BACKLOG.md` is the grab-bag of items without their own plan. When your
work **fully** completes a Plan 0 entry (implemented, tested, documented as
applicable), check it off (`- [x]`). Partially done is not done: leave the box
unchecked and append a short parenthetical status instead. Don't delete,
reword, or reorder the user's entries, and don't add ideas of your own unasked.

**Distinctive features get their own group.** When a change introduces a feature
that's **distinct from n8n itself and from the generic "n8n-as-code" (git-sync)
concept** — a capability that *differentiates* this tool rather than mirroring
n8n or plain workflow-syncing — record it in the backlog under **its own
group**, kept separate from the priority buckets and the parity/hardening work.
This keeps the tool's differentiators visible and tracked as a distinct class.

## Agent tooling

When adding agentic/LLM-facing material for this repo (a skill, recipe,
hook, instruction file), **never add it for one agent only** (e.g. just a
Claude `SKILL.md`): put the substance in this tool-agnostic root `AGENTS.md`
(same convention as the template's sync-dir `AGENTS.md` — Codex/opencode
read it natively) and keep per-agent files (`.claude/skills/*`, `CLAUDE.md`,
opencode config, …) as thin pointers to it, so every agent stays in sync.

## Git workflow & releases

- **main is protected — never commit to or push main directly.** Every change
  lands via PR from a short-lived branch (`feat/…`, `fix/…`, `docs/…`,
  `chore/…`), squash-merged so main stays linear: one commit per PR. A local
  `pre-commit` hook (`scripts/hooks/pre-commit`, auto-wired by the `prepare`
  npm script on every `npm install`) refuses any commit made in the main
  checkout (not just on the `main` branch) — see "The main checkout is guarded
  locally too" below.
- **Feature PRs are decoupled from releases — merging one is never a release.**
  A user-facing PR only appends its entry under `[Unreleased]` (per the
  Changelog rules); it does **not** bump `package.json`, tag, or cut a Release.
  `[Unreleased]` is meant to accumulate across many PRs, so user-facing work
  sitting in `[Unreleased]` on main is the expected steady state, not a problem
  to fix. Internal-only PRs (no `[Unreleased]` entry) likewise just merge.
- **Releasing is a deliberate, separate act: a dedicated release PR.** When you
  decide to cut version `x.y.z`, open a `chore/release-x.y.z` branch whose only
  job is to roll `[Unreleased]` → `[x.y.z] - <date>` (starting a fresh empty
  `[Unreleased]`) and bump `package.json` (semver; while 0.x: breaking → minor,
  everything else → patch). **Merging that release PR is the release.** After
  merge, tag the squash commit `vX.Y.Z` on main, push the tag, and create the
  GitHub Release from it with that version's changelog section as the notes
  (`gh release create vX.Y.Z --verify-tag --notes-file <section>`). The package
  is on npm (plans/DONE-13), but **`npm publish` is the maintainer's step —
  agents never run it.** An agent's release work ends at the pushed tag + GitHub
  Release; the maintainer publishes to npm. **Cutting a release is the
  maintainer's call — open a release PR only when explicitly asked, never
  automatically because `[Unreleased]` is non-empty.**
- CI (typecheck + `npm test`) must be green before merge, now enforced
  GitHub-side (see the ruleset bullet below). The ruleset gates **every** merge
  on the required checks — markdown-only changes can't *fail* them, but they
  still gate the merge, so watch them to green (`gh pr checks <n> --watch`)
  before merging.
- **Every repo-modifying task runs in its own worktree — no exceptions,
  docs and Markdown included.** There is no "fast path" that branches in the
  main checkout: the main checkout is *shared*, so a concurrent session (or the
  IDE's git integration) flips its `HEAD` and branch out from under you
  mid-edit. Start by creating a worktree in the gitignored `.worktrees/` dir
  (`git worktree add -b feat/x .worktrees/feat-x main`) and working there —
  don't edit the main checkout unless the user explicitly says to. Read-only
  work (questions, reviews, exploration) needs no worktree. Claude Code enters
  it via `EnterWorktree` with `path: .worktrees/feat-x`. After the PR is merged,
  remove the worktree, delete the branch, and refresh main with `git switch
  main && git pull` **in the main checkout** (merged branches auto-delete on
  GitHub). Each worktree needs its own `npm install`. Concurrent `npm test`
  across worktrees is safe (tests bind ephemeral ports), and so is concurrent
  `test:smoke` (PID-suffixed container name, ephemeral host port, mkdtemp work
  dir). **Never run `git clean -fdx`/`-fdX` from the repo root** — it deletes
  `.worktrees/` including uncommitted work; clean inside subdirs (e.g. `dist/`)
  instead.
- GitHub-side enforcement (require PR + green required checks, block
  force-push) is **live** via the public-repo ruleset (plans/DONE-13).
  Auto-merge is not enabled on the repo and admin-bypass is disallowed, so a
  blocked merge means "checks still pending" — wait them out, don't try to
  force it.
- **Sandboxed shells:** `git push`/`gh` fail in the command sandbox
  (credential helper unreachable — "could not read Username"); rerun that
  command with sandbox escalation. Details + `.git/config` gotcha:
  "Sandboxed shells" below.

## One worktree per task — never reuse a dirty one

Every repo-modifying task runs in its **own** `.worktrees/<name>` worktree
branched off `main` (`git worktree add -b feat/x .worktrees/feat-x main`) — the
core rule is in "Git workflow & releases" above; read-only work needs no
worktree.

**The trap that keeps biting: being *launched inside* an existing worktree does
NOT make it the right place for your task.** A worktree already carries a branch
and, often, unrelated uncommitted work (that's why it exists). Dumping a new,
distinct task's edits on top mixes two unrelated changes into one branch — the
exact mess this rule prevents. So:

- **A distinct task gets a fresh worktree.** Before editing, check the worktree
  you're in: if its branch/uncommitted changes are unrelated to your task
  (`git status`, `git log --oneline main..HEAD`), **stop and `git worktree add`
  a new one off `main`** — do not add your edits to the dirty worktree.
- **Create a new worktree when the user tells you to**, and default to one for
  any new distinct task. When unsure whether the current worktree is "yours,"
  the safe answer is a fresh worktree — never silently reuse someone else's.
- Only keep working in the current worktree when the task genuinely *continues*
  the work already staged there.
- **Already made edits in the wrong worktree?** Move only those files out
  cleanly: `git diff -- <files> > patch`, `git worktree add -b <branch>
  .worktrees/<name> main`, `git -C <new worktree> apply patch`, then
  `git checkout -- <files>` in the original to revert them there.

## The main checkout is guarded locally too (pre-commit hook)

The GitHub ruleset blocks *pushes* to main, but nothing upstream stops a
*local* commit made in the main checkout when the worktree rule gets skipped. A
tracked `scripts/hooks/pre-commit` catches that: it aborts any commit **not**
made from a linked `.worktrees/` worktree. It gates on the *working tree*, not
the branch — a linked worktree's git-dir lives under `.git/worktrees/` (allowed)
while the main checkout's is plain `.git` (refused) — which subsumes the old "no
commits on the `main` branch" rule, since `main` only ever lives in the main
checkout. It's **self-installing** — the `prepare` npm script
(`scripts/setup-hooks.mts`) points `core.hooksPath` at `scripts/hooks` on
every `npm install`, so the guard activates automatically in each clone and
worktree (which already run their own `npm install`). No hand-wiring needed;
the manual equivalent, if you ever want it, is:

```sh
git config core.hooksPath scripts/hooks
```

A missing hook is a no-op, so this is safe to set before the file exists.
There is never a legitimate local commit in the main checkout (the only local
touch is `git switch main && git pull` after a merge); the emergency override is
`ALLOW_MAIN_COMMIT=1 git commit …`. If a commit is refused with "Refusing to
commit in the main working tree", you skipped the worktree step — start a
`.worktrees/` worktree (`git worktree add -b <branch> .worktrees/<name> main`)
and retry.

## Sandboxed shells: git push / gh need escalation

Agent command sandboxes (Claude Code sandbox mode, Codex sandbox, …) block
the network credential path git needs, while local git works fine:

- **`git push` / `gh pr …` / anything hitting github.com fails sandboxed**
  with `fatal: could not read Username for 'https://github.com': Device not
  configured` — the credential helper (macOS keychain) is unreachable from
  the sandbox. This is an environment artifact, not an auth problem: rerun
  the *same* command with the sandbox escalation your harness provides
  (Claude Code: retry the Bash call with `dangerouslyDisableSandbox: true`;
  don't loosen the sandbox config for this). `git push *` is on the Claude
  Code allowlist (`.claude/settings.json`) so it runs without a permission
  prompt — only the sandbox escalation is still required; force-push
  (`--force`/`-f`) stays denied.
- **`.git/config` writes are blocked sandboxed** — e.g. `git branch -D` of
  a branch with an upstream deletes the branch but then warns `could not
  lock config file`, leaving a stale `branch.<name>` section. Clean up
  unsandboxed: `git config --remove-section branch.<name>`.
- Commit, status, diff, log, branch creation, worktree add — all fine
  sandboxed; only credential/network git and `.git/config` writes need
  escalation.

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

## Verifying changes at the CLI surface

Drive the real CLI (`node n8n-decanter.mts <verb>`) as a subprocess against a
throwaway mock n8n API — do not import `lib/` modules directly and call
functions; the CLI process is the surface users touch.

### Recipe

- **Mock API**: ~40-line `node:http` server on `127.0.0.1:<port>` serving
  `GET/PUT /api/v1/workflows/:id` from a mutable in-memory workflow; log
  requests; add a control route (e.g. `PUT /__remote`) to simulate n8n-UI
  edits mid-session. Fixture gotcha: `connections` must reference real node
  names or the compliance guard blocks pushes.
- **Sync dir**: temp dir with `.env` (`N8N_HOST=http://127.0.0.1:<port>`,
  `N8N_API_KEY=test`) + `decanter.config.json`
  (`{"root":"./workflows","workflows":["wf1"],"browserReload":"off"}`), then
  `git init` + local `user.name`/`user.email` — pull/push/watch auto-commit,
  and watch refuses its startup pull without git.
- **Bootstrap**: run `node n8n-decanter.mts pull` (cwd = sync dir) to create
  the layout; then drive the verb under test.
- **watch**: spawn it, poll its captured stdout for marker lines
  ("watching workflow", "pushed", conflict text); 200 ms debounce — allow
  ~500 ms after a file write before asserting. Piped stdin exercises the
  non-TTY paths. For TTY-only paths (the structural-conflict prompt) wrap
  the CLI in `expect` — macOS `script -q /dev/null` does NOT work with piped
  stdin ("tcgetattr … not supported on socket"). Coordinate `expect` sends
  with driver-side file edits via marker files.

### Gotchas

- **`fs.watch` dies under sandboxed shells** (`EMFILE, watch` from FSEvents)
  and takes the watch process down — run watch drives unsandboxed; it is an
  environment artifact, not a code failure.
- The e2e suite's mock (`test/e2e.mts`) is in-process and not importable;
  building a fresh mock is faster than extracting it.
- CLI output contains ANSI codes even when piped (known, Plan 11) — match
  with regexes, not exact strings.

## Housekeeping routine

A periodic maintenance pass over the repo — run it on demand (Claude Code:
`/housekeeping`). Each step is a **check** that may produce a small PR; batch
related fixes into a single worktree branch/PR (every repo-modifying task uses a
worktree — see "Git workflow & releases" above). A pass that finds nothing to do
is a valid outcome — report it. Anything needing a non-obvious decision →
surface it, don't guess.

Start from an up-to-date `main` (`git switch main && git pull`), then:

1. **Backlog hygiene** (`plans/`) — for each open `- [ ]`, check whether the
   code already *fully* satisfies it (implemented + tested + documented). If
   so, check it off with a dated parenthetical; if only partial, leave the box
   and append a short status. **Never delete, reorder, reword, or add to the
   user's entries.**
2. **Docs & changelog currency** — diff what merged since the last pass against
   `/docs`, `CHANGELOG.md` `[Unreleased]`, and `PLAN.md`. Any user-facing CLI /
   sync / data-model / guard / config change that landed without its docs +
   changelog entry gets one now (rules: "Changelog" and "Documentation site"
   above). PLAN.md must not have drifted from the code.
3. **Release check** — releases are decoupled from feature PRs (see "Git
   workflow & releases" above), so a non-empty `[Unreleased]` is normal: it
   accumulates until the maintainer decides to cut a release, and is **not** by
   itself a signal to release. Do **not** cut a release here — that's a
   deliberate, maintainer-requested `chore/release-x.y.z` PR. This check only
   verifies consistency: the latest git tag == `package.json` version, and that
   tag's `[x.y.z]` changelog section matches what's released. If those line up,
   surface the size/age of the pending `[Unreleased]` as an FYI and move on.
   **`npm publish` is the maintainer's step — agents never run it.**
4. **Worktree & branch prune** — remove `.worktrees/*` whose branch is merged
   or gone (`git worktree remove`), delete merged local + remote branches, and
   clean stale `.git/config` `branch.<name>` sections left by sandboxed deletes
   (see "Sandboxed shells" above). **Never `git clean -fdx` from the repo
   root** — it nukes `.worktrees/`.
5. **Dependency PR triage** — review open Dependabot PRs; merge the safe ones
   (green CI, minor/patch). For majors, record the decision in the backlog
   (e.g. TypeScript 7.x → `plans/BACKLOG.md`) rather than silently merging.
6. **CI & tests green** — main's required checks are green, `npm test` and
   `npm run typecheck` pass locally, and no open PR is red.
7. **Drift audits** — `template/*.example` still match their repo counterparts
   (e.g. the `n8n-globals.d.ts` duplication, a tracked backlog item); run
   `npm audit` for new advisories.
