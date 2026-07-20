---
title: publish / unpublish
description: Take a draft live, or return a published workflow to draft-only.
order: 12
---

```sh
n8n-decanter [ref...] publish     # take the draft(s) live
n8n-decanter [ref...] unpublish   # return to draft-only
```

n8n 2.x splits each workflow into a **draft** and a **published** version. In
the editor, *Save* updates the draft and *Publish* makes it live. These verbs
do the publish half from the CLI:

- **`publish`** takes the draft live — the code runs from now on.
- **`unpublish`** returns the workflow to draft-only.

Both need credentials (the `workflow:activate` / `workflow:deactivate` scopes;
see [configuration](/docs/concepts/configuration/)). Without refs they act on
the workflows listed in `decanter.config.json`.

## Already in that state

Running `publish` on an already-published workflow (or `unpublish` on an
already-draft one) is a **no-op with a note**, not an error — nothing changes
and the command still exits 0.

## Relationship to push

Pushing to an *already-published* workflow republishes it immediately (n8n's
public API hardcodes this — there is no draft-only update to a live workflow).
So on a published workflow you rarely need `publish` — the push already went
live. `publish` matters for an **unpublished** workflow whose draft you want to
promote.

For a staged rollout, the CLI-native sequence is:

```sh
n8n-decanter wf unpublish   # triggers go down
n8n-decanter wf push        # update the draft only
n8n-decanter wf publish     # bring it back live with the new code
```

See the [push](/docs/cli/push/) page and
[sync layout](/docs/concepts/sync-layout/) for the full publish model.
