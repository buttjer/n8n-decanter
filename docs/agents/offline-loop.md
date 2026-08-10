---
title: The offline feedback loop
description: preflight --offline and node run give agents a credential-free verify loop.
order: 2
---

Several verbs are fully offline — no credentials, no network, no live n8n —
which makes them safe for agents to run without supervision:

- **[`preflight --offline`](/docs/cli/preflight/)** — the static tier on its
  own: the layout-compliance guard (`layout`) plus the typecheck (`types`, the
  same wrapper that maps top-level-`return` node bodies back to real line
  numbers). `--offline` drops the instance tier, so nothing is read from n8n.
  Run it after editing any code file; treat a `not ready` verdict as a
  blocker. Every violation is listed in the failing check's indented
  `details` — the one-line message is only the summary.
- **[`node run`](/docs/cli/node-run/)** — executes a node's body against a faked n8n
  context and prints the items it returns. With a fixture, `$input`,
  `$('Node Name')`, env, and static data are all controllable — real
  execution feedback without touching the instance.

Adding `--simulate` (`preflight --offline --simulate`) keeps the loop
credential-free and still never contacts n8n, but it boots a throwaway local
engine to really *run* the workflow — Docker, and minutes rather than
milliseconds. An occasional deeper pass, not the per-edit one.

A typical agent iteration:

```sh
# after editing code/parse-order.ts and workflow.json
n8n-decanter node run workflows/order-sync/code/parse-order.ts fixture.json
n8n-decanter preflight --offline
# both green -> push: the draft is where the work lands, and code that only
# exists in this folder is not done
n8n-decanter push order-sync
# now the draft holds your code -> grade it on the instance. This step leaves
# the offline loop: `test` grades the DRAFT on n8n, so it only means anything
# once you have pushed (before a push it would grade the old code). Bare, it is
# a static check and executes nothing; add --scenario/--execution for a real run.
n8n-decanter test order-sync
# going LIVE (`publish` / `push --publish`) stays the user's call
```

Adding a Code node from scratch is a structure act — it happens **in n8n**
(the editor, or an `addNode` MCP op through the
[guard](/docs/cli/mcp-connect/) with **no** `jsCode`), then
[`pull`](/docs/cli/pull/) lands it as an empty `code/` file with its
placeholder and state entry (the node lands disconnected; wire it in n8n).
Write the code in the file, verify with `node run` + `preflight --offline`,
and the first push seeds the node's source. The
[sync layout](/docs/concepts/sync-layout/) page shows the shapes.

Because verification routes through the CLI, `n8n-decanter` must be on the
[sync dir](/docs/concepts/sync-layout/#the-sync-dir)'s PATH — see [Installation](/docs/getting-started/installation/).

## Exit codes: one gate, one view

`preflight` is the **gate** — exit `1` when the verdict is `not ready` (any
check failed), `0` otherwise; `--fail-on=warn` makes a `caution` fail too.
That is the exit code to branch on, offline or online.

[`diff`](/docs/cli/diff/) is the **view** — the per-node line diff between
your files and the n8n draft — and it **always exits `0`**, like `git diff`.
Never read a clean `diff` exit as a passing check. (It is also not offline: it
reads the draft from the instance.)
