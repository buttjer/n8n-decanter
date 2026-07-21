---
title: status
description: Drift report — what changed locally, remotely, or both; CI-friendly exit codes.
order: 5
---

```sh
n8n-decanter status [workflow…] [--diff]
```

Reports, per workflow, whether local edits are pending a push, the remote
changed since the last sync, or both (a conflict). It reads the remote but
never writes.

The header line also shows the workflow's **publish state** (n8n 2.x):
`published` or `unpublished`. When a published workflow's draft has moved ahead
of the live version (a UI edit that wasn't published), `status` says so — *live
version is older than the draft (push or "publish" to go live)* — so you can
[push](/docs/cli/push/) or [publish](/docs/cli/publish/) to catch it up.

## Exit codes

`status` exits **1** when a pull is needed or a push would clobber remote
work (CONFLICT, remote-only changes, not pulled yet); local-only pending
edits exit **0** — scripts and CI can gate on it like on `check`.

## `--diff`

Shows the actual line diff under each drifted node, so you see what a push
would overwrite before running it.

`status` compiles each `.ts` node before comparing (bundling its `shared/*.ts`
imports), so editing a shared file marks every importing node as push-pending —
you see which nodes a helper change will touch.
