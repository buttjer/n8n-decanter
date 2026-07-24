# Plan 58 — the stdio guard should actually be the only route an agent has

**Status:** Draft
**Priority:** P1 for task 1 (silent-fail is a clear bug); P2 for task 2.
**Source:** 2026-07-24 discussion off [Plan 57](57-cli-discoverability-for-agents.md).
Two concrete gaps found by inspecting the guard's discovery + startup path;
Plan 57 is the *discoverability* half (agent finds the CLI), this is the
*route-integrity* half (once found, the guard is the reliable/only route).
**Snapshot:** 2026-07-24T19:47Z @ 9f3a78a
**Model:** Sonnet — both tasks are well-specified mechanical fixes.
**Class:** Distinctive feature — the code-only guard boundary is decanter's, not
n8n's.

## Why

The scaffolded stdio guard (`mcp connect`) only protects agents that (a) find it
and (b) actually spawn it, with no *other* n8n route configured. Two verified
gaps let a cooperative agent bypass the guard silently — not a determined
attacker (that's impossible, see Residual), but the ordinary case the guard is
*meant* to cover.

### Gap 1 — the guard can silently fail to start (PATH)

The scaffolded [`.mcp.json`](../../template/.mcp.json.example) spawns
`{"command":"n8n-decanter","args":["mcp","connect"]}` — a **bare PATH lookup**,
copied verbatim by `init` (no rewrite). It resolves only if the CLI is on the
agent's PATH, i.e. a **global** install. With a **local** devDependency a bare
`n8n-decanter` is not on the agent's PATH, so the MCP server fails to start, the
agent has no `n8n-instance` server, and — if it has any other n8n route — it uses
that one, unguarded. No error a user would notice.

Our own field-test harness proves the fragility: [`stage.mts:311`](../../test/field-test/stage.mts#L311)
has to **manually prepend `node_modules/.bin` to the blind session's PATH** so
the bare command resolves. A real user's agent gets no such help (Claude Code
spawns MCP servers with the ambient PATH).

### Gap 2 — the route-check is blind to user-level MCP config

[`mcp-route-check.mjs`](../../template/.claude/hooks/mcp-route-check.mjs.example#L11)
(SessionStart drift warning) reads only four **relative/project** paths:
`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `opencode.json`. A
**user-scoped** server — Claude Code's `claude mcp add -s user` → `~/.claude.json`,
or Cursor's global `~/.cursor/mcp.json` — is never opened, so an agent that has a
global `n8n` MCP entry *alongside* the guarded project one gets **no warning at
all**. That is exactly the "second door" case the hook exists to catch.

## Tasks

1. **(P1) Make the scaffolded guard command robust to a local install.**
   `init` knows where its own bin resolves — have it write a **resolved**
   `mcp connect` invocation into every scaffolded agent config (`.mcp.json`,
   `.cursor/mcp.json` if/when added, `opencode.json`) instead of the bare
   `n8n-decanter`. Options to weigh: an absolute path to the installed bin, or
   `{"command":"npx","args":["n8n-decanter","mcp","connect"]}` (npx resolves a
   local node_modules install first). Keep the bare form only when a global
   install is detected. Re-init must not clobber a user-edited config (respect
   the template-manifest drift logic in [`lib/template.mts`](../../lib/template.mts)).
   Verify against a **locally-installed** sync dir that the agent's spawned
   server actually starts.

2. **(P2) Teach the route-check to see user-level MCP config.** Extend the hook's
   `CONFIG_FILES` to also read the known user-scoped locations (`~/.claude.json`,
   `~/.cursor/mcp.json`, and any others worth covering), with the same
   `/mcp-server/http`-direct heuristic and loopback allowance. Still a
   SessionStart **warning, not a gate** (exit 0). Because it's harness-agnostic
   material, the substance goes in the tool-agnostic guidance and the per-agent
   hook stays a thin runner (root `AGENTS.md` "Agent tooling").

## Non-goals

- Preventing a determined agent from reaching the instance — impossible; see
  Residual. This plan closes *silent accidents*, not intent.
- Weakening or changing the `jsCode` guard itself.
- The polling/reconcile approach (published-vs-git self-heal) — considered and
  set aside in the same discussion; the maintainer rejected a timer-based check.

## Residual (on the record)

Even with both tasks done, the stdio guard remains **"the only route for agents I
configure, *if nothing else is configured behind my back*."** Task 2 lowers the
odds of an unseen second route; it cannot shut the door — a SessionStart warning
can't enumerate every harness's global config and doesn't block. This residual is
**inherent to guarding a route instead of the instance**: humans in the n8n UI,
raw REST, and an agent holding its own MCP credential never pass through any
stdio guard. The only bypass-proof property available is *detection after the
fact* — that production always runs code that's in git — which a route guard does
not provide and which the rejected reconcile approach would. Documenting that
here so the trade-off is explicit rather than rediscovered.

Verified facts behind this plan are in the session's memory notes
(`published-vs-draft-read-facts`: MCP alone can read draft **and** published
content in one `get_workflow_details` call; publish is not gateable at the
credential level).

## Cross-links

- [Plan 57](57-cli-discoverability-for-agents.md) — discoverability half; a guard
  that silently fails to start (task 1) is itself a discoverability failure.
- [Plan 50](50-code-node-authoring-skill.md) — the skill route (steer the agent
  before it picks a tool); complementary to route-integrity.
