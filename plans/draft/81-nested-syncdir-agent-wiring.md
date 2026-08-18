# Plan 81 — a nested sync dir's scaffolded agent wiring never loads

**Status:** Draft
**Priority:** P2
**Source:** User field feedback 2026-08-18 ("verschachtelte Sync-Dir: die
scaffoldete MCP-Config greift vermutlich nicht"), same batch as
[Plan 80](80-mcp-token-handback-wording.md) and #267.
**Snapshot:** 2026-08-18T11:36Z @ 5e6084f

`init` writes `.mcp.json` (and `.claude/settings.json`) **into the sync dir**
with a cwd-less command, which silently assumes the sync dir *is* the agent's
project root. When it is a subfolder of a bigger repo — a shape
[the docs explicitly promise works](../../docs/concepts/sync-layout.md) — the
agent never reads the file, and copying the entry up to the root starts the
guard with `cwd` = repo root, where decanter's **upward** config search cannot
find `decanter.config.json`. The user had to hand-write
`bash -c "cd <syncdir> && exec n8n-decanter mcp connect"`.

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

## Direction

**Decided (maintainer, 2026-08-18): an explicit `--dir` plus a `DECANTER_DIR`
env var — and NOT a setting in the sync dir's `.env`.**

1. **`--dir <path>` — the primary fix.** Resolved *before* `loadConfig`, so the
   root-hoisted entry becomes
   `{"command":"npx","args":["--no-install","n8n-decanter","mcp","connect","--dir","flows"]}`.
   Beats the `cwd` JSON key (not every agent config supports one) and beats
   `bash -c "cd … && exec …"` (no shell, works on Windows). Open: `mcp connect`
   only, or a **global option every verb honours**? Global is the better shape —
   `loadConfig(process.cwd())` has exactly three call sites
   ([`n8n-decanter.mts:284,344,504`](../../n8n-decanter.mts)), so one pre-parse
   in `main()` covers the CLI; the narrow version is only cheaper to defend.
2. **`DECANTER_DIR` — the env-injection path**, read from `process.env` before
   `loadConfig` for harnesses that configure by environment rather than argv
   (the sandbox shape in [Plan 70](70-sandboxed-agent-credentials.md); an MCP
   config's `env` block is the same lever). Naming fits the one decanter var
   that already exists, `DECANTER_NO_BROWSER`.
   **Precedence: `--dir` > `DECANTER_DIR` > upward search from cwd** (unchanged
   default — nothing existing moves).
3. **Rejected: a root-dir key in the sync dir's `.env`.** It cannot work, and
   the reason is structural, not cosmetic: `loadEnv(dir)` runs **only after**
   the upward search has already located the sync dir
   ([`lib/config.mts:80`](../../lib/config.mts)). A `.env` inside the sync dir
   therefore cannot tell decanter where the sync dir is — in the broken case
   that file is never read at all. **Circular.** Any dir hint has to arrive from
   outside the sync dir: argv or the process environment. (A root-level `.env`
   would mean a second, upward-searched env file — a new lookup surface for one
   bug, when `--dir` already solves it.) Worth recording in `PLAN.md`: this is
   the standing answer to "why not just configure it in `.env`?"
4. **Detect the nested case in `init`** and print the root-pinned snippet
   instead of pretending the scaffolded file is live. Detection needs a
   definition of "the agent's project root" — nearest ancestor holding `.git`
   or `.claude/` is the obvious heuristic, and decanter has so far deliberately
   never consulted git to locate anything (sync-layout.md above), so this is a
   real design call, not a detail. Cheapest honest version: when the target dir
   has an ancestor that looks like a project root, say so and print the exact
   JSON — now with `--dir` filled in — to paste there.
5. **Check `.claude/settings.json` for the same defect** — the permission rules
   and hooks `init` scaffolds are subject to the same root-loading question as
   `.mcp.json`. Verify against current Claude Code before claiming either way;
   if nested settings *are* honoured, only `.mcp.json` needs the fix and that is
   worth stating in the docs.
6. **Docs** — [`docs/cli/mcp-connect.md`](../../docs/cli/mcp-connect.md) (its
   setup section, freshly reworked in #267),
   [`docs/cli/init.md`](../../docs/cli/init.md), the
   [configuration page](../../docs/concepts/configuration.md) for `--dir` /
   `DECANTER_DIR`, and the sync-layout paragraph that currently promises the
   monorepo shape without caveat. `--dir` on every verb is a user-facing flag →
   README + `/docs` + CHANGELOG, and `npm run check:docs` covers the structural
   half.

## Non-goals

- Not a change to the upward search itself — it is the documented contract for
  the sync verbs and works.
- Not auto-editing a file outside the target dir: `init` should *print* the root
  snippet, not silently write into the user's repo root. (Same boundary as
  [Plan 80](80-mcp-token-handback-wording.md): setup stays the user's.)

## Verification

- Repro first, in a temp repo: root `/`, sync dir `/flows`, scaffolded
  `.mcp.json` in `/flows` → confirm the agent never loads it; then the same
  entry at the root → confirm the `decanter.config.json not found` failure.
- Once `--dir` exists, [`test/mcpspawn.mts`](../../test/mcpspawn.mts) is the
  natural home for a nested-dir spawn case (it already proves the scaffolded
  command actually starts, local + global install shapes).
