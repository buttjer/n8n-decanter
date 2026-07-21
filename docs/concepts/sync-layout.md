---
title: Sync layout & data model
description: The folder-per-workflow layout — placeholders, code/, .decanter.json, .remote.js.
order: 1
---

Each synced workflow is one folder under the configured root:

```
workflows/
  order-sync/            # kebab-case slug of the workflow name (a stable local pick)
    workflow.json        # full workflow; code replaced by placeholders
    .decanter.json       # sync state — commit it, never edit it
    code/
      parse-order.js     # one file per Code node, kebab-case-named
      amazon-feed.ts
```

## Folder names

A **new** workflow's folder is the **kebab-case slug** of its name
(`"Order Sync"` → `order-sync/`). If that slug is already taken by a different
workflow, it falls back to `<slug>-<id8>` (the same collision suffix node files
use) and warns.

Folders are a **stable local pick**: an existing folder is *never* renamed — not
when the workflow is renamed remotely, not by [rename](/docs/cli/rename/). The
always-current display name lives in `.decanter.json` (`name`) instead, so the
picker, [list](/docs/cli/list/), and ref-resolution stay accurate while your
working directory and git history never churn. Any folder name still resolves as
a ref, so a hand-rename works too. (Folders synced before this change keep their
original names and keep working.)

## `workflow.json`

The full workflow, pretty-printed — except each Code node's `jsCode`, whose
entire value is a placeholder pointing at the node's source file:

```json
"parameters": {
  "mode": "runOnceForAllItems",
  "jsCode": "//@file:code/parse-order.js"
}
```

`workflow.json` never contains code; edit the referenced file instead.
Structure, parameters, and connections are editable — connections are keyed
by **node name**, which is why renames need care
([node rename](/docs/cli/node-rename/) handles all the places atomically).

Only structure round-trips through push — `name`, `nodes`, `connections`,
`settings`, `staticData`. Pull also brings down `active`, `tags`, `pinData`,
and timestamps, but push never sends them back and they don't count as drift,
so editing them here has no effect (activation, tags, and pinned data are
managed in the n8n UI). `shared`, the published-version copy `activeVersion`,
and the published-version pointer `activeVersionId` are stripped on pull
entirely — derived state that churns on each publish, with no local reader
(the version-aware [status](/docs/cli/status/) reads `activeVersionId` off the
live GET). The draft `versionId` is kept, since the
[executions](/docs/cli/executions/) stale-fixture warning compares against it.

## `code/`

Node sources, named in kebab-case after their node (`Parse Order` →
`code/parse-order.js`). `.js` files are lossless (byte-identical round-trip);
`.ts` files are one-way — see
[TypeScript nodes](/docs/concepts/typescript-nodes/). Layouts from older
versions (files at the folder root) migrate automatically on the next pull.

## `.decanter.json`

Per-folder machine state: the node-id → file map, the sync hashes used by the
[drift guard](/docs/concepts/push-gates/), and the cached workflow **`name`**
(the display name, refreshed on every pull — it's why a kebab folder still reads
as the workflow, and why `list`/the picker keep working even if `workflow.json`
is missing or corrupt). Commit it; never edit it by hand or "fix" a hash.

## `.decanter-template.json` (sync-dir root)

Not per-workflow — one file at the sync-dir root recording the hash of every
template file as [init](/docs/cli/init/) copied it. It's the baseline that
makes re-running `init` modification-aware (refresh untouched files, leave your
edits, report drift). Commit it; never edit it by hand.

## `code/<node>.remote.js`

An incoming-change artifact written by [pull](/docs/cli/pull/) when the
remote code changed in ways it can't merge (a UI edit of a TS-managed node, a
conflict, a missing local `.ts`). Treat it like an incoming diff: port the
changes, delete the file, then push — it's also removed by the next in-sync
pull. Never edit or push while one exists unresolved.

## Auto-commits

After every successful push **and** pull, the workflow's folder is
git-committed automatically (scoped to that folder; outside a git repo it
just warns). `"commitOnPush": false` / `"commitOnPull": false` in the
[config](/docs/concepts/configuration/) turn it off.
