---
title: node rename
description: Rename a node in n8n; references and local files follow automatically.
order: 19
---

```sh
n8n-decanter node rename <workflow> "<old node>" "<new node>"
```

Forwards the rename to n8n (an MCP `renameNode` operation) — n8n rewrites the
`connections` and every `$('…')` expression reference **server-side**, and the
node's id stays stable — then rewrites `$('…')` references in local `.ts`
sources (the one thing pull can't refresh) and pulls the result: the source
file moves to the new kebab-case name and the snapshot follows.

- A file-name collision falls back to the `-<id8>` suffix, the same as
  [pull](/docs/cli/pull/) and [node create](/docs/cli/node-create/).
- Unknown, colliding, and same-name renames are refused before anything is
  sent.
- Renames made **outside** decanter (the n8n editor, another agent via MCP)
  are picked up by the next pull the same way — node ids anchor the file
  mapping.

To rename the **workflow** itself, use [rename](/docs/cli/rename/).
