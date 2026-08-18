# Plan 67 — `scenario create --trim`: bound what lands in git

**Status:** Draft
**Priority:** P2
**Source:** claim 5 / feature request of the 2026-07-30 field report (33 MB
scenario; the reporter hand-built the trim as a `jq` program). Re-verified
against main 2026-08-18 — see "Drift since the last snapshot".
**Snapshot:** 2026-08-18T12:43Z @ eaadd46
**Model:** Sonnet — the traps below pin the design; what is left is a contained
change in one function plus tests.

`scenario create --execution` writes a verbatim copy of the capture — every item
of every node — with no cap, sampling or byte budget, and `scenarios/` is
deliberately tracked. Since [Plan 63](../done/63-field-feedback-bugfixes.md) task 7
the CLI **tells the user to trim** past 1 MB while offering no way to do it. This
plan is that way: a cheap unconditional strip of fields nothing reads, then a
`--trim` flag whose four traps make it more than a `slice()`.

## Drift since the last snapshot (checked 2026-08-18, `11bbbc7..eaadd46`)

Four changes land on this plan; none invalidates it, two strengthen it and two
change the design.

- **The size signal shipped — and it advertises a mechanism that does not
  exist.** Plan 63 task 7 landed 2026-08-05 (#221): the success line carries
  `(N KB/MB)` ([`simulate.mts:870`](../../lib/simulate.mts)) and past 1 MB a
  warning says *"Trim it before that, or keep the capture out of the scenario"*
  ([`:878`](../../lib/simulate.mts)). That is a dead end today. **This plan is
  now the follow-through on a promise the CLI already makes**, not a
  nice-to-have.
- **`scenario create` became fully offline** ([Plan 76](../done/76-offline-pin-sources.md),
  #229) — [`n8n-decanter.mts:498`](../../n8n-decanter.mts) lists it in the
  `offline` set, so no MCP client is constructed for it at all. See "Why this
  never touches MCP" below.
- **Plan 66 split the output dimension** (#255–#258). `firstRunItems` now takes
  an `outputIndex` ([`simulate.mts:166`](../../lib/simulate.mts)) and
  `populatedOutputs` ([`:185`](../../lib/simulate.mts)) answers "which outputs
  carry items". **Trap 1 below is rewritten because of this** — the old
  "run 0 / output 0" scoping is wrong.
- **Plan 65 added `notExercised`** ([`simulate.mts:826-831`](../../lib/simulate.mts)):
  `writeScenario` now mutates the capture's runData before writing it. **That is
  a fourth trap**, new since the last snapshot.

## Mechanics confirmed (re-read on `eaadd46`)

The only thing stripped is the top-level `workflowData` key
([`simulate.mts:847-851`](../../lib/simulate.mts)) — and that is for *duplication*
(committed node source), not size. Everything else rides along.

Re-verified that nothing downstream reads the passengers, so **the cheap first
win still stands**: extend the strip to `startedAt`, `stoppedAt`, `status`,
`mode`, `data.executionData` and friends, with no behavior change.

- The engine never sees the file. `buildSimulation` synthesizes a **workflow
  with `pinData`** and returns that ([`:659`](../../lib/simulate.mts)); the
  capture is only a data source.
- `status` is read on a **raw capture** at fetch time
  ([`executions.mts:119`](../../lib/executions.mts)), never on a scenario.
  `historyCheck`'s `status`/`startedAt`/`stoppedAt`
  ([`preflight.mts:626`](../../lib/preflight.mts)) come from the executions
  *list* over MCP/REST, not from any file.
- **Correction to the last snapshot:** it listed top-level `workflowVersionId`
  as read-back. For a *scenario* it is not —
  [`preflight.mts:538`](../../lib/preflight.mts) reads the **meta** copy
  (`readScenarioMeta(exec)?.workflowVersionId`) and only falls back to the
  top-level field for a raw capture. The scenario's top-level copy is
  strippable too; keeping it is harmless.
- The compliance guard reads only `workflowData.nodes[].parameters`
  ([`validate.mts:351-357`](../../lib/validate.mts)), and `scenario check`
  validates only `data.resultData.runData`
  ([`simulate.mts:285`](../../lib/simulate.mts)) — neither notices the extra
  keys going away.

Keep indent-2 (measured 2.4× vs compact on a realistic runData shape, but
hand-editability *is* the feature) and **do not gitignore `scenarios/`** — the
tracking is the documented reproducibility contract. Fix the size, not the
formatting or the tracking.

## The four traps

- **Don't drop runs — and the rule is finer than "run 0".** The multi-iteration
  detector keys on `runs.length`, but asymmetrically: any non-driver node with
  `> 1` run, or a **loop driver with `> 2`**
  ([`simulate.mts:519-530`](../../lib/simulate.mts)). A naive trim that drops
  extra runs silently reclassifies a loop capture as single-iteration and
  replays it wrongly — and it also corrupts the Tier-2 *"iteration 1 of N"*
  count, which is derived from the same lengths
  ([`:531-539`](../../lib/simulate.mts)). Scope the trim to items *within* a run,
  never to the runs themselves.
- **Trim per populated output, not `main[0]`** *(rewritten — Plan 66)*. A
  branching node emits on **one** output per run: an IF that took "true" has
  items in `main[0]` and an empty `main[1]`, and reading `main[0]` for every edge
  was itself a bug (Plan 63 task 4, see the comment at
  [`simulate.mts:169-173`](../../lib/simulate.mts)). Walk
  `populatedOutputs(runs)` ([`:185`](../../lib/simulate.mts)) and cap each
  populated output consistently across all nodes; an "output 0 only" trim would
  leave a whole branch's data untouched while claiming to have trimmed.
- **A trimmed scenario can't keep `capture` provenance — and the default is
  against you.** `scenarioProvenance` marks **every** node present in `runData`
  as `capture` unless it is in the `fill` list
  ([`simulate.mts:258-268`](../../lib/simulate.mts)), and the diff loop treats an
  unknown node as `capture` too (`provenanceMap.get(node) ?? "capture"`,
  [`:1191`](../../lib/simulate.mts)). Trimming upstream items changes what
  aggregating pure nodes (`aggregate`, `sort`, `limit`, `merge`) emit, so a
  legitimately trimmed file would start failing the per-node diff
  ([`:1189-1197`](../../lib/simulate.mts)) **by default**, with no opt-out. Record
  a trim marker in `_decanterScenario` that `scenarioProvenance` honours (a
  fourth `Provenance` value, or a `trimmed: string[]` the map reads), so the
  demotion is explicit and visible in the file.
- **New — don't let a trim fake "not exercised."** `writeScenario` pre-fills
  pinnable nodes the capture never reached with an empty run, keyed on
  `firstRunItems(baseRunData[n]) === undefined`
  ([`simulate.mts:826-831`](../../lib/simulate.mts)), and records them under
  `notExercised`. `firstRunItems` returns `[]` (not `undefined`) for a node that
  ran and emitted nothing, so an *emptying* trim would not itself flip the
  classification — but a trim that deletes a node's runs entirely would, turning
  "ran, trimmed away" into the claim "this branch isn't exercised". **Order the
  trim after the `notExercised` computation**, and never remove a node key.

## Why this never touches MCP

Checked because it gated the decision to work on this plan:

- `scenario create` is in the **offline** verb set
  ([`n8n-decanter.mts:498`](../../n8n-decanter.mts)) — the MCP client is
  constructed lazily and this path never asks for it.
- The capture it reads is already on disk under `executions/`, fetched over
  **REST** by the separate `executions` verb, because MCP has no full-run-data
  read ([`lib/api.mts:5`](../../lib/api.mts)). MCP's `get_execution`
  `truncateData`/`nodeNames` are therefore not an option; trim client-side in
  `writeScenario`.
- The one MCP link in `lib/simulate.mts` is a **type-only** import of
  `PinDataScaffold` ([`:19`](../../lib/simulate.mts)) for the `--scaffold`
  annotation path, which degrades to unannotated with no host. The trim work
  touches neither it nor `lib/mcp.mts`.

## Scope

1. **The cheap win, unconditional**: widen the strip at
   [`simulate.mts:851`](../../lib/simulate.mts) from `workflowData` alone to the
   fields listed above. No flag, no behavior change, applies to every new
   scenario.
2. **`--trim [n]`** on `scenario create` — cap items per populated output per
   node, honouring all four traps. It is a boolean-with-optional-value flag, so
   it needs an entry in the value-flag regex
   ([`n8n-decanter.mts:187`](../../n8n-decanter.mts)) plus the completion list
   ([`:342`](../../n8n-decanter.mts)); the offline set already covers it.
3. **The trim marker** in `ScenarioMeta` ([`simulate.mts:679-704`](../../lib/simulate.mts))
   and its handling in `scenarioProvenance`.
4. **Docs + changelog** — `docs/cli/scenario.md` (which already carries the size
   note from Plan 63 task 7), the README `## Commands` row is unchanged (no new
   verb), `CHANGELOG.md` `[Unreleased]` → **Added**.
5. **Tests** — `test/unit/simulate.test.mts` already asserts the `workflowData`
   strip (`:721-729`); extend it for the widened strip, and add cases for each
   trap: a loop capture keeps its run counts, a branching capture is trimmed on
   the output it actually used, and a trimmed node is not diffed.

## Open question for whoever executes this

**Does the >1 MB warning get rewritten, or does `--trim` become the answer it
already points at?** The warning currently says "Trim it before that, or keep the
capture out of the scenario" — once this ships it should name the flag. Decide
whether that is a Changed entry alongside the Added one.

No prior plan touches payload size — Plans 7 and 37 own this code and never
discuss it.
