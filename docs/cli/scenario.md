---
title: scenario
description: Create and validate committed scenarios — named, full-workflow pin-data sets that fill simulate/test's gaps, captured or schema-scaffolded, no LLM API.
order: 16
---

```sh
n8n-decanter scenario create <workflow> ["<slug>"] [--execution <id>] [--scaffold] [--json]
n8n-decanter scenario check  <workflow> ["<slug>"] [--json]
```

Both take a workflow ref first. Leaving it off **on a terminal** opens the
[picker](/docs/cli/overview/#interactive-picker) to choose one (same as every
other ref-taking verb); piped/non-TTY runs still error with the usage line, so
scripts and agents never block.

A **scenario** is a named, committed input set for your workflow — captured
from a real run or scaffolded from its schemas — that
[test](/docs/cli/test/)/[simulate](/docs/cli/simulate/) replay and diff
against. It's the **only committed pin artifact**: `workflows/<folder>/scenarios/<slug>.json`
is a self-contained, execution-shaped file, so `simulate --scenario <slug>` /
`test --scenario <slug>` replay it directly, no precedence rules to reason
about. Everything here is **offline** — no engine for `scenario create`/`check`
themselves, and **no LLM API or key**: you (or your IDE agent) author the
values.

A *gap* is a network node reached during a replay with **no pinned data** — a
node added or reparametrized since the capture, or every node when building a
scenario from scratch. `simulate`/`test` hard-error on a gap; a scenario is how
you supply the missing data as a reproducible, reviewable set.

## `scenario create`

Two seeds, composable:

```sh
n8n-decanter scenario create order-sync "happy-path" --execution 4812
#   copies executions/4812.json -> scenarios/happy-path.json, flags the gap nodes

n8n-decanter scenario create order-sync "happy-path" --execution 4812 --scaffold
#   same, plus annotates each gap with its output JSON Schema

n8n-decanter scenario create order-sync "from-scratch" --scaffold
#   no capture: every pinnable node becomes a schema-annotated fill entry
```

- **`<slug>`** names the scenario (`happy-path`, `empty-cart`, `error-case`) and
  becomes the filename (kebab-cased). **Optional** — omit it and the scenario is
  named after the execution id (`scenarios/4812.json`, or `scenario` for a
  slug-less pure scaffold). Keep a library of scenarios per workflow.
- **`--execution <id>`** seeds the scenario from a captured execution
  (`executions/<id>.json`); nodes with captured output are recorded as
  **`capture`** provenance, each remaining gap is listed under
  `_decanterScenario.fill`.
- **`--scaffold`** calls n8n's read-only MCP tool `prepare_test_pin_data` and
  annotates each gap with its output **JSON Schema** (`expectedSchema`),
  provenance `scaffolded`. **It never invents values** — the tool returns
  schemas and coverage counts only, no data (`readOnlyHint: true`); a person
  or agent still authors every value, reviewed in the diff like any other
  scenario edit. Composes with `--execution`: the capture seeds what it
  covers, `--scaffold` annotates the remaining gaps. **A bare `--scaffold` with
  no `--execution`** builds a from-scratch set where *every* pinnable node is
  a fill entry. Needs MCP; offline or on an older n8n it errors naming the
  capture-based alternative.
- Neither `--execution` nor `--scaffold` given → defaults to the newest capture
  under `executions/` (same as `simulate`/`test`'s default).
- **`--json`** prints `{ slug, file, gaps, coverage }` for tooling (`coverage`
  only present when `--scaffold` ran).
- A capture-seeded scenario copies **real captured data** (which can hold
  credentials/PII) — `scenario create` prints a review warning; check before
  committing. It **refuses to overwrite** an existing scenario, so it never
  clobbers data you've filled in.

The written file is a verbatim copy of the capture (or a bare skeleton for a
pure scaffold) plus a `_decanterScenario` block listing each gap node with its
type, parameters, an `inputSample`, and — when scaffolded — its
`expectedSchema`:

```jsonc
{
  "id": 4812,
  "data": { "resultData": { "runData": {
    "Trigger": [ /* real captured runs, untouched */ ],
    "Compute": [ /* … */ ]
    // add "Enrich Customer" here ↓
  } } },
  "_decanterScenario": {
    "source": "capture+scaffold",
    "sourceExecution": "4812",
    "createdAt": "2026-07-21",
    "workflowVersionId": "…",
    "guidance": "For each node in \"fill\", add data.resultData.runData[\"<node>\"] = [ { \"data\": { \"main\": [ [ { \"json\": { …output… } } ] ] } } ], using its type/parameters/inputSample/expectedSchema as context. Keep \"fill\" as-is — scenario check validates it. Then: simulate --scenario happy-path.",
    "fill": [
      {
        "node": "Enrich Customer",
        "type": "n8n-nodes-base.httpRequest",
        "parameters": { "url": "https://api.crm.internal/customers/{{$json.id}}" },
        "inputSample": [ { "id": 42, "email": "a@b.com" } ],
        "expectedSchema": { "type": "object", "properties": { "id": { "type": "number" }, "name": { "type": "string" } } }
      }
    ]
  }
}
```

You (or your agent) add each fill node's `runData` using its context (type,
parameters, `inputSample`, and `expectedSchema` when present), and **leave
`fill` in place** — it records which nodes are synthetic (the provenance
signal) and is what `scenario check` validates.

