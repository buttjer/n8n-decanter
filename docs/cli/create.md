---
title: create
description: Create a blank workflow in n8n, then pull it into the layout.
order: 9
---

```sh
n8n-decanter create "<name>"
```

Creates a new, empty workflow in n8n (over the MCP server) and immediately
pulls it, so its folder and `.decanter.json` land locally and the new id is
printed. MCP-created workflows are born **available in MCP**, so the pull
just works. The workflow is born **unpublished** (a draft) — edit its
`code/`, `push`, then [publish](/docs/cli/publish/) to take it live. That
makes `create` → edit → `push` → `publish` a complete loop without opening
the n8n UI.

The server assigns the id and owns the workflow's birth — there is no id-less
repo folder that becomes a workflow on push. `create` just triggers the birth
from the CLI; the same as creating a blank workflow in the UI and pulling it,
one step shorter.

Duplicate names are allowed (n8n does not require unique workflow names); the
new folder is named after the workflow, with pull's usual collision handling.
