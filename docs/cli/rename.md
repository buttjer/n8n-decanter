---
title: rename
description: Rename a workflow (offline); the folder is a stable local slug and stays put.
order: 12
---

```sh
n8n-decanter rename <workflow> "<new name>"
```

Changes the workflow's display name in `workflow.json` and caches it in
`.decanter.json` (`name`). It works **offline**; the next
[push](/docs/cli/push/) propagates the rename to n8n.

The **folder is left untouched** — folder names are a stable local slug (see
[sync layout](/docs/concepts/sync-layout/)), not a mirror of the workflow name,
so a rename never moves your working directory or churns git history. The id
inside `.decanter.json` is authoritative; the cached `name` is what the picker,
[list](/docs/cli/list/), and ref-resolution display.

To rename a **node** (not the workflow), use
[node rename](/docs/cli/node-rename/).
