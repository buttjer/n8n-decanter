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

## The go-live gate

`publish` refuses a draft carrying a dangling `$('…')` reference — one that
names a node the workflow doesn't have. That reference fails at run time, so
publishing it would put a known break into production.

The check runs against **the draft on the instance**, not your local folder.
That is deliberate: `workflow.json` is a snapshot, so grading it here would pass
a broken workflow whenever the local mirror is out of date, and block a
legitimate publish from a fresh clone. It costs nothing extra — `publish`
already reads the draft to decide what to do.

It is the same check [`test`](/docs/cli/test/) runs bare, and the message names
both halves and the order to repair them in. Running it in both places is not
redundant: the instance can change between the two, so only the check inside
`publish` is authoritative for that publish.

The usual cause is a rename — n8n's `renameNode` MCP op rewrites the node name
and the connections only, and leaves every reference behind. See
[`pull`](/docs/cli/pull/#renames-and-migrations).

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
