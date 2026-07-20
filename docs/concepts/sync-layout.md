---
title: Sync layout & data model
description: The folder-per-workflow layout — placeholders, code/, .decanter.json, .remote.js.
order: 1
---

Each synced workflow is one folder under the configured root:

```
workflows/
  Order Sync/
    workflow.json        # full workflow; code replaced by placeholders
    .decanter.json       # sync state — commit it, never edit it
    code/
      parse-order.js     # one file per Code node, kebab-case-named
      amazon-feed.ts
```

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
([rename](/docs/cli/rename/) handles all the places atomically).

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

Per-folder machine state: the node-id → file map plus the sync hashes used by
the [drift guard](/docs/concepts/push-gates/). Commit it; never edit it by
hand or "fix" a hash.

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
