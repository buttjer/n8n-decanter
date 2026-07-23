---
title: node run
description: Execute a Code node offline against an emulated n8n context, with optional fixtures.
order: 20
---

```sh
n8n-decanter node run <node-file> [fixture.json] [--allow-env]
```

Executes a node's body against an **emulated** n8n context (`$input`, `$json`,
`$('Node')`, `$jmespath`, `DateTime`, `$getWorkflowStaticData`, …) and prints the
items it returns. Fully offline — no credentials, no network. Prefer this over
hand-rolling a throwaway test script.

`run` is the **fast, offline approximation** rung of the verification ladder — it
is *not* a faithful n8n runtime. Where a global's value genuinely lives on the
instance, `run` says so and points you at [`test`](/docs/cli/test/) (which runs
the real n8n draft over MCP) instead of guessing. See
[the boundary](#whats-emulated-vs-unsupported) below.

The run mode (`runOnceForAllItems` / `runOnceForEachItem`) is read from the
node's entry in `workflow.json`, so each-item nodes are looped once per input
item.

## What's emulated vs. unsupported

| Global | Status | How `run` handles it |
| --- | --- | --- |
| `$input`, `$json`, `$binary` | ✅ Covered | from the fixture `input` (defaults to one empty item) |
| `$('Node')`, `$node`, `$items()` | ✅ Covered | views over the fixture `nodes` map |
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
  single empty item.
- `nodes` backs `$('Node Name')`, `$node['Node Name']`, and `$items('Node Name')`.
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
