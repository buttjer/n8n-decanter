---
title: Sync layout & data model
description: The folder-per-workflow layout — placeholders, code/, the structure snapshot, .decanter.json.
order: 1
---

Each synced workflow is one folder under the configured root:

```
workflows/
  order-sync/            # kebab-case slug of the workflow name (a stable local pick)
    workflow.json        # read-only structure snapshot; code replaced by placeholders
    .decanter.json       # sync state — commit it, never edit it
    code/
      parse-order.js     # one file per Code node, kebab-case-named
      amazon-feed.ts
    scenarios/
      happy-path.json    # committed pin-data set (see below)
```

The split of responsibilities (since the MCP-native sync): **Code-node source
lives here, in git, as the files decanter syncs. Workflow structure lives in
n8n** — you change it in the editor or over n8n's MCP tools (reached through
decanter's guarded proxy), and decanter mirrors it into the read-only snapshot
on every pull.

## Folder names

A **new** workflow's folder is the **kebab-case slug** of its name
(`"Order Sync"` → `order-sync/`). If that slug is already taken by a different
workflow, it falls back to `<slug>-<id8>` (the same collision suffix node files
use) and warns.

Folders are a **stable local pick**: an existing folder is *never* renamed, no
matter who renames the workflow (the n8n UI or an agent over MCP). The
always-current display name lives in `.decanter.json` (`name`) instead, so the
picker, [list](/docs/cli/list/), and ref-resolution stay accurate while your
working directory and git history never churn. Any folder name still resolves as
a ref, so a hand-rename works too. (Folders synced before this change keep their
original names and keep working.)

## `workflow.json` — the read-only structure snapshot

The workflow's structure, pretty-printed with a stable key order — except each
Code node's `jsCode`, whose entire value is a placeholder pointing at the
node's source file:

```json
"parameters": {
  "mode": "runOnceForAllItems",
  "jsCode": "//@file:code/parse-order.js"
}
```

`workflow.json` never contains code, and **nothing pushes it**: pull refreshes
it (reading the workflow *tip* — the draft when one exists), review diffs and
the offline tooling ([check](/docs/cli/check/),
[node run](/docs/cli/node-run/), [simulate](/docs/cli/simulate/)) read it, and
local edits to it change nothing in n8n. When the structure changed remotely,
[status](/docs/cli/status/) prints a snapshot-stale hint and `pull` refreshes
the file.

The one meaningful local edit: **re-pointing a `//@file:` placeholder** (for a
`.js` ↔ `.ts` conversion) — the placeholders are the human-visible file map,
and push honors a re-point.

Viewer-relative and derived fields are stripped on pull (`shared`, `scopes`,
`canExecute`, the published-version copy `activeVersion`, and the
published-version pointer `activeVersionId` — state that churns on each
publish, with no local reader; the version-aware [status](/docs/cli/status/)
reads `activeVersionId` off the live workflow). The draft `versionId` is kept,
since the [executions](/docs/cli/executions/) stale-capture warning compares
against it.

## `code/`

Node sources, named in kebab-case after their node (`Parse Order` →
`code/parse-order.js`). `.js` files are lossless (byte-identical round-trip);
`.ts` files are one-way — see
[TypeScript nodes](/docs/concepts/typescript-nodes/). Layouts from older
versions (files at the folder root) migrate automatically on the next pull.

## `scenarios/`

Committed, full-workflow **pin-data sets** — `scenarios/<slug>.json`, each a
self-contained, execution-shaped file captured from a real run or scaffolded
from the workflow's schemas. `test`/`simulate` replay one with `--scenario
<slug>` and diff each node against it. Unlike the gitignored `executions/`
sibling (temporary capture data), **`scenarios/` is tracked in git**, so a
scenario-based replay is reproducible for teammates and CI. See
[scenario](/docs/cli/scenario/) for how they're created, filled, and validated.

## `.decanter.json`

Per-folder machine state: the node-id → file map (with per-node cached names),
the per-node sync hashes used by the
[drift guard](/docs/concepts/push-gates/), and the cached workflow **`name`**
(the display name, refreshed on every pull — it's why a kebab folder still reads
as the workflow, and why `list`/the picker keep working even if `workflow.json`
is missing or corrupt). Node **ids** are the identity anchor — they survive
renames made anywhere (the n8n UI, or any agent over MCP), so a rename just
moves the local file on the next pull. Commit it; never edit it by hand or
"fix" a hash.

## `.decanter-auth.json` (sync-dir root)

Not per-workflow — the MCP OAuth credentials [init](/docs/cli/init/) minted
(client id + refresh token, rotated automatically). Gitignored, machine-owned;
delete it and re-run `init` to re-consent.

## `.decanter-template.json` (sync-dir root)

Not per-workflow — one file at the sync-dir root recording the hash of every
template file as [init](/docs/cli/init/) copied it. It's the baseline that
makes re-running `init` modification-aware (refresh untouched files, leave your
edits, report drift). Commit it; never edit it by hand.

## Auto-commits

After every successful push **and** pull, the workflow's folder is
git-committed automatically (scoped to that folder; outside a git repo it
just warns). `"commitOnPush": false` / `"commitOnPull": false` in the
[config](/docs/concepts/configuration/) turn it off.