## `scenario check`

Structurally validates a scenario **offline** — the fast loop while filling,
no Docker needed:

```sh
n8n-decanter scenario check order-sync happy-path   # one scenario
n8n-decanter scenario check order-sync              # every scenario in the folder
```

Exits `1` if any scenario is malformed or has a `fill` node still empty, with a
node-named error:

```txt
scenario scenarios/happy-path.json is invalid:
  - Enrich Customer run 0 item 0: each item needs a "json" field
  - incomplete: add runData for Enrich Customer (still listed in _decanterScenario.fill)
  expected per node: runData["<node>"] = [ { "data": { "main": [ [ { "json": { … } } ] ] } } ]
```

n8n publishes **no JSON Schema** for execution data — the format lives only in
the `n8n-workflow` TypeScript types (`IRunExecutionData` → `ITaskData` →
`INodeExecutionData`). `scenario check` is decanter's own structural check of
the exact shape it replays. `simulate --scenario`/`test --scenario` run the
same check when they load a scenario, so a bad file never reaches the engine
or the instance.

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
n8n-decanter simulate order-sync --execution 4812        # ✗ gap: Enrich Customer has no data
n8n-decanter scenario create order-sync "happy-path" --execution 4812
#   → fill scenarios/happy-path.json's runData for the flagged nodes
n8n-decanter scenario check order-sync happy-path          # ✓ valid   (offline, fast)
n8n-decanter simulate order-sync --scenario happy-path     # replay the scenario
```

## Provenance and synthetic pins

Each node's pins in a scenario carry a **provenance**: **`capture`** (real
execution data — can serve as the diff baseline), **`authored`**
(hand/agent-filled with no schema), or **`scaffolded`** (schema-guided fill,
`--scaffold`'s `expectedSchema`). A scenario with *any* non-`capture` node is
**synthetic pins** — `test`/`simulate` label the run "**synthetic pins —
proves executability, not output correctness**": no per-node diff is
asserted, and divergence is informational, not a fail. A capture-only
scenario (no `fill` entries left) keeps the full per-node diff and
exit-1-on-divergence semantics unchanged. `--json` reports gain
`syntheticPins: boolean` and `provenance: Record<node, "capture"|"authored"|"scaffolded">`.

## Committed and reproducible

Unlike `executions/` (gitignored temp data), **`scenarios/` is tracked in
git**, so a scenario-based replay is reproducible for teammates and CI.
Scenarios are chosen explicitly by slug (`simulate --scenario <slug>` /
`test --scenario <slug>`) — they're named scenarios, not a "latest" default.

## Migration and removed mechanisms

- A legacy `mocks/` dir (the pre-rename name) **auto-migrates** to
  `scenarios/` the first time any verb touches it — a plain git-recorded
  rename, so history follows. It refuses when both the legacy `mocks/` and
  `scenarios/` exist (merge them by hand first). The legacy metadata key
  `_decanterMock` is still read (as `_decanterScenario`) for files written
  before the rename.
- The legacy per-node `fixtures/<node>.json` mechanism and `simulate --pin`
  are **removed outright** — no read path. A leftover legacy `fixtures/`
  dir is a **hard error** from `simulate`/`check` naming the replacement:
  recreate the data as a scenario (`scenario create --execution <id>`),
  then delete the legacy `fixtures/` dir.

## Relation to the official n8n skills

n8n's own `n8n-workflow-lifecycle-official` skill teaches agents an
**ephemeral** in-session pin flow: `prepare_test_pin_data` → the agent
generates values → `test_workflow`, per-execution, nothing persisted.
Scenarios are decanter's **durable** counterpart to the same tool pair: a
scenario is committed, human-reviewed, reused across runs, and (when
capture-seeded) diffed against real data — composing with the official flow
rather than competing with it.
