# Plan 81 — a nested sync dir's scaffolded agent wiring never loads

**Status:** Not started — direction settled with the maintainer 2026-08-18;
tasks 8 + 9 investigated and closed 2026-08-18 (see "Settled findings"), the
remaining tasks reworked accordingly.
**Priority:** P2 — except **tasks 8 + 8a, which are P1**: the hook defects are
live bugs today (one of them, the `projects[]` key, misfires in every sync dir
nested in a git repo), the fix is small, offline and clearly right, and it must
land before the `init` note can print a hooks block.
**Source:** User field feedback 2026-08-18 ("verschachtelte Sync-Dir: die
scaffoldete MCP-Config greift vermutlich nicht"), same batch as
[Plan 80](../draft/80-mcp-token-handback-wording.md) and #267.
**Snapshot:** 2026-08-18T12:33Z @ c3b05c1
**Model:** Sonnet — the design calls are made; what's left is breadth across CLI,
`init`, templates, tests and docs.

`init` writes `.mcp.json` (and `.claude/settings.json`) **into the sync dir**
with a cwd-less command, which silently assumes the sync dir *is where the
agent is started*. When the sync dir is a subfolder of a bigger repo — a shape
[the docs explicitly promise works](../../docs/concepts/sync-layout.md) — an
agent launched at the repo root loads none of it, and hoisting the entry up to
the root starts the guard with `cwd` = repo root, where decanter's **upward**
config search cannot find `decanter.config.json`. The fix is an explicit
sync-dir override (`--dir` / `N8N_DECANTER_DIR`), self-locating hooks, and an
`init` that *prints* the working shapes when it detects the nested case.

## Why — the two halves both check out

**Half 1: the wiring is only loaded from where the agent starts.** *(Corrected
2026-08-18 — the original wording, "Claude Code reads project `.mcp.json` from
the project root; a nested copy is simply never loaded", is **false**. See
"Settled findings" for the verified rule and the inverted asymmetry.)* `.mcp.json`
is discovered by an **upward walk from the launch cwd**, so the scaffolded file
works fine for an agent started *in* the sync dir and is invisible only to one
started above it. `.claude/settings.json` is stricter still: **launch cwd only**,
no walk in either direction. `init` scaffolds both into the target dir
unconditionally ([`lib/init.mts:351`](../../lib/init.mts) only decides whether to
print the "restart your agent" hint) and says nothing about placement.

**Half 2: the command has no cwd, and the search only goes up.**
[`template/.mcp.json.example`](../../template/.mcp.json.example) is
`{"command":"npx","args":["--no-install","n8n-decanter","mcp","connect"]}` — no
`cwd` key. `loadConfig` searches from `process.cwd()` **upward only**
([`lib/config.mts:52-58`](../../lib/config.mts)), and every verb takes cwd with
no override — there is no `--dir`/`-C` anywhere in
[`n8n-decanter.mts`](../../n8n-decanter.mts). So the root-hoisted entry dies on
`decanter.config.json not found (searched from <root> upward)`.

**And the docs promise the shape that breaks.**
[`docs/concepts/sync-layout.md:17-18`](../../docs/concepts/sync-layout.md): *"It
is explicitly **not** 'your git root' … in a monorepo it can sit anywhere below
the repo root."* True for the sync verbs, false for the agent wiring `init`
scaffolds next to them. That contradiction is the bug.

## Design decisions (settled 2026-08-18)

- **Override the *starting point* of the upward search, never the search
  itself.** `loadConfig` already takes a `cwd` parameter
  ([`lib/config.mts:58`](../../lib/config.mts)); resolution changes, lookup
  logic does not.
- **Precedence: `--dir <path>` > `N8N_DECANTER_DIR` > `process.cwd()`.**
- **The env var is the load-bearing half, not the flag.** Every agent MCP
  config has an `env` block; a `cwd` field is *not* guaranteed across agents and
  versions. So the fix must not be built on `cwd`.
- **Global, not guard-only.** Pass the resolved dir through all three
  `loadConfig(process.cwd())` call sites
  ([`n8n-decanter.mts:284`, `:344`, `:504`](../../n8n-decanter.mts)) so every
  verb honours it. No special path for `mcp connect`.
- **`init` prints, never writes outside its target.** The parent's `.mcp.json`
  often already carries other servers, and the parent is not guaranteed to be
  the agent root. (Same boundary as [Plan 80](../draft/80-mcp-token-handback-wording.md):
  setup stays the user's.)
- **Rejected: a root-dir key in the sync dir's `.env`.** Structurally
  impossible: `loadEnv(dir)` runs **only after** the upward search has located
  the sync dir ([`lib/config.mts:80`](../../lib/config.mts)), so a `.env` inside
  the sync dir cannot say where the sync dir is — in the broken case it is never
  read at all. **Circular.** Any hint must arrive from outside: argv or the
  process environment. (A root-level `.env` would mean a second, upward-searched
  env file — a new lookup surface for one bug.) `PLAN.md` should record this as
  the standing answer to "why not just put it in `.env`?"
- **Detecting the nested case uses git — and that is not a contradiction.**
  sync-layout.md's "decanter never consults git" is about locating the **sync
  dir**; here git (or a `package.json` that is not the one just scaffolded)
  identifies the **agent's project root**, a different question. Say so in the
  docs so it does not read as a reversal.

Added after the tasks-8/9 investigation (maintainer decisions, same day):

- **"Start the agent in the sync dir" is the headline recommendation**, not the
  root wiring. It works today with zero config, and it is the only shape that
  keeps the scaffolded permission globs — including the `.env` protection —
  anchored correctly.
- **The printed note is the full one** (Option A, the Option-B MCP entry, and the
  Option-B hooks/permissions block), not a short pointer to the docs.
- **`mcp-route-check` walks ancestors, bounded at the git root** — enough to see
  a root-hoisted entry, without wandering into an unrelated parent tree.
- **Hooks locate themselves from `import.meta.dirname`**, never from `cwd`,
  `${CLAUDE_PROJECT_DIR}` or an env var.
- **Ships as three PRs:** (1) these plan corrections, (2) the hook fixes — real
  bugs, independently valuable, and a precondition for printing a hooks block,
  (3) `--dir`/`N8N_DECANTER_DIR` + the `init` note + docs. **Plan 81 closes with
  PR 3.**

## Settled findings (tasks 8 + 9, investigated 2026-08-18)

Verified against **Claude Code 2.1.234** three ways — the official docs, the
installed binary's own resolver code, and live probes — with every load-bearing
claim put through an independent refutation pass. What did *not* survive that
pass is named at the bottom so it is not re-quoted as fact.

**The rule.** Each settings source resolves to exactly **one** path:
`projectSettings = resolve(cwd)`, `userSettings = ~/.claude`,
`localSettings = canonical git root` (+ a legacy cwd read). `.mcp.json` is the
odd one out and **walks up every ancestor of the launch cwd**, merged, nearest
wins. Hooks have no discovery of their own — they ride the `hooks` key of those
same settings files.

**So the asymmetry is inverted from what this plan first assumed:**

| agent launched at | nested `.mcp.json` | nested `.claude/settings.json` | parent root's `settings.json` |
|---|---|---|---|
| **repo root** | inert | inert | loads |
| **sync dir** | **loads** (+ the root's, merged) | **loads** | inert |

- **Task 9 — answered: yes, the same defect class, and stricter.** A nested
  `.claude/settings.json` contributes nothing to a root-launched session —
  permissions, hooks and `env` alike.
- **`--add-dir` does not rescue it.** `permissions.additionalDirectories` grants
  file access; the additional-directory flag tags *agent definition files*, not
  settings sources. **This closes the plan's original open question.**
- **`.claude/settings.local.json` is the one exception** (canonical git root, so
  it *does* apply from a subdirectory). A maintainer who tests the nested case
  with `settings.local.json` gets a false "it works". `init` writes none, so it
  is not a fix path.
- **Starting the agent in the sync dir is a complete, zero-config answer** — and
  the only shape in which the scaffolded permission globs stay correct. Its one
  cost: the parent repo's own root `.claude/settings.json` then does not load
  (its `.mcp.json` still does, via the walk).

**Task 8 — answered: the hook is broken three independent ways.**

1. **Not loaded at all** from a root-launched session (it is declared in the sync
   dir's settings). The failure is **silent** — no process, no stderr, no exit
   code. Rewriting the command path *inside the sync dir's* settings fixes
   nothing; it is a placement defect, not a path defect.
2. **`config.projects?.[process.cwd()]` is keyed wrong — a live bug today,
   independent of this plan.** Claude Code keys the `~/.claude.json` `projects`
   bag by the **canonical git root** (falling back to `normalize(resolve(cwd))`
   when there is no repo), not by cwd. Where sync dir == git root (or there is no
   git) the lookup happens to work; **nested inside a git repo — precisely this
   plan's subject — it silently misses**, so Plan 58's user-scoped "second door"
   is dead exactly where it matters. Corroborated independently on this machine:
   `~/.claude.json`'s `projects` bag holds only git-root keys, with no entry for
   any subdirectory a session actually ran in.
3. **cwd assumptions in the scripts.** `CONFIG_FILES` and the
   `.decanter-proxy.json` discovery file in `mcp-route-check.mjs` are bare
   cwd-relative names; `rename-refs.mjs` reads `decanter.config.json` from cwd,
   falls back to `./workflows`, and **degrades to a silent no-op** (post-rename
   `$('…')` repair just stops). `verify.mjs` is cwd-free in how it *finds* the
   node file (absolute `file_path` + upward walk) but spawns the CLI with no dir
   pin, so from a parent root it exits non-zero and the hook **exits 2 — a
   blocking error after every node-file edit**, complaining about a missing sync
   dir the user never asked about.

**`${CLAUDE_PROJECT_DIR}` is not a fix.** It expands to the agent's project root
— the parent — so it never points into a descendant, and there is no
"directory of the settings file that declared this hook" variable at all.
**The fix for the whole class is self-location:** the hook scripts physically
live at `<syncdir>/.claude/hooks/`, so `path.resolve(import.meta.dirname, "..",
"..")` **is** the sync dir. No cwd, no env var, correct whether the block was
hoisted or not — and it decouples task 8 from the `--dir` work entirely.

**A verbatim permissions hoist is a security regression, not merely a no-op.**
Relative path patterns anchor at the settings root, so at the repo root
`Edit(workflows/**)` and `Edit(shared/**)` match nothing (dead allows, more
prompts) and — the sharp end — **`Read(.env)` / `Edit(.env)` stop protecting
`<syncdir>/.env`**, the credentials file. `Edit(**/.decanter.json)` survives (it
is `**/`-prefixed). This is the strongest argument for leading with "start the
agent in the sync dir".

**Did NOT survive refutation — do not re-quote:** the `Ignoring N
permissions.allow entries` output does *not* demonstrate the settings scope; it
is the untrusted-workspace message and proves something else. The scope
conclusion above rests on the resolver code and the docs instead.

**Left open, deliberately:** whether `bs.projectPathForConfig` (which
short-circuits the `projects[]` key resolution) is ever populated in a normal
local session, and how Cursor/VS Code treat nesting — the template ships no
`.cursor/mcp.json` or `.vscode/mcp.json`, so decanter has no stake in it beyond
the hook's scan.

## Tasks

1. **`--dir <path>` flag** — one entry in the existing value-flag regex
   ([`n8n-decanter.mts:187`](../../n8n-decanter.mts)) plus its `example`
   ternary.
2. **`N8N_DECANTER_DIR`** read from `process.env` before any `loadConfig`.
   Resolve **relative to `process.cwd()`** so a committed root `.mcp.json` can
   carry a repo-relative `"flows"` and survive a clone on another machine
   (an absolute path would not). `loadEnv` never overrides an already-set var,
   so there is no interaction with the sync dir's own `.env`.
3. **Thread the resolved dir through all three load sites** (`:284` picker,
   `:344`, `:504`).
4. **The not-found error** ([`lib/config.mts:109`](../../lib/config.mts)) gains
   a **second branch** for the nested case — today it advises `init`, which is
   simply wrong when the sync dir *is* initialised and merely elsewhere. **Keep
   the existing half-setup branch intact**; it is right for the cold-start case
   it was written for (Plan 75). Distinguishing them cheaply: if a
   `decanter.config.json` exists in a *descendant* of cwd, this is the nested
   case → name `--dir` / `N8N_DECANTER_DIR`.
5. **`init` nested detection** — an ancestor of the target looks like a project
   root (`.git`, or a `package.json` that is not the scaffolded one). Then print,
   in the existing "restart your agent" block
   ([`lib/init.mts:351`](../../lib/init.mts)), the **full** note (maintainer
   decision 2026-08-18 — not the short pointer):
   - **Option A first, as the recommendation:** start the agent *in* the sync
     dir; everything just scaffolded then works unchanged. Name its one cost
     (the parent repo's root `.claude/settings.json` will not load; its
     `.mcp.json` still will).
   - **Option B, the root wiring**, for people who cannot: the paste-ready
     `<repo-root>/.mcp.json` entry (task 6), the opencode equivalent, **and**
     the `<repo-root>/.claude/settings.json` hooks block with every script path
     prefixed by the sync dir.
   - **If permission rules are printed at all, every relative glob needs the
     same prefix — above all `Read(<syncdir>/.env)` / `Edit(<syncdir>/.env)`.**
     A verbatim hoist silently unprotects the credentials file (see "Settled
     findings"); printing it wrong is worse than not printing it.
   - **Do not suggest `${CLAUDE_PROJECT_DIR}`** — it expands to the root here,
     so it looks equivalent and is not.
   - **Standalone stays completely silent** — no new noise on the normal path.
   - **Ordering constraint:** this note may only ship *after* task 8 — printing
     a hooks block while `rename-refs.mjs` is still cwd-bound hands the user a
     silent no-op.
6. **The printed snippet must carry BOTH halves.** An override that only heals
   `loadConfig` leaves the other half broken: `npx --no-install n8n-decanter`
   resolves the bin from the **cwd's** `node_modules/.bin`, which under a local
   install lives in the sync dir — from the root it is not found. So the snippet
   needs `env: {"N8N_DECANTER_DIR": "<syncdir>"}` **and** a root-resolvable
   command: bare `n8n-decanter` when globally installed, otherwise the path into
   the sync dir's `node_modules/.bin` — **repo-relative where possible**
   (`flows/node_modules/.bin/n8n-decanter`), absolute only as a fallback, since
   an absolute path in a committed root config breaks for every teammate. *This
   is why the user's `bash -c "cd … && exec …"` worked: it happened to fix both
   halves at once.*
7. **Template parity — smaller than it looked.**
   [`template/opencode.json.example`](../../template/opencode.json.example)
   carries the same assumption and needs the same note, but
   [`template/.cursor/`](../../template/.cursor) ships only guidance prose
   (`rules/n8n-decanter.mdc.example`) and `template/.vscode/settings.json.example`
   is editor config — **there is no scaffolded `.cursor/mcp.json` or
   `.vscode/mcp.json`**, so nothing there needs changing. `mcp-route-check`
   merely *scans* for those names.
   Note also that the scaffolded `.mcp.json.example` / `opencode.json.example`
   themselves arguably need **no** edit: they are correct for an agent started in
   the sync dir (Option A). The fix is the printed note plus `N8N_DECANTER_DIR`
   support. **Heads-up for the diff:** `ecf0ee9` (Plan 30, merged after this plan
   was written) just rewrote `opencode.json.example`, `CLAUDE.md.example` and
   `AGENTS.md.example` to drop the retired `*.remote.js` deny rule — branch off
   current `main` so it is not resurrected.
8. **Make all three hooks self-locating** (was: "audit the scaffolded hook" —
   the audit is done, see "Settled findings"). Anchor each on
   `path.resolve(import.meta.dirname, "..", "..")` instead of `process.cwd()`:
   `mcp-route-check.mjs`'s `CONFIG_FILES` + `.decanter-proxy.json` reads,
   `rename-refs.mjs`'s `decanter.config.json` + root resolution, and
   `verify.mjs`'s CLI spawn (pin the dir so it cannot exit 2 with a
   sync-dir-not-found error). Node >= 22.18 is already the floor, so
   `import.meta.dirname` is available.
8a. **Fix the `projects[]` key in `mcp-route-check.mjs`** (~line 107) — a **live
   bug, independent of this plan, and worth its own commit**: the bag is keyed by
   canonical git root, not cwd. Try `process.cwd()`, then walk ancestors and
   accept any `projects[]` key that is an ancestor-or-self. Correct under both
   the git-root and the no-git resolution.
8b. **`mcp-route-check.mjs` scans ancestors for `CONFIG_FILES`, bounded at the
   git root** (maintainer decision 2026-08-18). Mirrors Claude Code's own
   `.mcp.json` walk so the hook can see a root-hoisted entry, while the git
   boundary keeps it out of an unrelated parent tree. **Document that this is not
   a reversal of "decanter never consults git"** — that rule is about locating the
   *sync dir*; here git identifies the *agent's project root*, a different
   question (same reasoning as the detection in task 5).
9. **~~Settle whether `.claude/settings.json` has the same root-only defect~~ —
   done, see "Settled findings": yes, and stricter than `.mcp.json`.** What
   remains is documentation: the load-scope table, the `settings.local.json`
   git-root exception, and the `--add-dir` non-rescue (folded into the Docs
   section below). No CLI change follows from it.

## Tests

- **A third shape in [`test/mcpspawn.mts`](../../test/mcpspawn.mts)**: sync dir
  nested, guard spawned **from the parent**, `N8N_DECANTER_DIR` set → assert a
  real `initialize` result. This is the regression that does not exist today —
  both current shapes spawn inside the sync dir.
- Unit: precedence `--dir` > env > cwd.
- Unit: `init` prints the note when nested, stays silent when standalone.
- Unit: the `projects[]` ancestor-or-self lookup (task 8a) — there is a hook
  unit-test precedent in the `rename-refs` shared-corpus test.
- Unit: each hook resolves the sync dir from `import.meta.dirname` (task 8), i.e.
  it still works when spawned with cwd = an unrelated parent.

## Docs (PR acceptance criterion — all surfaces)

- [`docs/cli/mcp-connect.md`](../../docs/cli/mcp-connect.md) — its own section
  "when your sync dir is not your project root", with the snippet.
- [`docs/cli/init.md`](../../docs/cli/init.md) — what the printed note means.
- [`docs/concepts/configuration.md`](../../docs/concepts/configuration.md) —
  `--dir` / `N8N_DECANTER_DIR` and the precedence.
- [`docs/concepts/sync-layout.md`](../../docs/concepts/sync-layout.md) — the
  monorepo promise gains its caveat: it holds for the sync verbs, while the
  agent wiring depends on **where the agent is started**.
- **A load-scope table for the agent wiring** (best home: the agent-facing doc
  page, linked from init/mcp-connect) — the per-launch-dir matrix from "Settled
  findings", plus the two facts people otherwise rediscover the hard way: the
  `.claude/settings.local.json` git-root exception, and that `--add-dir` does
  **not** load a nested settings file.
- Wherever task 8b's ancestor scan is described, state that consulting git there
  is about the **agent's project root**, not about locating the sync dir — so it
  does not read as a reversal of sync-layout.md.
- **Fit the new `mcp connect` prose to the page as it now reads**: #267/#270
  rewrote it to say the guard never *obtains* credentials (that is exclusively
  `init`'s job) — the nested section must not reintroduce the older framing.
- **README + [`docs/cli/overview.md`](../../docs/cli/overview.md) — yes, not
  "only if worth mentioning."** A global option every verb honours is
  user-facing by the root `AGENTS.md` rule, and `npm run check:docs` is
  structural on *verbs*, so nothing mechanical will catch its absence.
- `CHANGELOG.md` `[Unreleased]`: **Added** (`--dir`/`N8N_DECANTER_DIR`, the
  nested note) and **Fixed** (guard unusable from a nested sync dir; misleading
  not-found message).
- `PLAN.md`: record the search precedence and **explicitly drop the unstated
  assumption "sync dir == agent project root"**.

## Non-goals

- Not a change to the upward search itself — it is the documented contract for
  the sync verbs and works.
- `init` writing into a parent repo.
- Bending Claude Code's `.mcp.json` discovery — that is the agent's rule; we
  document it, nothing more.

## Verification

The repro this section originally prescribed ("confirm the agent never loads
it") **cannot be reproduced and must not be re-attempted as written** — the
nested `.mcp.json` loads fine for an agent started in the sync dir. The shape
that actually fails is a **root-launched** agent. So, in a temp repo with root
`/` and sync dir `/flows`:

1. Agent launched at `/flows` → the scaffolded wiring works today, unchanged.
   This is Option A and the baseline the note recommends.
2. Agent launched at `/` → `/flows/.mcp.json` and `/flows/.claude/settings.json`
   contribute nothing (no downward scan). Confirm the silence, not an error.
3. The same MCP entry hoisted to `/.mcp.json` **without** the fix → the guard
   dies on `decanter.config.json not found (searched from / upward)`, and under a
   local install `npx --no-install` cannot even resolve the bin.
4. The printed Option-B snippet → a live guard from `/`.
5. Hooks, spawned with cwd = `/`: before task 8, `rename-refs.mjs` is a silent
   no-op and `verify.mjs` exits 2 on every node-file edit; after, both work.

A `SessionStart` hook that `touch`es a marker file is the cheapest way to observe
(1) vs (2) without burning API calls on a full session.
