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

Warn without blocking: unresolved `.remote.js` leftovers; a Python Code node's
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
