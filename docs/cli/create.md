---
title: create
description: Create a blank workflow on the server, then pull it into the layout.
order: 10
---

```sh
n8n-decanter create "<name>"
```

Creates a new, empty workflow on the n8n server and immediately pulls it, so
its folder and `.decanter.json` land locally and the new id is printed. The
workflow is born **unpublished** (a draft) — edit its `code/`, `push`, then
[publish](/docs/cli/publish/) to take it live. That makes
`create` → edit → `push` → `publish` a complete loop without opening the n8n
UI.

The server assigns the id and owns the workflow's birth — there is no id-less
repo folder that becomes a workflow on push. `create` just triggers the birth
from the CLI; the same as creating a blank workflow in the UI and pulling it,
one step shorter.

Duplicate names are allowed (n8n does not require unique workflow names); the
new folder is named after the workflow, with pull's usual collision handling.

Needs credentials and the `workflow:create` scope (see
[configuration](/docs/concepts/configuration/)).
