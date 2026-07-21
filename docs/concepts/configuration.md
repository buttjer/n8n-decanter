---
title: Configuration
description: decanter.config.json keys and credential resolution.
order: 5
---

`decanter.config.json` is searched upward from the current directory;
credentials come from `.env` next to it or from the environment.

```json
{
  "root": "./workflows",
  "workflows": ["0cXNQKKzmO0pXiCq"],
  "commitOnPush": true,
  "commitOnPull": true,
  "requestTimeoutMs": 30000,
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
| `requestTimeoutMs` | `30000` | n8n API request timeout — raise for slow instances. |
| `browserReload` | off | `"proxy"` enables the [live-reload proxy](/docs/concepts/watch-live-reload/) during watch. |
| `proxyPort` | `5679` | Port for that proxy. |
| `bundleDependencies` | `[]` | npm packages `.ts` nodes may import; [bundled on push](/docs/concepts/typescript-nodes/). Pure-JS only. |

## Credentials

- `.env` next to the config: `N8N_HOST`, `N8N_API_KEY` — written by
  [init](/docs/cli/init/), never committed (the scaffolded `.gitignore`
  covers it).
- Or the same variables from the process environment.

Use a **minimal-scope API key** (n8n 2.x keys carry scopes) rather than a
full-access one, so a leaked `.env` has a smaller blast radius. The scopes the
CLI actually uses:

- `workflow:read`, `workflow:list`, `workflow:update` — pull, push, status, watch
- `workflow:create`, `workflow:delete` — [create](/docs/cli/create/), [delete](/docs/cli/delete/)
- `workflow:activate`, `workflow:deactivate` — [publish / unpublish](/docs/cli/publish/)
- `execution:read`, `execution:list` — the [executions](/docs/cli/executions/) verb

`check`, `node run`, `rename`, `node create`, and plain `list` need no credentials at all.
