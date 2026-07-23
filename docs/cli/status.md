---
title: status
description: Code drift report — what changed locally, remotely, or both; CI-friendly exit codes.
order: 5
---

```sh
n8n-decanter status [workflow…] [--diff]
```

Reports, per workflow, whether local **Code-node** edits are pending a push,
the remote code changed since the last sync, or both (a conflict). It reads
the remote but never writes.

The header line also shows the workflow's **publish state** (n8n 2.x):
`published` or `unpublished`. When a published workflow's draft has moved ahead
of the live version (pushes land on the draft, and UI edits do too), `status`
says so — *live version is older than the draft ("publish" to go live)* — so
you know a [publish](/docs/cli/publish/) is pending.

Structure is mirrored, not guarded: when the workflow's structure changed
remotely, `status` prints an informational *structure snapshot out of date —
pull to refresh* line. That is a hint to refresh `workflow.json`, not drift —
it doesn't affect the exit code.

## Exit codes

`status` exits **1** when a pull is needed or a push would clobber remote
**code** (CONFLICT, remote-only code changes, deleted nodes, not pulled yet);
local-only pending edits and remote structure changes exit **0** — scripts
and CI can gate on it like on `check`.

## `--diff`

Shows the actual line diff under each drifted node, so you see what a push
would overwrite before running it.

`status` compiles each `.ts` node before comparing (bundling its `shared/*.ts`
imports), so editing a shared file marks every importing node as push-pending —
you see which nodes a helper change will touch.
