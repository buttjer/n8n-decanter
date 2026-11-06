---
title: node run
description: Execute a Code node offline against an emulated n8n context, with optional fixtures.
order: 20
---

```sh
n8n-decanter node run <node-file> [fixture.json] [--allow-env] [--unsafe]
```

Executes a node's body against an **emulated** n8n context (`$input`, `$json`,
`$('Node')`, `$jmespath`, `DateTime`, `$getWorkflowStaticData`, …) and prints the
items it returns. Fully offline — no credentials, no network. Prefer this over
hand-rolling a throwaway test script.

By default the body runs **sandboxed**: it cannot reach the host — no
`process`, no `fetch`, no `import()` of anything — so a node (or a bundled
dependency) that reads the host environment or a host global gets a clear
error instead of silently touching your machine. Pass `--unsafe` to run it
in-process with full host access, as before: decanter prints a
`running with full host access — no sandbox (--unsafe)` notice on stderr.

`run` is the **fast, offline approximation** rung of the verification ladder — it
is *not* a faithful n8n runtime. Where a global's value genuinely lives on the
instance, `run` says so and points you at [`test`](/docs/cli/test/) (which runs
the real n8n draft over MCP) instead of guessing. See
[the boundary](#whats-emulated-vs-unsupported) below.

The run mode (`runOnceForAllItems` / `runOnceForEachItem`) is read from the
node's entry in `workflow.json`, so each-item nodes are looped once per input
item.

## The sandbox: what is blocked, what still runs

The default (no `--unsafe`) runs the body in a separate worker process with a
**scrubbed global scope** — every global not on the allowlist is deleted before
the body runs, and dynamic `import()` is refused for the duration of the run.
The self-check refuses to start the body at all if the scrub left anything
behind, so a Node release that made a global undeletable fails loudly rather
than silently widening the boundary.

**Blocked by default:** `process`, `fetch` and the rest of the fetch family
(`Request`, `Response`, `Headers`, `FormData`), `WebSocket`, `EventSource`,
`BroadcastChannel`, `MessageChannel`/`MessagePort`, `navigator`,
`localStorage`, `sessionStorage`, `Worker` — and every `import()`, including
one that re-imports a module the CLI itself already loaded. A blocked name
fails with the sandbox message — e.g.

```sh
✗ `process` is not available in sandboxed `node run` — pass `--unsafe` to allow host access.
```

**The built-ins are frozen.** Before the body runs, the sandbox freezes the
built-in constructors, their prototypes and the namespace objects
(`JSON`, `Math`, `Reflect`, `Intl`, …), plus the instance-only prototypes the
sandbox reaches at startup — modelled on n8n's task runner, which freezes its
built-ins too, though n8n runs the code in a separate `vm` realm, so the two
are not identical. Patching a built-in is refused: `Object.defineProperty`
on a prototype, `Array.prototype.x = 1`, `Error.prepareStackTrace = f` each throw
a `TypeError`, or have no effect in non-strict code. Node also creates a
prototype per internal error code and some internal iterators; not all of
those can be enumerated, so a few stay patchable — no way to reach the host
through them is known. Assigning `name`, `message`, `toString`, `valueOf` or
`toLocaleString` **on your own objects and errors** still works. `constructor`
assigns only on a plain object (`{}`) — on your own error instances, arrays,
Maps and the like it is a silent no-op in sloppy code and a `TypeError` under
`"use strict"`. `--unsafe` assigns `constructor` everywhere too, since it
freezes nothing.

**Still available:** the ECMAScript built-ins, plus `Buffer`,
`setTimeout`/`setInterval`/`setImmediate` (and their `clear*`), `btoa`/`atob`,
`TextEncoder`/`TextDecoder` (and their stream variants), `URL`/`URLSearchParams`,
`structuredClone`, `crypto`, `AbortController`/`AbortSignal`, `Event`/`EventTarget`,
`DOMException`, `queueMicrotask` and `performance`. A few of these (`URL`,
`structuredClone`, `crypto`, `AbortController`, `performance`) are wider than
n8n's own Code-node scope, which lacks them — so code that runs sandboxed is
not guaranteed to run in n8n. The `console` is decanter's own: `log`/`info`/
`debug` go to stdout, `warn`/`error` to stderr, and the rest (`table`, `dir`,
`time`, …) are no-ops.

**CommonJS names** (`require`, `module`, `exports`, `__dirname`, `__filename`)
are undefined in **both** modes — the CLI is ESM — and get their own message
pointing at `import`, with no `--unsafe` hint:

```sh
✗ `require` is not available in `node run` — node files are ES modules: use a top-level `import` (npm packages need `bundleDependencies` in decanter.config.json).
```

**Escalation.** A bundled npm dependency that reads `process` (or another
blocked global) at load time fails sandboxed but runs with `--unsafe`. If the
node itself needs the host, `--unsafe` is the answer — and if you need the
node to run *faithfully*,
[`preflight --simulate`](/docs/cli/preflight/#the---simulate-stage) is the
jail: it replays your code on a local n8n engine, whereas the sandbox here is a
boundary, not a model of n8n.

## What's emulated vs. unsupported

| Global | Status | How `run` handles it |
| --- | --- | --- |
| `$input`, `$json`, `$binary` | ✅ Covered | from the fixture `input` (defaults to one empty item); an array of arrays pins one per input index |
| `$('Node')`, `$node`, `$items()` | ✅ Covered | views over the fixture `nodes` map, per-output entries included — see the branch-index note below |
| `$jmespath` / `$jmesPath` | ✅ Covered | real JMESPath — `jmespath@0.16.0`, the version n8n pins |
| `DateTime` / `Duration` / `Interval` | ✅ Covered | Luxon, exactly as in n8n |
| `$now` / `$today` | ✅ Covered | Luxon `DateTime` — now / start-of-day |
| `console` | ✅ Covered | prints to your terminal (n8n shows it in the execution log) |
| `$getWorkflowStaticData` | ✅ Covered | seeded from `workflow.json`'s `staticData` / the fixture |
| `$env` | ✅ Pinnable | fixture `env`, or `--allow-env` to inherit the process env |
| `$workflow`, `$execution`, `$prevNode` | 🟡 Stub / pinnable | a small stub, or the fixture value |
| `$nodeId` / `$nodeVersion` / `$webhookId` | 🟡 From the node | read from `workflow.json`'s node entry (stubbed if none) |
| `$runIndex` / `$itemIndex` | 🟡 Partial | pinned at `0` (the each-item loop advances `$itemIndex`) |
| `$('Node').item` / `.itemMatching()` | 🟡 Partial | approximate — reads the fixture by position, **not** true paired-item linking |
| `$vars` / `$secrets` | 🟡 Pin or escalate | pin in the fixture, else a friendly signpost to `test` |
| `$evaluateExpression` | ⛔ Unsupported | needs n8n's expression engine → signposts `test` |
| `$if` / `$min` / `$max` / `$ifEmpty` | ⛔ Not a Code-node global | n8n **expression-language** helpers (`{{ }}` only) — they throw in real n8n's Code node too, so they're not provided |

**Branch indexes are answered when pinned, refused when not — never guessed.**
`$('Node').all(1)`, `$items('Node', 1)` and `$input.all(1)` ask for a node's
*second* output — an `IF`'s false branch, an error output. Pin it by giving that
node **one items array per output**:

```json
"nodes": { "Decide": [[{ "json": { "side": "true" } }], [{ "json": { "side": "false" } }]] }
```

`all(1)`, `first(1)` and `last(1)` then read output 1, and an **empty** array is
a real answer (that branch took no items). Ask for an output the fixture does
not supply and `run` says so — naming the call and how many outputs it has —
rather than handing back output 0's items, which is wrong data that looks right.
Same escape hatch as always: run it for real with [`test`](/docs/cli/test/).

**When emulation isn't enough, escalate to `test`.** A node that needs a real
`$vars`/`$secrets` value, true paired-item linking, real execution ids, or
`$evaluateExpression` should run against the instance with
[`test`](/docs/cli/test/) — or pin the value it needs in the fixture. `run`
refuses an instance-scoped global with a message that **names the global and
points here**, never a bare `ReferenceError`.

## Fixtures

The optional fixture JSON supplies the context; every field is optional:

```json
{
  "input": [{ "json": { "sku": "A1" } }],
  "nodes": { "Fetch Products": [{ "json": { "id": 1 } }] },
  "params": { "keepOnlySet": true },
  "env": { "REGION": "eu" },
  "vars": { "apiBase": "https://api.example.com" },
  "secrets": { "vault": { "token": "s3cr3t" } },
  "staticData": { "global": { "cursor": 42 } },
  "workflow": { "id": "42", "name": "Order Sync", "active": true },
  "execution": { "id": "1001", "mode": "manual" },
  "prevNode": { "name": "Fetch Products", "outputIndex": 0, "runIndex": 0 }
}
```

- `input` feeds `$input`/`$json`; without a fixture the input defaults to a
  single empty item. An array **of arrays** is one items array per *input*
  index, so `$input.all(1)` reads a Merge node's second input.
- `nodes` backs `$('Node Name')`, `$node['Node Name']`, and `$items('Node Name')`.
  An array **of arrays** is one items array per **output** (see branch indexes
  above); a plain items array is a single output, as before. That means a single
  output whose items are themselves arrays needs the explicit item form
  (`[{ "json": [1, 2] }]`).
- `params` backs `$input.params` (defaults to `{}`).
- `env` backs `$env`. Like n8n's own scoped `$env`, it is **empty by default** —
  set it explicitly with this field, or pass **`--allow-env`** to inherit the
  CLI process's environment (which may include `N8N_API_KEY` and other secrets),
  so a node that prints `$env` never leaks the host environment by accident.
- `vars` / `secrets` back `$vars` / `$secrets`. These are **instance-scoped** —
  without a fixture value `run` can't know them, so any access throws the
  friendly *"not emulated in `run` — use `test`, or pin `vars`/`secrets`"*
  message. Pin them here to run a node that reads them offline.
- `$getWorkflowStaticData` is seeded from `workflow.json`'s `staticData`
  (`global` and this node's slice); a fixture `staticData` replaces the
  matching slice (`"node"` refers to the node being run). Mutations are
  visible during the run but never persisted — `run` is offline.
- `workflow`, `execution`, and `prevNode` back `$workflow`, `$execution`, and
  `$prevNode`; each defaults to a small stub (`$workflow` →
  `{ id: "local", name: "local", active: false }`, `$execution` →
  `{ id: "local", mode: "test" }`) when omitted.

For **real** input shapes instead of hand-written ones, fetch production run
data with [executions](/docs/cli/executions/) and copy a node's items into
your fixture.
