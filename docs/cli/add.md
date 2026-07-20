---
title: add
description: Scaffold a disconnected Code node into a workflow, atomically and offline.
order: 8
---

```sh
n8n-decanter <ref> add "<Node name>" [--ts]
```

Adding a Code node by hand means several edits at once: mint a node id,
hand-write the node object in `workflow.json`, add a `//@file:` placeholder,
create the source file under `code/`, and keep `.decanter.json` in step.
`add` does all of it in one atomic, guard-checked step, then re-validates the
folder — the same collapse of a fiddly multi-file edit that
[rename](/docs/cli/rename/) does.

It works **offline**; the next [push](/docs/cli/push/) sends the new node to
n8n.

- The node lands with default parameters (`mode: runOnceForAllItems`) and a
  starter body you edit before pushing.
- The source file is named kebab-case under `code/` (`"Parse Order"` →
  `code/parse-order.js`); a name that collides with an existing file gets the
  `-<id8>` suffix, the same as pull and rename.
- `--ts` scaffolds a TypeScript source (`code/<name>.ts`) instead of `.js`.
- **No connections are wired** — the node lands disconnected. Wire it in the
  n8n editor (or by hand in `workflow.json`); `add` is Code-node scaffolding,
  not graphical authoring.

Duplicate node names are refused. The workflow must already be pulled (`add`
edits an existing folder).
