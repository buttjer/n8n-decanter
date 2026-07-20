---
title: uuid
description: Generate lowercase v4 UUIDs for new node ids.
order: 15
---

```sh
n8n-decanter uuid [count]
```

Prints one (or `count`) lowercase v4 UUIDs — the format n8n uses for node
ids. Use it when adding a node object to `workflow.json` by hand or by
agent; never change an existing node's id. Fully offline.
