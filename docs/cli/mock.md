---
title: mock
description: Promote a captured execution into a committed, hand-fillable execution mock — the way to fill gaps for simulate.
order: 15
---

```sh
n8n-decanter mock <workflow> [--execution <id>]
```

Promotes a captured execution into a **committed, editable execution mock** at
`workflows/<folder>/execution-mocks/<id>.json`. It's a verbatim copy of the
capture in the same format, so [simulate](/docs/cli/simulate/) reads it directly —
and **prefers it** over the gitignored raw capture of the same id.

Its job is to **fill gaps**. A *gap* is a network node reached during a
[simulate](/docs/cli/simulate/) replay that has **no captured data** — a node
added or reparametrized since the capture, so `simulate` can't pin it and
hard-errors. `mock` writes a file you (or your IDE agent) complete by hand; the
CLI **never calls a model and needs no API key**. Pinned data stays the source
of truth — a filled gap is just a pin whose provenance is "authored", not
"captured".

Without `--execution`, `mock` uses the **newest** local execution (a capture in
`executions/`, or an existing mock).

## The gap-fill loop

```sh
# 1. simulate hits a gap — a network node with no captured data
n8n-decanter order-sync simulate --execution 4812
# ✗ network node(s) reached with no captured or fixture data: Enrich Customer —
#   create a committed, fillable mock with `n8n-decanter order-sync mock --execution 4812` …

# 2. promote the capture to a committed mock, which flags what to fill
n8n-decanter order-sync mock --execution 4812
# ! fill runData for 1 node: Enrich Customer — see the "_decanterMock" block

# 3. edit execution-mocks/4812.json (see below), then replay — the mock is preferred
n8n-decanter order-sync simulate --execution 4812
```

## What the mock file looks like

A full copy of the execution plus a `_decanterMock` block listing the nodes to
fill, each with the node's type, parameters, and a sample of the items feeding
it as context:

```jsonc
{
  "id": 4812,
  "data": { "resultData": { "runData": {
    "Trigger":  [ /* real captured runs, untouched */ ],
    "Compute":  [ /* … */ ]
    // add "Enrich Customer" here ↓
  } } },
  "_decanterMock": {
    "sourceExecution": "4812",
    "createdAt": "2026-07-21",
    "guidance": "For each node in \"fill\", add data.resultData.runData[\"<node>\"] = [ { \"data\": { \"main\": [ [ { \"json\": { …output… } } ] ] } } ], using its context. Keep \"fill\" as-is — simulate validates it. Re-run: simulate --execution 4812.",
    "fill": [
      {
        "node": "Enrich Customer",
        "type": "n8n-nodes-base.httpRequest",
        "parameters": { "url": "https://api.crm.internal/customers/{{$json.id}}" },
        "inputSample": [ { "id": 42, "email": "a@b.com" } ]
      }
    ]
  }
}
```

You (or your agent) add the node's `runData` under
`data.resultData.runData["Enrich Customer"]` using the `fill` entry as context —
and **leave `fill` in place** (it records which nodes are mocked rather than
captured, and is what `simulate` validates). On the next `simulate`, that node is
pinned from the mock exactly like a captured node.

## Validation

n8n publishes no JSON Schema for execution data — the format lives only in the
`n8n-workflow` TypeScript types (`IRunExecutionData` → `ITaskData` →
`INodeExecutionData`). So when `simulate` loads a mock, it **structurally
validates** the run data it's about to use and fails with an actionable,
node-named error if a filled node is malformed — for example:

```txt
mock execution-mocks/4812.json is invalid:
  - Enrich Customer run 0 item 0: each item needs a "json" field
  - incomplete: add runData for Enrich Customer (still listed in _decanterMock.fill)
  expected per node: runData["<node>"] = [ { "data": { "main": [ [ { "json": { … } } ] ] } } ]
```

The shape to match, per node:

```jsonc
"runData": {
  "Enrich Customer": [            // one entry per run (a normal node runs once)
    { "data": { "main": [         // outputs — index 0 is the node's main output
      [                           // the items array for that output
        { "json": { "id": 42, "name": "Ada" } }   // each item is { "json": … }
      ]
    ] } }
  ]
}
```

Real captures aren't re-validated (they come straight from the API); the check
targets your hand edits.

## Committed and reproducible

Unlike `executions/` (gitignored temp data), **`execution-mocks/` is tracked in
git**, so a mocked replay is reproducible for teammates and CI. The mock copies
**real captured data**, which can contain credentials or PII — `mock` prints a
review warning; check the file before committing.

`mock` **refuses to overwrite** an existing mock, so it never clobbers data
you've filled in — delete the file to regenerate from the capture.

## Options

| Flag | Meaning |
| --- | --- |
| `--execution <id>` | The capture to promote (optional — defaults to the newest local execution) |

## Not `--pin`

[simulate --pin](/docs/cli/simulate/#simulate-pin) freezes the **real** captured
outputs of *network* nodes into per-node `fixtures/` files. `mock` produces a
whole-execution file you **edit** to fill gaps. Use `--pin` to make a clean
capture reproducible; use `mock` when a node has no captured data to pin.
