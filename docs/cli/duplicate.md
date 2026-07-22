---
title: duplicate
description: Clone a workflow into a new remote one via the public API.
order: 10
---

```sh
n8n-decanter duplicate <workflow> ["<new name>"]
```

Clones an already-pulled workflow into a **brand-new workflow on the server**.
Use it to fork a workflow for a variant, or to restore a git-tracked workflow
that was deleted remotely.

The clone's body is assembled from the **local** folder — placeholders
reconstituted from `code/`, `.ts` nodes compiled — so it carries the repo's
current content, including edits not yet pushed to the source. It is created
through the **public API** (`POST /workflows`): MCP's only creation path is
Workflow-SDK code, which cannot losslessly replay an arbitrary workflow
graph. That means `duplicate` needs `N8N_API_KEY` (scope `workflow:create`).

Because API-born workflows are **not** "Available in MCP" yet, the follow-up
pull is gated: `duplicate` tells you to flip the switch on the copy (workflow
card ⋯ menu, or workflow settings) and pull it afterwards. The new workflow
is born **unpublished**; [publish](/docs/cli/publish/) takes it live.

Without a name the copy is `"<name> (copy)"`, matching the n8n UI. The source
folder and the source remote workflow are left untouched.
