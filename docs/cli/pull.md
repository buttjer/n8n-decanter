---
title: pull
description: Sync Code-node source (and the structure snapshot) from the n8n instance.
order: 3
---

```sh
n8n-decanter pull [workflow…]
```

Pulls each workflow into `workflows/<folder>/` over n8n's MCP server: one
source file per Code node under `code/`, plus the read-only `workflow.json`
structure snapshot with each Code node's `jsCode` replaced by a `//@file:`
placeholder — see [Sync layout](/docs/concepts/sync-layout/). Without refs,
all workflows from the config are pulled. `pull` resolves names it doesn't
know locally against the server's workflow list, so you can pull a new
workflow by name.

Pull reads the workflow **tip** — what the n8n editor shows: the unpublished
draft when one exists, else the published content.

A workflow must have **"Available in MCP"** enabled (workflow card ⋯ menu, or
workflow settings) before it can be pulled; the error tells you where the
switch lives, and [`list --remote`](/docs/cli/list/) marks gated workflows.

After a successful pull the folder is git-committed automatically
(`"commitOnPull": false` disables it).

## What pull never touches

`.ts` node sources are one-way — pull never modifies them. Remote changes to
a TS-managed node (for example a UI edit) are **warned about**, not merged:
inspect them with `status --diff` and port what you want to keep into the
`.ts` by hand. See [TypeScript nodes](/docs/concepts/typescript-nodes/).

## Pull re-baselines the sync state

Pulling records the remote code as the new sync base — **after a warned
pull, the next push overwrites the surfaced remote edits by design**, with
`status --diff` and git history as the safety net. `.js` files are
overwritten with the remote body (pull warns when that clobbers unpushed
local edits — recover via git).

## Renames and migrations

Node **ids are stable across renames** (wherever the rename happened — UI,
MCP, or `node rename`), and the id-keyed state maps each node to its file:
pull follows renames by moving the local file to the new kebab-case name.
Layouts from older versions (node files at the folder root) migrate
automatically on the next pull.
