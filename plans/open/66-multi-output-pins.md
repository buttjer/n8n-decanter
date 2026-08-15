# Plan 66 — Pins only ever replay `main[0]`, and a 0-item run still reports success

**Status:** In progress — **tasks 1–3 done** (the two amplifiers: the `test`
coverage line + verdict and `scenario check`'s truncation warnings; plus the
multi-output sim stand-in); task 4 (`node run` branch fixtures) open
**Priority:** P1 for task 1 (the coverage line: small, offline, catches the
reported failure on its own); P2 for tasks 2–4.
**Source:** claim 3 of the 2026-07-30 field report (every pinned run died at
"Group products (drop failed)" — the node just emitted 0 items), verified
2026-07-31.
**Snapshot:** 2026-08-15T14:14Z @ 120bfcf *(graduated draft → open; drift
checked against the 2026-07-31 snapshot, findings below)*
**Model:** Opus for task 3 (sim topology); Sonnet for the rest.

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

Builds on [Plan 63](../done/63-field-feedback-bugfixes.md) tasks 4 and 5 (output
index plumbed through `forEachConnectionTarget`; `all(n>0)` throwing instead of
lying). The proper `node run` fix — fixture `nodes` accepting `RunItem[][]` so
`all(branchIndex)` indexes it — belongs here, not there.

## Drift check (2026-08-15, `11bbbc7..120bfcf`)

Every claim above re-verified against today's `main`. Nothing invalidated; two
things moved:

- **`firstRunItems` already takes an `outputIndex`** (`simulate.mts:152`) and the
  *edge traversal* uses it — `reachableInCapture` and `capturedInputFor` read the
  right output per connection (Plan 63 task 4). What still truncates is **pin
  construction**: `buildTestPins` (`testrun.mts:76`) and the sim's
  `replacementNode` (`simulate.mts:382`, still a single-output Code node). The
  plan's line numbers are stale; the substance is not.
- **Plan 65 gave `scenario check` a reporting seam** — `reportTestReadiness`
  already says out loud what `test` would refuse. The requested multi-output
  warning belongs beside it, so task 2 needs **less new machinery** than the
  draft assumed.
- `node run` now **refuses** `all(n>0)` loudly (`branchSignpost`, Plan 63 task 5)
  rather than lying, so task 4 upgrades a refusal into an answer instead of
  fixing a silent wrong.
- Scenario surface additions since the snapshot (Plan 76 offline pin sources,
  Plan 77 `--isolate --all`, `--execution` pinning unreached nodes to an empty
  run) touch the same files but none of them conflicts. The empty-run pinning
  makes the coverage line **more** load-bearing: empty pins are now deliberately
  produced, so "everything downstream emitted 0 items" is a reachable steady
  state that nothing reports today.

## Tasks

1. **Coverage in the `test` report** (P1 — the draft's own "highest-value item").
   Count what each node actually emitted in the instance run and print it:
   `coverage: N/M nodes emitted items — K emitted none: X, Y`. And make the
   verdict honest: a synthetic-pin run where **no** unpinned node emitted a
   single item proved nothing, so `ok` becomes false instead of "success".
   Partial emptiness stays a warning — a filter that legitimately drops
   everything is not a failure.
2. **`scenario check` warns about what the replay will drop.** Any node whose
   captured `runData` populates more than one `main` output group → warn that
   both replay paths use `main[0]`. Plus the static scan of node sources for
   `$('<pinned>').all(n)` / `$items('<pinned>', n)` with `n > 0` — the check that
   would have caught the reported case. Report, never enforce; it sits with
   `reportTestReadiness`.
3. **`preflight --simulate`: a multi-output stand-in.** Replace the
   single-output Code node with a Code→Switch pair (one output per populated
   group) when the captured node emitted on more than one output, and rewire the
   sim's edges per output index. `switch` is already on `PURE_NODE_TYPES`, so the
   dry-run guarantee is unaffected.
4. **`node run` fixtures accept `RunItem[][]`** so `all(branchIndex)` /
   `$items(name, n)` answer from the pinned branch instead of hitting
   `branchSignpost`. The refusal stays for a branch the fixture doesn't pin.
