---
title: check
description: Offline layout-compliance check plus typecheck — the agent-safe verifier.
order: 6
---

```sh
n8n-decanter check [workflow…] [--no-typecheck]
```

Fully offline (no credentials, no network): runs the **compliance guard**
and the **typecheck** over pulled workflows — the same two gates
[push](/docs/cli/push/) runs, available standalone. Without refs, every
pulled workflow is checked; with refs, the typecheck output is scoped too.
Exits 1 on any error.

> **Green means well-formed, not live.** `check` never contacts the instance, so
> a pass says your files are valid — not that n8n is running them. The success
> line says so:
>
> ```
> ✓ Order Sync: OK (local layout — `status` compares with n8n)
> ```
>
> Use [status](/docs/cli/status/) to compare local against the instance, and
> [push](/docs/cli/push/) to make your edits real. Editing and then stopping at a
> green `check` leaves the workflow unchanged in n8n.

## What the compliance guard catches

- inline code in `workflow.json` without a `//@file:` placeholder
- placeholders pointing at missing, `.remote.js`, or non-`.js`/`.ts` files,
  or at files outside `code/`
- an `@ts-n8n` marker inside a `.js` file
- dangling connection sources/targets
- duplicate node names or ids
- orphan `.js`/`.ts` files nothing references
- dangling literal `$('…')` references, in node source and in expression
  parameters
- a leftover legacy `fixtures/` dir containing `.json` files — the per-node
  `fixtures/` / `simulate --pin` mechanism is retired; recreate the data as a
  [scenario](/docs/cli/scenario/), then delete the dir

Warn without blocking: **local work not yet registered with the instance** — a
node whose `//@file:` placeholder has moved off what `.decanter.json` records
(the shape of a `.js`→`.ts` conversion), or whose recorded file is gone from
disk. `push` reconciles the map, so this is a pending sync, not a violation —
and it stays a warning deliberately, because `push` runs this guard *before* it
reconciles. Also: unresolved `.remote.js` leftovers; a Python Code node's
inline `pythonCode` (decanter extracts JS/TS only — Python extraction is
planned); and a committed scenario whose `workflowData` embeds inline Code-node
source (`jsCode` not starting with `//@file:`).

## Typecheck

n8n Code-node source is a *function body* (top-level `return`/`await`), which
plain `tsc` rejects. `check` wraps node files in an `async function` in
memory and maps diagnostics back to real line numbers — see
[Type checking](/docs/concepts/type-checking/) for how this works and why
your editor may still show a spurious TS1108.

`npm run typecheck` in a scaffolded sync dir is an alias for this.

`check` is the static rung of the ladder [`preflight`](/docs/cli/preflight/)
runs — reach for `preflight` to run this plus the instance reads and a pinned
`test`/`simulate` run as one scored gate.
