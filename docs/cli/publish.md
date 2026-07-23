---
title: publish / unpublish
description: Take a draft live, or return a published workflow to draft-only.
order: 8
---

```sh
n8n-decanter publish [workflow…]     # take the draft(s) live
n8n-decanter unpublish [workflow…]   # return to draft-only
```

n8n 2.x splits each workflow into a **draft** and a **published** version. In
the editor, *Save* updates the draft and *Publish* makes it live. Every
decanter [push](/docs/cli/push/) updates the **draft only** — these verbs are
the deliberate go-live half:

- **`publish`** takes the draft live — the code runs from now on. On a
  published workflow whose draft has diverged (pushes, or UI edits), it
  promotes the newer draft.
- **`unpublish`** returns the workflow to draft-only.

Both go over n8n's MCP server. Without refs they act on the workflows listed
in `decanter.config.json`. `push --publish` combines a push with the publish
in one command.

## Already in that state

Running `publish` when the live version already equals the draft (or
`unpublish` on an already-draft workflow) is a **no-op with a note**, not an
error — nothing changes and the command still exits 0.

## The standard loop

```sh
n8n-decanter push wf        # update the draft (live version untouched)
# …iterate, test, repeat…
n8n-decanter publish wf     # ship it — or use push --publish for the last one
```

Because pushes never auto-publish, there is no need to `unpublish` first for
a staged rollout — the draft accumulates changes while the published version
keeps running.
