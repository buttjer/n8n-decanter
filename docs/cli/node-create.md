---
title: node create
description: Scaffold a disconnected Code node — born in n8n, landed locally by pull.
order: 18
---

```sh
n8n-decanter node create <workflow> "<Node name>" [--ts]
```

Creates a new Code node **in n8n** (an MCP `addNode` with a runnable starter
body) and pulls the workflow, so everything lands in one step: the `code/`
source file, the `//@file:` placeholder in the snapshot, and the
`.decanter.json` entry — keyed by the node id the server minted.

- The node lands with default parameters (`mode: runOnceForAllItems`) and a
  starter body you edit locally, then [push](/docs/cli/push/).
- The source file is named kebab-case under `code/` (`"Parse Order"` →
  `code/parse-order.js`); a name that collides with an existing file gets the
  `-<id8>` suffix, the same as pull and rename.
- `--ts` converts the landed file to a TypeScript source
  (`code/<name>.ts`) — the `@ts-n8n` marker appears on the first push.
- **No connections are wired** — the node lands disconnected. Wire it in the
  n8n editor (wiring is structure); `node create` is Code-node scaffolding,
  not graphical authoring.

Duplicate node names are refused. The workflow must already be pulled
(`node create` needs the local folder to land the file in).
