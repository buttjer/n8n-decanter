# Plan 67 — `scenario create --trim`: bound what lands in git

**Status:** Draft
**Priority:** P2
**Source:** claim 5 / feature request of the 2026-07-30 field report (33 MB
scenario; the reporter hand-built the trim as a `jq` program).
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

`scenario create --execution` writes a verbatim copy of the capture — every item
of every node — with no cap, sampling or byte budget, and `scenarios/` is
deliberately tracked. A trim flag is the requested fix, but it has two traps that
make it more than a `slice()`.

## Mechanics confirmed

The only thing stripped is the top-level `workflowData` key
([`simulate.mts:642`](../../lib/simulate.mts)) — and that's for duplication, not
size. Everything else rides along, including `data.executionData`, `startedAt`,
`status` and other fields decanter **never reads back**: the CLI provably touches
only `data.resultData.runData`, `workflowVersionId` and `_decanterScenario`. So
**a cheap first win exists with no behavior change** — extend the strip.

Keep indent-2 (measured 2.4× vs compact on a realistic runData shape, but
hand-editability *is* the feature) and **do not gitignore `scenarios/`** — the
tracking is the documented reproducibility contract. Fix the size, not the
formatting or the tracking.

## The two traps

- **Don't drop runs.** `firstRunItems` reads run 0 only, but `buildSimulation`'s
  multi-iteration detector keys on `runs.length`
  ([`simulate.mts:403`](../../lib/simulate.mts)). A naive trim that drops extra
  runs silently reclassifies a loop capture as single-iteration and replays it
  wrongly. Scope the trim to items *within* run 0 / output 0, consistently across
  all nodes.
- **A trimmed scenario can't keep `capture` provenance.** Trimming upstream items
  changes what aggregating pure nodes (`aggregate`, `sort`, `limit`, `merge`)
  emit, so the per-node diff at [`simulate.mts:826-833`](../../lib/simulate.mts)
  would start failing on a legitimately trimmed file. Mark it synthetic, or record
  a trim marker in `_decanterScenario` that the diff honours.

MCP's `get_execution` `truncateData`/`nodeNames` are **not** an option — captures
ride REST deliberately ([`lib/api.mts:5`](../../lib/api.mts)) because MCP has no
full-run-data read. Trim client-side in `writeScenario`.

The byte-size **warning** is [Plan 63](../done/63-field-feedback-bugfixes.md)
task 7 (3 lines, precedent in `lib/compile.mts`); this plan is the actual
trimming. No prior plan touches payload size — Plans 7 and 37 own this code and
never discuss it.
