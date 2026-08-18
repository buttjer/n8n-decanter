# Plan 80 — Nested sync dir: make the scaffolded agent MCP config actually work

**Status:** Not started
**Priority:** P1
**Source:** User field report 2026-08-18 (a sync dir living as a subfolder of a
larger repo; the user had to hand-rewrite the command to
`bash -c "cd <syncdir> && exec n8n-decanter mcp connect"`). Related:
[Plan 58](../done/58-guard-route-robustness.md) (the `npx --no-install` prefix and
the spawn suite), [Plan 57](../done/57-cli-discoverability-for-agents.md).
**Snapshot:** 2026-08-18T11:28Z @ 4dd1433
**Theme:** The scaffolded `.mcp.json` / `opencode.json` silently assume the sync
dir *is* the agent's project root; when it isn't, the guard is either never read
or starts with a cwd from which it can find neither its config nor its own bin.

Give the CLI an explicit sync-dir override (`--dir` / `N8N_DECANTER_DIR`) so the
guard no longer depends on cwd, and teach `init` to notice the nested case and
print a root-ready, dir-pinned MCP snippet instead of leaving a config that will
never load. Today both failure modes are silent-ish and land on the user as
"MCP server failed".

## Why

`init` copies a **static** `template/.mcp.json.example` (and
`template/opencode.json.example`) into the sync dir:

```json
"n8n-instance": { "command": "npx", "args": ["--no-install", "n8n-decanter", "mcp", "connect"] }
```

No `cwd`, nothing resolved at write time. That works only when the sync dir is
also the agent's project root. When it is a subfolder of a bigger repo, two
independent things break:

1. **The file is never read.** Claude Code reads `.mcp.json` from the project
   root only, so the scaffolded file in the subfolder is inert. The user's own
   `init` output gave no hint of this.
2. **Copying the entry to the root breaks differently.** The server then starts
   with `cwd` = repo root, where:
   - `loadConfig()` ([`lib/config.mts:58`](../../lib/config.mts)) does a pure
     **upward** search for `decanter.config.json` from `process.cwd()` — there is
     no flag and no env override — so it throws **before** the `initialize`
     handshake is answered. The agent sees only a dead server.
   - the thrown message is actively misleading here: it says *"this is not a
     decanter sync dir yet"* and recommends running `init`, although the sync dir
     is perfectly initialized and only the cwd is wrong.
   - **`npx --no-install n8n-decanter` also fails to resolve** under a local
     install, because the `node_modules/.bin` that carries the bin lives in the
     sync dir, not the root. The user's `bash -c "cd … && exec …"` workaround
     happens to fix this half too — an override that only fixes the config lookup
     would not.

Reproduced 2026-08-18 (sync dir as a subfolder, `mcp connect` started from the
parent): exit 1, `decanter.config.json not found (searched from …/repro upward)`.

Nothing covers this today: [`test/mcpspawn.mts`](../../test/mcpspawn.mts) spawns
both install shapes but always **inside** the sync dir, and neither
[`docs/cli/mcp-connect.md`](../../docs/cli/mcp-connect.md) nor
[`docs/cli/init.md`](../../docs/cli/init.md) states the sync-dir-is-project-root
assumption. `PLAN.md` does not record it either.

## Design decision — `init` prints, it does not write outside its target

When the nested case is detected, `init` **prints** the root-ready snippet and
lets the user paste it. It does **not** write or merge a `.mcp.json` in the
parent repo: touching files outside the target dir is a surprise `init` should
not spring, the root file often already carries other servers, and the parent
may not even be the agent's project root. (To be re-raised only if field use
shows the paste step is the thing people get wrong.)

## Tasks

1. **Sync-dir override in the CLI.** Resolve the config search root from, in
   precedence order, a `--dir <path>` flag, `N8N_DECANTER_DIR`, then `cwd`.
   - `--dir` joins the existing value-flag list in
     [`n8n-decanter.mts`](../../n8n-decanter.mts) (the `valueFlags` regex ~L187).
   - Feed the resolved dir into the single central `loadConfig(process.cwd(), …)`
     call (~L504) plus the two early ones (picker ~L284, ~L344), so **every**
     verb honours it, not just `mcp connect`.
   - The env var matters as much as the flag: every agent's MCP config has an
     `env` block, whereas a `cwd` field is not portable across agents/versions —
     do not build the fix on `cwd` support.
2. **Fix the misleading not-found error** in `lib/config.mts`: name the cwd case
   and the override alongside the existing (correct, for its own case) `init`
   advice, so a wrongly-started guard says what is actually wrong.
3. **Nested detection + snippet in `init`** ([`lib/init.mts`](../../lib/init.mts),
   near the existing restart-your-agent notice ~L351). When an ancestor of the
   target dir looks like the real project root (`.git`, or a `package.json` that
   isn't the one we just scaffolded), print:
   - that Claude Code reads `.mcp.json` from the **project root** only, so the
     file just written into the sync dir will not be read there;
   - a paste-ready entry pinned with `env: {"N8N_DECANTER_DIR": "<abs syncdir>"}`
     **and** a command that resolves from the root — bare `n8n-decanter` for a
     global install, else the absolute path into the sync dir's
     `node_modules/.bin`. Both halves, or the entry still fails (see Why #2).
   - the equivalent opencode entry, since that config has the same assumption.
4. **Tests.**
   - `test/mcpspawn.mts`: a third shape — sync dir nested in a parent, guard
     spawned **from the parent** with `N8N_DECANTER_DIR` set; assert a real
     `initialize` result. This is the regression that does not exist today.
   - Unit test for the flag/env/cwd precedence in the config resolution.
   - Unit test that `init` emits the snippet for a nested target and stays silent
     for a standalone one.
5. **Docs, all three surfaces** (per root `AGENTS.md`):
   - `docs/cli/mcp-connect.md` — a "sync dir is not your project root" section
     with the snippet; `docs/cli/init.md` — what the nested notice means;
     `docs/cli/overview.md` + README if `--dir` warrants a mention as a global
     flag.
   - `CHANGELOG.md` `[Unreleased]`: Added (`--dir`/`N8N_DECANTER_DIR`, the nested
     `init` notice), Fixed (guard unusable from a nested sync dir; misleading
     not-found message).
   - `PLAN.md`: record the config-search precedence and drop the unstated
     "sync dir == agent project root" assumption.
6. **Template parity.** Whatever the notice teaches must hold for
   `template/opencode.json.example` and the `.cursor` rules too — the assumption
   is not Claude-specific.

## Acceptance / verification

- From a parent dir of a nested sync dir, `n8n-decanter mcp connect` with
  `N8N_DECANTER_DIR` (or `--dir`) completes the `initialize` handshake; without
  either, the error names the cwd cause.
- `npm test` green, including the new nested spawn shape.
- `npm run check:docs` green; the three doc surfaces and `PLAN.md` updated.
- A standalone `init` prints no new noise (the nested notice must not nag the
  common case).

## Notes

- The `npx --no-install` resolution half is the easy one to forget: an override
  that only fixes `loadConfig` still leaves a local-install user with an
  unresolvable command from the root. Task 3's snippet must carry both.
- Out of scope: making `init` write into a parent repo (see Design decision), and
  any change to how Claude Code discovers `.mcp.json` — that is the agent's rule,
  not ours to work around beyond documenting it.
