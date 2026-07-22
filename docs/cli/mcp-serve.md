---
title: mcp serve
description: A localhost MCP guard-proxy for agents — full n8n MCP access, minus Code-node writes.
order: 12
---

```sh
n8n-decanter mcp serve [--port N]
```

Starts the **MCP guard-proxy**: a localhost HTTP endpoint that speaks n8n's
MCP protocol and forwards everything to your instance's `/mcp-server/http` —
with decanter as the **sole credential holder** and one rule enforced
technically:

- **Blocked:** `update_workflow` calls whose arguments contain a `jsCode`
  key anywhere. The caller gets an instructive tool error pointing at the
  file + [push](/docs/cli/push/) flow instead — Code-node source lives in
  this repo, not in ad-hoc MCP writes. Operation types are deliberately not
  enumerated (the op surface churns); the `jsCode` key is the contract.
- **Everything else passes through untouched**, including SSE responses:
  reads, structure edits, wiring, publishing, the n8n build/lifecycle tools.

Point your agent's MCP config at the printed URL with the printed
**session secret** as its `Authorization` header — the agent never sees an
n8n credential, and the secret rotates on every `mcp serve` run. The current
endpoint + secret also land in a gitignored `.decanter-proxy.json`, which the
scaffolded `mcp-route-check.mjs` session hook uses to nudge agents whose MCP
config still points at the instance directly.

```json
{
  "mcpServers": {
    "n8n-instance": {
      "type": "http",
      "url": "http://127.0.0.1:5680/mcp-server/http",
      "headers": { "Authorization": "Bearer <printed secret>" }
    }
  }
}
```

Safety properties: binds `127.0.0.1` only; unparseable request bodies are
refused (**fail closed**), oversized bodies are capped; requests without the
session secret never reach n8n. The blast radius of a proxy outage is
availability, not integrity — decanter's own sync (`pull`/`push`/`watch`)
never routes through the proxy.

`--port` picks the listen port (default `5680`; `0` for an ephemeral one —
note your agent config then changes every run). Stop with Ctrl-C.
