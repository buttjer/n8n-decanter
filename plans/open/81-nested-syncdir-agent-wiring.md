# Plan 81 — a nested sync dir's scaffolded agent wiring never loads

**Status:** Not started — direction settled with the maintainer 2026-08-18
**Priority:** P2
**Source:** User field feedback 2026-08-18 ("verschachtelte Sync-Dir: die
scaffoldete MCP-Config greift vermutlich nicht"), same batch as
[Plan 80](../draft/80-mcp-token-handback-wording.md) and #267.
**Snapshot:** 2026-08-18T11:44Z @ 5e6084f
**Model:** Sonnet — the design calls are made; what's left is breadth across CLI,
`init`, templates, tests and docs.

`init` writes `.mcp.json` (and `.claude/settings.json`) **into the sync dir**
with a cwd-less command, which silently assumes the sync dir *is* the agent's
project root. When it is a subfolder of a bigger repo — a shape
[the docs explicitly promise works](../../docs/concepts/sync-layout.md) — the
agent never reads the file, and copying the entry up to the root starts the
guard with `cwd` = repo root, where decanter's **upward** config search cannot
find `decanter.config.json`. The fix is an explicit sync-dir override
(`--dir` / `N8N_DECANTER_DIR`) plus an `init` that *prints* a working root
snippet when it detects the nested case.

## Why — the two halves both check out

**Half 1: the file is in the wrong place.** Claude Code reads project `.mcp.json`
from the project root; a nested copy is simply never loaded. `init` scaffolds it
into the target dir unconditionally ([`lib/init.mts:351`](../../lib/init.mts)
only decides whether to print the "restart your agent" hint) and says nothing
about placement.

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
   ([`lib/init.mts:351`](../../lib/init.mts)): (a) that `.mcp.json` is read at
   the **project root**, so the file just written there is inert; (b) a
   paste-ready root entry; (c) the opencode equivalent. **Standalone stays
   completely silent** — no new noise on the normal path.
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
7. **Template parity** — [`template/opencode.json.example`](../../template/opencode.json.example)
   (`"command": ["npx","--no-install","n8n-decanter","mcp","connect"]`) carries
   the same assumption, and [`template/.cursor/rules`](../../template/.cursor)
   must be checked too. This is **not** Claude-specific.
8. **Audit the scaffolded hook** —
   [`template/.claude/hooks/mcp-route-check.mjs.example`](../../template/.claude/hooks)
   looks up `config.projects?.[process.cwd()]` (line ~107); confirm what that
   resolves to when the agent runs at the root while the hook file sits in a
   nested sync dir, and whether the hook is loaded there at all (task 9's
   question).
9. **Settle whether `.claude/settings.json` has the same root-only defect** —
   permission rules and hooks. Verify against current Claude Code before
   claiming either way; if nested settings *are* honoured, only `.mcp.json`
   needs the fix, and that asymmetry belongs in the docs.

## Tests

- **A third shape in [`test/mcpspawn.mts`](../../test/mcpspawn.mts)**: sync dir
  nested, guard spawned **from the parent**, `N8N_DECANTER_DIR` set → assert a
  real `initialize` result. This is the regression that does not exist today —
  both current shapes spawn inside the sync dir.
- Unit: precedence `--dir` > env > cwd.
- Unit: `init` prints the note when nested, stays silent when standalone.

## Docs (PR acceptance criterion — all surfaces)

- [`docs/cli/mcp-connect.md`](../../docs/cli/mcp-connect.md) — its own section
  "when your sync dir is not your project root", with the snippet.
- [`docs/cli/init.md`](../../docs/cli/init.md) — what the printed note means.
- [`docs/concepts/configuration.md`](../../docs/concepts/configuration.md) —
  `--dir` / `N8N_DECANTER_DIR` and the precedence.
- [`docs/concepts/sync-layout.md`](../../docs/concepts/sync-layout.md) — the
  monorepo promise gains its caveat.
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

Repro first, in a temp repo: root `/`, sync dir `/flows`, scaffolded
`.mcp.json` in `/flows` → confirm the agent never loads it; then the same entry
at the root → confirm the `decanter.config.json not found` failure; then the
fixed snippet → a live guard.
