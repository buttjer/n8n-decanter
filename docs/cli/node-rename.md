---
title: node rename
description: Rename a node everywhere it is referenced, atomically and offline.
order: 19
---

```sh
n8n-decanter node rename <workflow> "<old node>" "<new node>"
```

Renaming a node by hand means touching four places at once: the node's
`name`, every reference in `connections`, every `$('…')` reference in code,
and the source file name with its `//@file:` placeholder. `node rename`
rewrites all of them atomically, refuses colliding names, and re-validates the
folder afterwards.

It works **offline**; the next [push](/docs/cli/push/) propagates the rename
to n8n.

- The source file is renamed to the new kebab-case name (with its `.remote.js`
  sibling); a collision with an existing file falls back to the `-<id8>`
  suffix, the same as [pull](/docs/cli/pull/) and
  [node create](/docs/cli/node-create/).
- Unknown, colliding, and same-name renames are refused before anything is
  written.

To rename the **workflow** itself, use [rename](/docs/cli/rename/).
