---
title: duplicate
description: Clone a workflow into a new remote one, then pull the copy.
order: 11
---

```sh
n8n-decanter <ref> duplicate ["<new name>"]
```

Clones an already-pulled workflow into a **brand-new workflow on the server**,
then pulls the copy so its folder and `.decanter.json` land locally and the new
id is printed. Use it to fork a workflow for a variant, or to restore a
git-tracked workflow that was deleted remotely.

The clone's body is assembled from the **local** folder exactly as
[push](/docs/cli/push/) does — placeholders reconstituted from `code/`, `.ts`
nodes compiled — so it carries the repo's current content, including edits not
yet pushed to the source. The new workflow is born **unpublished** (a draft);
[publish](/docs/cli/publish/) takes it live.

Without a name the copy is `"<name> (copy)"`, matching the n8n UI. The source
folder and the source remote workflow are left untouched.

Like [create](/docs/cli/create/), the copy is born on the server and
materialized through a pull — there is no id-less repo folder that becomes a
workflow. Needs credentials and the `workflow:create` scope (see
[configuration](/docs/concepts/configuration/)).
