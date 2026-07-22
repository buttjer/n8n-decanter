---
title: The offline feedback loop
description: check, node run, and node create give agents a credential-free verify loop.
order: 2
---

Several verbs are fully offline — no credentials, no network, no live n8n —
which makes them safe for agents to run without supervision:

- **[`check`](/docs/cli/check/)** — the layout-compliance guard plus the
  typecheck (the same wrapper that maps top-level-`return` node bodies back
  to real line numbers). Run after editing any code file; treat a failure as
  a blocker.
- **[`node run`](/docs/cli/node-run/)** — executes a node's body against a faked n8n
  context and prints the items it returns. With a fixture, `$input`,
  `$('Node Name')`, env, and static data are all controllable — real
  execution feedback without touching the instance.
- **[`node create`](/docs/cli/node-create/)** — scaffolds a Code node (node object, `//@file:`
  placeholder, `code/` source, state entry) in one guard-checked step, so
  there is no hand-editing of `workflow.json` to get a node id right.

A typical agent iteration:

```sh
# after editing code/parse-order.ts and workflow.json
n8n-decanter node run workflows/order-sync/code/parse-order.ts fixture.json
n8n-decanter check
# both green -> report "ready to push" to the user
# (the runtime checks — instance-side `test`, offline `simulate` — come after
#  a push / with the user's go-ahead; see the taxonomy in docs/cli/test)
```

Adding a Code node from scratch: run
[`node create <workflow> "<Node name>" [--ts]`](/docs/cli/node-create/) — it mints
the node id, writes the `code/` source, adds the placeholder, and re-checks the
folder in one step (the node lands disconnected; wire it in the editor). Then
edit the source and verify with `node run` + `check`. The
[sync layout](/docs/concepts/sync-layout/) page shows the shapes.

Because verification routes through the CLI, `n8n-decanter` must be on the
sync dir's PATH — see [Installation](/docs/getting-started/installation/).
