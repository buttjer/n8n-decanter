---
title: mcp connect
description: The stdio MCP guard your agent spawns — full n8n MCP access, minus Code-node writes, no secret.
order: 11
---

```sh
n8n-decanter mcp connect
```

The **stdio MCP guard** — the default way a coding agent reaches your n8n
instance's MCP server. You never run it by hand: the scaffolded `.mcp.json`
(and `opencode.json`) from [init](/docs/cli/init/) already contains

```json
{
  "mcpServers": {
    "n8n-instance": { "command": "n8n-decanter", "args": ["mcp", "connect"] }
  }
}
```

and the agent spawns it per session. It speaks MCP over stdio to the agent and
forwards each call to your instance's `/mcp-server/http` with **decanter's own
credentials** (from `.env` / `.decanter-auth.json`) — the agent never holds an
n8n credential, and because stdio pipes are private to the two processes,
**no session secret exists at all**.

The guard is the same one [mcp serve](/docs/cli/mcp-serve/) enforces over HTTP:

- **Blocked:** `update_workflow` calls that write Code-node source
  (`jsCode`) — the caller gets an instructive tool error pointing at the file
  \+ [push](/docs/cli/push/) flow.
- **Everything else forwards untouched**: reads, structure edits (`addNode`,
  `renameNode`, wiring), publishing, archiving — the whole n8n MCP surface,
  SSE responses included.

That combination is what powers the guarded authoring loop: an agent builds
and wires structure over MCP (adding Code nodes **without** `jsCode` — the
guard blocks code), then `pull` lands each new Code node as an empty file in
`code/`, and the first `push` seeds its source from the repo.

**Live mirror.** When the guard forwards a structure edit (a non-blocked
`update_workflow`), it schedules a debounced background `pull` of that
workflow, so the read-only `workflow.json` snapshot (+ code files + state)
refreshes itself — the clean git diff of structure changes keeps pace with the
agent, with no manual `pull`. It's fire-and-forget (never blocks the agent's
next call), git-gated (a dirty tree is safety-committed before the pull; with
no git it's skipped), and tracked-only (a brand-new, untracked workflow is left
for an explicit `pull`). On by default; set `"liveMirror": false` in
`decanter.config.json` to turn it off (CI / deterministic setups).

Failure posture matches the HTTP guard: unparseable input is refused
(**fail closed**), and an unreachable instance answers the agent with a
JSON-RPC error naming the host instead of hanging. Logs go to stderr; stdout
carries only protocol messages. The process ends when the agent closes the
session.

Prefer `mcp connect` wherever the agent's MCP config can spawn a command.
For harnesses that only accept an MCP **URL**, use
[mcp serve](/docs/cli/mcp-serve/) — the same guard as a localhost HTTP proxy
with a per-session secret.
