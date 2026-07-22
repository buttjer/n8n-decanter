---
title: rename
description: Rename a workflow in n8n; the folder is a stable local slug and stays put.
order: 12
---

```sh
n8n-decanter rename <workflow> "<new name>"
```

Renames the workflow **in n8n** (over the MCP server), then updates the local
`workflow.json` snapshot and the cached name in `.decanter.json` — no push
needed, the rename is immediate.

The **folder is left untouched** — folder names are a stable local slug (see
[sync layout](/docs/concepts/sync-layout/)), not a mirror of the workflow name,
so a rename never moves your working directory or churns git history. The id
inside `.decanter.json` is authoritative; the cached `name` is what the picker,
[list](/docs/cli/list/), and ref-resolution display.

To rename a **node** (not the workflow), use
[node rename](/docs/cli/node-rename/).
