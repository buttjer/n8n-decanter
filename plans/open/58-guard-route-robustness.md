# Plan 58 — the stdio guard should not silently fail to be the route the user configured

**Status:** In progress (Tasks 1 + 3 done; Tasks 2 + 4 open)
**Priority:** P1 for tasks 1 + 3 (both done — the silent-fail and the missing
spawn coverage that let it through) and task 4 (same gap on the Bash surface);
P2 for task 2.
**Source:** 2026-07-24 discussion off [Plan 57](../draft/57-cli-discoverability-for-agents.md).
Two concrete gaps found by inspecting the guard's discovery + startup path;
Plan 57 is the *discoverability* half (agent finds the CLI), this is the
*route-integrity* half (once found, the guard is the reliable/only route).
**Snapshot:** 2026-07-26T12:22Z @ b6d61f0
**Model:** Sonnet — both tasks are well-specified mechanical fixes.
**Class:** Distinctive feature — the code-only guard boundary is decanter's, not
n8n's.

## Why

The scaffolded stdio guard (`mcp connect`) only protects agents that (a) find it
and (b) actually spawn it, with no *other* n8n route configured. Two verified
gaps let a cooperative agent bypass the guard silently — not a determined
attacker (that's impossible, see Residual), but the ordinary case the guard is
*meant* to cover.

### Gap 1 — the guard could silently fail to start (PATH) — FIXED

The scaffolded [`.mcp.json`](../../template/.mcp.json.example) spawned
`{"command":"n8n-decanter","args":["mcp","connect"]}` — a **bare PATH lookup**,
copied verbatim by `init`. It resolved only if the CLI was on the agent's PATH,
i.e. a **global** install. With a **local** devDependency a bare `n8n-decanter`
is not on the agent's PATH, so the MCP server failed to start, the agent had no
`n8n-instance` server, and — if it had any other n8n route — used that one,
unguarded. No error a user would notice.

Our own field-test harness proved the fragility: [`run.mts`](../../test/field-test/run.mts)
had to **manually prepend `node_modules/.bin` to the blind session's PATH** so
the bare command resolved (host mode; container mode symlinks the baked bin into
`/work/node_modules/.bin` for the same reason). A real user's agent gets no such
help (Claude Code spawns MCP servers with the ambient PATH).

### Gap 2 — the route-check is blind to user-level MCP config

[`mcp-route-check.mjs`](../../template/.claude/hooks/mcp-route-check.mjs.example#L11)
(SessionStart drift warning) reads only four **relative/project** paths:
`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `opencode.json`. A
**user-scoped** server — Claude Code's `claude mcp add -s user` → `~/.claude.json`,
or Cursor's global `~/.cursor/mcp.json` — is never opened, so an agent that has a
global `n8n` MCP entry *alongside* the guarded project one gets **no warning at
all**. That is exactly the "second door" case the hook exists to catch.

## Tasks

1. **(P1) Make the scaffolded guard command robust to a local install. — DONE**
   The scaffolded configs now spawn
   `{"command":"npx","args":["--no-install","n8n-decanter","mcp","connect"]}`
   (`.mcp.json` + `opencode.json`) instead of the bare `n8n-decanter`.

   **Chosen approach — a static `npx --no-install` prefix, not per-machine
   detection.** The draft floated "have `init` detect the install and keep the
   bare form when global." A static prefix dominates that:
   - `npx` resolves the **local** `node_modules/.bin` from the project cwd (the
     broken case) **and** a global install — verified against a real global
     install: `npx --no-install n8n-decanter --version` returned `0.7.0` in
     ~0.5s with no download.
   - It is **portable in a committed file** — detection would bake the
     initializer's install *type* into a shared `.mcp.json`, wrong for a
     teammate with the other type.
   - `--no-install` never downloads from npm, so a genuinely missing install
     **fails loudly** instead of silently pulling a possibly-mismatched version.
   - It is *more* robust even for global installs: it depends on `npx` (always
     on a node agent's PATH) rather than the global bin dir happening to be on
     the agent's spawn PATH — and `npx` lives in the same node bin dir a global
     install would, so there is no case where bare would resolve and `npx`
     would not.

   Surfaces updated in lockstep: `template/.mcp.json.example`,
   `template/opencode.json.example`, the `mcp-route-check` guidance string,
   [`docs/cli/mcp-connect.md`](../../docs/cli/mcp-connect.md), the
   `lib/mcpconnect.mts` header, `PLAN.md`, `CHANGELOG.md` (Fixed), and the
   field-test rewrite in `run.mts` (now rebuilds the argv from whatever
   `command` is, instead of keying on `command === "n8n-decanter"`). Verified by
   the full smoke suite against real n8n.

   *Follow-up: the same local-install PATH gap affects the agent's allowlisted
   Bash `n8n-decanter …` calls — now Task 4 below.*

2. **(P2) Teach the route-check to see user-level MCP config.** Extend the hook's
   `CONFIG_FILES` to also read the known user-scoped locations (`~/.claude.json`,
   `~/.cursor/mcp.json`, and any others worth covering), with the same
   `/mcp-server/http`-direct heuristic and loopback allowance. Still a
   SessionStart **warning, not a gate** (exit 0). Because it's harness-agnostic
   material, the substance goes in the tool-agnostic guidance and the per-agent
   hook stays a thin runner (root `AGENTS.md` "Agent tooling").

3. **(P1) Prove the scaffolded command actually starts a guard — under BOTH
   install shapes. — DONE** (`test/mcpspawn.mts`, wired into `npm test`).
   Task 1's bug survived because **nothing tested process spawning**, only guard
   *behavior*:
   - [`test/guardproxy.mts`](../../test/guardproxy.mts) imports `runStdioGuard`
     **in-process** on PassThrough pipes — the scaffolded `command`/`args` are
     never executed.
   - No test asserts the content of the `.mcp.json` `init` writes (the only
     occurrence is a fixture *string* in the docs-surface unit test).
   - The field test stages **both** shapes — host mode installs **locally**
     (`npm install <tgz>` into the workDir), container mode installs
     **globally** (`npm install -g`) — but **masks both**: `run.mts` prepends
     the workDir's `node_modules/.bin` to the blind session's PATH
     ([run.mts:396](../../test/field-test/run.mts#L396)) and the container
     symlinks the global bin into `/work/node_modules/.bin`
     ([run.mts:81](../../test/field-test/run.mts#L81)). **The one thing a real
     user's agent never gets is exactly the thing the harness supplies**, which
     is why every round measured a world where the guard always started.

   **What shipped:** `test/mcpspawn.mts` reads the **scaffolded** entry (from the
   template `init` materializes, so it tracks whatever we ship rather than a
   hard-coded argv), spawns **exactly that `command` + `args`** as a child
   process against a localhost mock MCP upstream, writes an `initialize` on
   stdin, and asserts a JSON-RPC reply on stdout. Four steps:
   - a **static guard** — the scaffolded command must not be a bare program name
     again;
   - **LOCAL install** — a shim in the project's `node_modules/.bin`, spawned on
     a PATH containing only `node`/`npx` + the system dirs. The shim drops a
     sentinel, so the assertion proves the *local* copy ran and a machine-global
     install cannot satisfy the step;
   - **GLOBAL install** — no local install in scope, resolution from the ambient
     PATH;
   - **NEITHER** — must fail **loudly** (a guard that never starts is the bug),
     never silently.

   **Verified to actually catch the bug**: reverting the template to the bare
   `n8n-decanter` fails the static guard, and — run in isolation — the LOCAL step
   fails with `spawn n8n-decanter ENOENT`, i.e. it reproduces the real-world
   silent-fail rather than merely asserting a string.

   *Environment caveat (why "both" is honest, not absolute):* npm/npx re-adds its
   own node bin dir to PATH, so a *fake* global install cannot reliably win over
   a real one. Each of the GLOBAL / NEITHER steps therefore skips, with a printed
   reason, on the machine shape that cannot express it — a machine with a global
   install exercises GLOBAL and skips NEITHER; CI without one does the reverse.
   **LOCAL — the actual regression — always runs.**

   The paired field-test PATH crutch is resolved on
   [Plan 35](../open/35-blind-agent-field-test.md): the guard no longer needs the
   prepend (npx resolves it), the prepend stays for the agent's *Bash* surface
   but is now named as a global-install simulation, `FIELD_NO_PATH_HELP=1` drops
   it, and every run prints its `PATH policy`.

4. **(P1) The agent's *Bash* surface has the same gap — fix the invocation form,
   NOT the install shape.** Task 1 fixed the guard's spawn; the scaffolded
   allowlist ([`template/.claude/settings.json.example`](../../template/.claude/settings.json.example))
   and the agent contract still name the CLI as a **bare** `n8n-decanter <verb>`,
   which is the one form a local install does not provide.

   **Measured** (real `npm pack` + `npm i -D`, PATH with no global decanter):

   | invocation | result |
   | --- | --- |
   | bare `n8n-decanter check` | **fails — ENOENT** |
   | `npx n8n-decanter check` | works |
   | `npm run check` | works (npm puts `node_modules/.bin` on PATH) |
   | `./node_modules/.bin/n8n-decanter check` | works |

   So a devDependency install is **not** broken — 3 of 4 forms work; only the
   bare one fails. **"Install globally" is explicitly NOT the fix**: a per-sync-dir
   devDependency is a documented, supported install
   ([installation.md](../../docs/getting-started/installation.md)), and requiring
   a global one would regress our own docs and force machine-global state on
   users who deliberately avoid it.

   The fix mirrors Task 1: **`npx n8n-decanter <verb>` is the universal form** —
   it resolves a local *and* a global install (verified: global resolves in
   ~0.5 s with `--no-install`, no download). Work to do: allow **both** forms in
   the scaffolded allowlist (bare stays valid and is nicer under a global
   install), and make the agent contract's examples resolve under either. Check
   how the permission matcher treats the `npx` prefix before choosing wording —
   a prefix that doesn't match its rule would gate every call behind a prompt.

## Non-goals

- Preventing a determined agent from reaching the instance — impossible; see
  Residual. This plan closes *silent accidents*, not intent.
- Weakening or changing the `jsCode` guard itself.
- **A polling / reconcile ("published-vs-git self-heal") layer — rejected, not
  parked.** The guard-route model is the chosen design; a timer-based reconciler
  that reverts out-of-band code is **out of scope for decanter**, full stop. It
  is named here only to record that it was considered and decided against, so it
  is not re-proposed as a "cheap fallback."

## Residual (on the record)

Even with both tasks done, the stdio guard remains **"the only route for agents I
configure, *if nothing else is configured behind my back*."** Task 2 lowers the
odds of an unseen second route; it cannot shut the door — a SessionStart warning
can't enumerate every harness's global config and doesn't block. This residual is
**inherent to guarding a route instead of the instance**: humans in the n8n UI,
raw REST, and an agent holding its own MCP credential never pass through any
stdio guard. **That is an accepted limit of the route-guard design** — decanter
guards the route it scaffolds and makes that route reliable (Task 1) and
discoverable (Task 2 + Plan 57); it does not police the instance.

## Cross-links

- [Plan 57](../draft/57-cli-discoverability-for-agents.md) — discoverability
  half; a guard that silently fails to start (task 1) is itself a discoverability
  failure.
- [Plan 50](../draft/50-code-node-authoring-skill.md) — the skill route (steer
  the agent before it picks a tool); complementary to route-integrity.
