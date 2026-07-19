---
title: pull
description: Sync workflows from the n8n instance into the local folder layout.
order: 3
---

```sh
n8n-decanter [ref...] pull
```

Pulls each workflow into `workflows/<Name>/`: the full `workflow.json` with
each Code node's `jsCode` replaced by a `//@file:` placeholder, plus one
source file per node under `code/` — see
[Sync layout](/docs/concepts/sync-layout/). Without refs, all workflows from
the config are pulled. `pull` resolves names it doesn't know locally against
the server's workflow list, so you can pull a new workflow by name.

After a successful pull the folder is git-committed automatically
(`"commitOnPull": false` disables it).

## What pull never touches

`.ts` node sources are one-way — pull never modifies them. Remote changes to
a TS-managed node (for example a UI edit) surface as a
`code/<node>.remote.js` file instead: port the changes into the `.ts`
manually, delete the `.remote.js`, then push. See
[TypeScript nodes](/docs/concepts/typescript-nodes/).

## Pull re-baselines the sync state

Pulling records the remote state as the new sync base — **after a warned
pull, the next push overwrites the surfaced remote edits by design**, with
`.remote.js` files and git history as the safety net.

## Renames and migrations

Pull's rename machinery follows workflow and node renames (folders and files
are re-mapped by id) and automatically migrates layouts from older versions
(node files at the folder root move into `code/`).
