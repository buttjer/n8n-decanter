---
title: The offline feedback loop
description: check, run, and uuid give agents a credential-free verify loop.
order: 2
---

Three verbs are fully offline — no credentials, no network, no live n8n —
which makes them safe for agents to run without supervision:

- **[`check`](/docs/cli/check/)** — the layout-compliance guard plus the
  typecheck (the same wrapper that maps top-level-`return` node bodies back
  to real line numbers). Run after editing any code file; treat a failure as
  a blocker.
- **[`run`](/docs/cli/run/)** — executes a node's body against a faked n8n
  context and prints the items it returns. With a fixture, `$input`,
  `$('Node Name')`, env, and static data are all controllable — real
  execution feedback without touching the instance.
- **[`uuid`](/docs/cli/uuid/)** — node ids in n8n's format, for adding node
  objects to `workflow.json`.

A typical agent iteration:

```sh
# after editing code/parse-order.ts and workflow.json
n8n-decanter run workflows/Order\ Sync/code/parse-order.ts fixture.json
n8n-decanter check
# both green -> report "ready to push" to the user
```

Adding a Code node from scratch: generate an id with `uuid`, add the node
object with a `//@file:` placeholder, create the source file in `code/`,
verify with `run` + `check` — the
[sync layout](/docs/concepts/sync-layout/) page shows the shapes.

Because verification routes through the CLI, `n8n-decanter` must be on the
sync dir's PATH — see [Installation](/docs/getting-started/installation/).
