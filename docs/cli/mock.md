---
title: mock
description: Create and validate committed execution mocks — named scenarios that fill simulate's gaps, edited locally, no LLM API.
order: 15
---

```sh
n8n-decanter mock create <workflow> ["<slug>"] [--execution <id>] [--json]
n8n-decanter mock check  <workflow> ["<slug>"] [--json]
```

The `mock` namespace manages **execution mocks** — committed, hand-editable
*named scenarios* that fill [simulate](/docs/cli/simulate/)'s gaps. They live in
`workflows/<folder>/mocks/<slug>.json`, in the same format as a real capture, so
`simulate --mock <slug>` replays one directly. Everything here is **offline** —
no engine, and **no LLM API or key**: you (or your IDE agent) author the data.

A *gap* is a network node reached during a replay with **no captured data** — a
node added or reparametrized since the capture. `simulate` hard-errors on a gap;
a mock is how you supply the missing data as a reproducible, reviewable scenario.

## `mock create`

Promotes a captured execution into a committed mock scenario:

```sh
n8n-decanter order-sync mock create "happy-path" --execution 4812
#   copies executions/4812.json -> mocks/happy-path.json, flags the gap nodes
```

- **`<slug>`** names the scenario (`happy-path`, `empty-cart`, `error-case`) and
  becomes the filename (kebab-cased). **Optional** — omit it and the mock is
  named after the execution id (`mocks/4812.json`). Keep a library of scenarios
  per workflow.
- **`--execution <id>`** is the seed capture; defaults to the newest one in
  `executions/`.
- **`--json`** prints `{ slug, file, gaps }` for tooling.
- Copies **real captured data** (which can hold credentials/PII) — `mock create`
  prints a review warning; check before committing. It **refuses to overwrite**
  an existing mock, so it never clobbers data you've filled in.

The written file is a verbatim copy of the capture plus a `_decanterMock` block
listing each gap node with its type, parameters, and an `inputSample`:

```jsonc
{
  "id": 4812,
  "data": { "resultData": { "runData": {
    "Trigger": [ /* real captured runs, untouched */ ],
    "Compute": [ /* … */ ]
    // add "Enrich Customer" here ↓
  } } },
  "_decanterMock": {
    "sourceExecution": "4812",
    "createdAt": "2026-07-21",
    "guidance": "For each node in \"fill\", add data.resultData.runData[\"<node>\"] = [ { \"data\": { \"main\": [ [ { \"json\": { …output… } } ] ] } } ]. Keep \"fill\" as-is — mock check validates it. Then: simulate --mock happy-path.",
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

You (or your agent) add each fill node's `runData` using its context, and
**leave `fill` in place** (it records which nodes are mocked and is what
`mock check` validates).

## `mock check`

Structurally validates a mock **offline** — the fast loop while filling, no
Docker needed:

```sh
n8n-decanter order-sync mock check happy-path   # one scenario
n8n-decanter order-sync mock check              # every mock in the folder
```

Exits `1` if any mock is malformed or has a `fill` node still empty, with a
node-named error:

```txt
mock mocks/happy-path.json is invalid:
  - Enrich Customer run 0 item 0: each item needs a "json" field
  - incomplete: add runData for Enrich Customer (still listed in _decanterMock.fill)
  expected per node: runData["<node>"] = [ { "data": { "main": [ [ { "json": { … } } ] ] } } ]
```

n8n publishes **no JSON Schema** for execution data — the format lives only in
the `n8n-workflow` TypeScript types (`IRunExecutionData` → `ITaskData` →
`INodeExecutionData`). `mock check` is the decanter's own structural check of the
exact shape it replays. `simulate --mock` runs the same check when it loads a
mock, so a bad scenario never reaches the engine.

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

## The full loop

```sh
n8n-decanter order-sync simulate --execution 4812   # ✗ gap: Enrich Customer has no data
n8n-decanter order-sync mock create "happy-path" --execution 4812
#   → fill mocks/happy-path.json's runData for the flagged nodes
n8n-decanter order-sync mock check happy-path       # ✓ valid   (offline, fast)
n8n-decanter order-sync simulate --mock happy-path  # replay the scenario
```

## Committed and reproducible

Unlike `executions/` (gitignored temp data), **`mocks/` is tracked in git**, so a
mocked replay is reproducible for teammates and CI. Mocks are chosen explicitly
by slug (`simulate --mock <slug>`) — they're named scenarios, not a "latest"
default.

## Not `--pin`

[simulate --pin](/docs/cli/simulate/#simulate-pin) freezes the **real** captured
outputs of *network* nodes into per-node `fixtures/` files. A mock is a whole
scenario you **edit** to fill gaps. Use `--pin` to make a clean capture
reproducible; use `mock` when a node has no captured data to pin.
