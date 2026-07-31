# Plan 66 — Pins only ever replay `main[0]`, and a 0-item run still reports success

**Status:** Draft
**Priority:** P2
**Source:** claim 3 of the 2026-07-30 field report (every pinned run died at
"Group products (drop failed)" — the node just emitted 0 items), verified
2026-07-31.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

Every pin path funnels through `firstRunItems`, which reads
`runs[0].data.main[0]` and discards every other output — so a node fed only by an
IF's false branch or an error output receives nothing and emits nothing. Two
things make it worse than a plain limitation: `scenario check` **validates the
multi-output data it will then throw away**, and the synthetic-pin test report
calls a run where everything downstream produced 0 items a success.

## What's decanter's and what's n8n's

- **`test`: genuinely n8n's.** It hands n8n a `pinData` map, and pinData is a
  flat `INodeExecutionData[]` per node with no output dimension. Not fixable at
  that API — so `test` needs a **loud refusal/warning**, not a silent truncation.
- **`preflight --simulate`: decanter's own transform.** That path deliberately
  does *not* use pinData (the module header records that `n8n execute` ignores it
  in CLI mode) and pins by **node replacement** instead — and the replacement it
  chose is a single-output Code node ([`simulate.mts:341-344`](../../lib/simulate.mts)).
  Nothing about n8n forced that; decanter controls the sim workflow's topology.
  A `switch` stand-in with one rule per non-empty output is the cheap fix.
  **Don't file both halves as "n8n limitation, wontfix".**

## The two amplifiers

- `validateScenarioRunData` iterates **every** output index and explicitly
  tolerates `null` for an unconnected one
  ([`simulate.mts:248-250`](../../lib/simulate.mts)); `docs/cli/scenario.md:145`
  annotates `main` as "outputs — index 0 is the node's main output", which reads
  as "there are more and they work". An author who correctly writes the error
  branch gets `✓ valid`, then both replays use `main[0]` only. Warning belongs in
  `scenario check` — it's the offline loop an agent actually runs.
- `printTestReport` never prints per-node item counts
  ([`testrun.mts:268-325`](../../lib/testrun.mts)), and on a synthetic-pin
  scenario `ok` reduces to `result.status === "success"` — which n8n reports for a
  run where every downstream node got 0 items. **A coverage line ("N nodes
  emitted no items: X, Y") would have surfaced the reported failure with no
  multi-output work at all** — arguably the highest-value item here. Note the
  mitigation: on a pure *capture*-provenance scenario the diff does fire and shows
  `expected [...] / actual []`; it's specifically the synthetic path the tool
  steers you to when you have gaps that is silent.

## Also in scope

The requested warning: flag any pinnable node whose `connections[<node>].main`
has more than one populated group, plus a static scan of node sources for
`$('<pinned>').all(n)` / `$items('<pinned>', n)` with `n > 0`. The second is what
would have caught the reported case. All the information is already local in
`workflow.json`; nothing in `lib/` handles `onError`/`errorOutput`/output index
today.

Builds on [Plan 63](../open/63-field-feedback-bugfixes.md) tasks 4 and 5 (output
index plumbed through `forEachConnectionTarget`; `all(n>0)` throwing instead of
lying). The proper `node run` fix — fixture `nodes` accepting `RunItem[][]` so
`all(branchIndex)` indexes it — belongs here, not there.
