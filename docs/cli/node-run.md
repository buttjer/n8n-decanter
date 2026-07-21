---
title: node run
description: Execute a Code node offline against a faked n8n context, with optional fixtures.
order: 18
---

```sh
n8n-decanter node run <node-file> [fixture.json] [--allow-env]
```

Actually executes a node's body against a faked n8n context (`$input`,
`$json`, `$('Node')`, `DateTime`, `$getWorkflowStaticData`, …) and prints the
items it returns. Fully offline — no credentials, no network. Prefer this
over hand-rolling a throwaway test script.

The run mode (`runOnceForAllItems` / `runOnceForEachItem`) is read from the
node's entry in `workflow.json`, so each-item nodes are looped once per input
item.

## Fixtures

The optional fixture JSON supplies the context; every field is optional:

```json
{
  "input": [{ "json": { "sku": "A1" } }],
  "nodes": { "Fetch Products": [{ "json": { "id": 1 } }] },
  "params": { "keepOnlySet": true },
  "env": { "REGION": "eu" },
  "staticData": { "global": { "cursor": 42 } },
  "workflow": { "id": "42", "name": "Order Sync", "active": true },
  "execution": { "id": "1001", "mode": "manual" },
  "prevNode": { "name": "Fetch Products", "outputIndex": 0, "runIndex": 0 }
}
```

- `input` feeds `$input`/`$json`; without a fixture the input defaults to a
  single empty item.
- `nodes` backs `$('Node Name')`.
- `params` backs `$input.params` (defaults to `{}`).
- `env` backs `$env`. Like n8n's own scoped `$env`, it is **empty by default** —
  set it explicitly with this field, or pass **`--allow-env`** to inherit the
  CLI process's environment (which may include `N8N_API_KEY` and other secrets),
  so a node that prints `$env` never leaks the host environment by accident.
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
