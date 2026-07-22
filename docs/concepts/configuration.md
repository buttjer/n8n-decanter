---
title: Configuration
description: decanter.config.json keys and credential resolution.
order: 5
---

`decanter.config.json` is searched upward from the current directory;
credentials come from `.env` / `.decanter-auth.json` next to it or from the
environment.

```json
{
  "root": "./workflows",
  "workflows": ["0cXNQKKzmO0pXiCq"],
  "commitOnPush": true,
  "commitOnPull": true,
  "requestTimeoutMs": 30000,
  "dataTables": true,
  "browserReload": "proxy",
  "proxyPort": 5679,
  "bundleDependencies": ["zod"]
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | — | Directory holding the workflow folders. |
| `workflows` | `[]` | Workflow ids processed when a command gets no refs. |
| `commitOnPush` | `true` | Auto-commit the workflow folder after a successful push. |
| `commitOnPull` | `true` | Same for pull. |
| `requestTimeoutMs` | `30000` | Request timeout (MCP and API) — raise for slow instances. |
| `dataTables` | `true` | Whether the read-only [data-tables](/docs/cli/data-tables/) fetch is available. `false` refuses it (and the API key needn't carry the data-table read scopes); `data-tables clean` still works. |
| `browserReload` | off | `"proxy"` enables the [live-reload proxy](/docs/concepts/watch-live-reload/) during watch. |
| `proxyPort` | `5679` | Port for that proxy. |
| `bundleDependencies` | `[]` | npm packages `.ts` nodes may import; [bundled on push](/docs/concepts/typescript-nodes/). Pure-JS only. |

## Credentials

The sync rides n8n's **MCP server**; the public API key is an optional extra.
In order of resolution:

1. **`N8N_HOST`** — always required for online verbs (`.env` or environment).
2. **MCP credentials** (the sync verbs — pull, push, watch, status, publish,
   unpublish, create, rename, node create/rename):
   - `N8N_MCP_TOKEN` (`.env` or environment) — a rotatable token from n8n →
     Settings → MCP → API key. Takes precedence when set.
   - Otherwise `.decanter-auth.json` — the OAuth client id + refresh token
     [init](/docs/cli/init/) minted via browser consent. The refresh token
     rotates on every use; the file is rewritten automatically. Delete it and
     re-run `init` to re-consent (also the fix for a
     "MCP session expired" error).
3. **`N8N_API_KEY` (optional)** — only for the verbs MCP cannot serve:
   [executions](/docs/cli/executions/) and
   [data-tables](/docs/cli/data-tables/). Scope it minimally:
   `execution:read`, `execution:list`, `workflow:read`, and the `dataTable:*`
   read scopes (only while `dataTables` is on).

The instance needs **MCP access enabled** once (n8n → Settings → MCP;
requires an n8n with the built-in MCP server, ~2.20+), and each synced
workflow needs its **"Available in MCP"** flag (workflow card ⋯ menu, or
workflow settings) — [list --remote](/docs/cli/list/) and the picker show
which workflows still need it.

`check`, `node run`, `mock`, and plain `list` need no credentials at all.
