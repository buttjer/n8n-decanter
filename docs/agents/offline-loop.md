---
title: The offline feedback loop
description: check and node run give agents a credential-free verify loop.
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
A typical agent iteration:

```sh
# after editing code/parse-order.ts and workflow.json
n8n-decanter node run workflows/order-sync/code/parse-order.ts fixture.json
n8n-decanter check
# both green -> report "ready to push" to the user
# (the runtime checks — instance-side `test`, offline `simulate` — come after
#  a push / with the user's go-ahead; see the taxonomy in docs/cli/test)
```

Adding a Code node from scratch is a structure act — it happens **in n8n**
(the editor, or an `addNode` MCP op through the
[guard](/docs/cli/mcp-connect/) with **no** `jsCode`), then
[`pull`](/docs/cli/pull/) lands it as an empty `code/` file with its
placeholder and state entry (the node lands disconnected; wire it in n8n).
Write the code in the file, verify with `node run` + `check`, and the first
push seeds the node's source. The
[sync layout](/docs/concepts/sync-layout/) page shows the shapes.

Because verification routes through the CLI, `n8n-decanter` must be on the
sync dir's PATH — see [Installation](/docs/getting-started/installation/).
