# n8n-decanter — agent guide (CLI repo)

Tool-agnostic guidance for coding agents working **on the n8n-decanter CLI
itself** (not on a synced workflow dir — that's the template's `AGENTS.md`).
Codex and opencode read this file natively; Claude Code additionally reads
`CLAUDE.md`, which holds the project rules (response style, PLAN.md contract,
changelog/docs/backlog duties, commands, architecture). Treat `CLAUDE.md` as
authoritative for those rules regardless of which agent you are; this file
carries the shared, tool-agnostic recipes.

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

## Docs are part of every user-facing PR — keep ALL surfaces in sync

The command surface is described in **three independent places that must not
drift**. A user-facing change (any CLI command/flag, sync behavior, data model,
guard, or config) updates **every one in the same PR** — not just the one you
happened to think of:

1. **`README.md`** — the `## Commands` block **and** the feature-bullet list up
   top. A new verb needs a command line; a notable capability needs a feature
   bullet. *(This is the one most easily forgotten — it's not generated from the
   others.)*
2. **`/docs`** (plain Markdown, rendered by the site in `website/`) — the
   matching `docs/cli/*` page(s) **and** the [overview](docs/cli/overview.md)
   command surface. New verb → new page.
3. **`CHANGELOG.md`** — an `[Unreleased]` entry in the right category.

Same bar throughout: user-facing → update all three; internal refactors and
test-only changes → none. Keep docs plain Markdown (no bespoke MDX components)
so the corpus stays generator-agnostic. Full rule and rationale: `CLAUDE.md` →
"Documentation site".

**Before opening a user-facing PR, grep the verb name across `README.md`,
`docs/`, and `CHANGELOG.md`** — every surface that lists sibling verbs should
list yours too. (The `simulate` verb shipped in `/docs` + changelog but not the
README because the old rule named only `/docs`; this checklist exists so that
can't recur.)

## Backlog: distinctive features get their own group

When a change introduces a feature that's **distinct from n8n itself and from
the generic "n8n-as-code" (git-sync) concept** — a capability that
*differentiates* this tool rather than mirroring n8n or plain
workflow-syncing — record it in the backlog (`plans/`) under **its own
group**, kept separate from the priority buckets and the parity/hardening
work. This keeps the tool's differentiators visible and tracked as a distinct
class. (Backlog mechanics otherwise per `CLAUDE.md`.)

## One worktree per task — never reuse a dirty one

Every repo-modifying task runs in its **own** `.worktrees/<name>` worktree
branched off `main` (`git worktree add -b feat/x .worktrees/feat-x main`) — the
core rule is in `CLAUDE.md`; read-only work needs no worktree.

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

## main is guarded locally too (pre-commit hook)

The GitHub ruleset blocks *pushes* to main, but nothing upstream stops a
*local* commit made on main when the worktree/branch rule gets skipped. A
tracked `scripts/hooks/pre-commit` catches that: it aborts any commit whose
current branch is `main`. It's **self-installing** — the `prepare` npm script
(`scripts/setup-hooks.mts`) points `core.hooksPath` at `scripts/hooks` on
every `npm install`, so the guard activates automatically in each clone and
worktree (which already run their own `npm install`). No hand-wiring needed;
the manual equivalent, if you ever want it, is:

```sh
git config core.hooksPath scripts/hooks
```

A missing hook is a no-op, so this is safe to set before the file exists.
There is never a legitimate local commit on main (the only local touch is
`git switch main && git pull` after a merge); the emergency override is
`ALLOW_MAIN_COMMIT=1 git commit …`. If a commit is refused with "Refusing to
commit directly on 'main'", you skipped the branch step — branch first
(`git switch -c chore/x` for docs, or a `.worktrees/` worktree for code) and
retry.

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
related fixes, keep markdown-only cleanups on the docs fast path (`CLAUDE.md`
→ "Docs fast path"). A pass that finds nothing to do is a valid outcome —
report it. Anything needing a non-obvious decision → surface it, don't guess.

Start from an up-to-date `main` (`git switch main && git pull`), then:

1. **Backlog hygiene** (`plans/`) — for each open `- [ ]`, check whether the
   code already *fully* satisfies it (implemented + tested + documented). If
   so, check it off with a dated parenthetical; if only partial, leave the box
   and append a short status. **Never delete, reorder, reword, or add to the
   user's entries.**
2. **Docs & changelog currency** — diff what merged since the last pass against
   `/docs`, `CHANGELOG.md` `[Unreleased]`, and `PLAN.md`. Any user-facing CLI /
   sync / data-model / guard / config change that landed without its docs +
   changelog entry gets one now (rules: `CLAUDE.md`). PLAN.md must not have
   drifted from the code.
3. **Release check** — a non-empty `[Unreleased]` means user-facing work is
   sitting unreleased: cut the release per `CLAUDE.md` (roll the section, bump
   `package.json`, tag `vX.Y.Z`, GitHub Release). Confirm the latest git tag ==
   `package.json` version and main is fully released. **`npm publish` is the
   maintainer's step — agents stop at the pushed tag + GitHub Release and never
   run it.**
4. **Worktree & branch prune** — remove `.worktrees/*` whose branch is merged
   or gone (`git worktree remove`), delete merged local + remote branches, and
   clean stale `.git/config` `branch.<name>` sections left by sandboxed deletes
   (`AGENTS.md` → "Sandboxed shells"). **Never `git clean -fdx` from the repo
   root** — it nukes `.worktrees/`.
5. **Dependency PR triage** — review open Dependabot PRs; merge the safe ones
   (green CI, minor/patch). For majors, record the decision in the backlog
   (e.g. TypeScript 7.x → `plans/BACKLOG.md`) rather than silently merging.
6. **CI & tests green** — main's required checks are green, `npm test` and
   `npm run typecheck` pass locally, and no open PR is red.
7. **Drift audits** — `template/*.example` still match their repo counterparts
   (e.g. the `n8n-globals.d.ts` duplication, a tracked backlog item); run
   `npm audit` for new advisories.
