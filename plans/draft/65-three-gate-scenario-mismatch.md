# Plan 65 — `scenario check`, `preflight --simulate` and `test` enforce three different node sets

**Status:** Draft
**Priority:** P1
**Source:** claim B3 of the 2026-07-30 field report ("check grün, test verlangte
11 weitere Nodes"), reproduced offline 2026-07-31.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

Three gates compute "which nodes need pin data" three different ways, and the
docs assert on three surfaces that two of them are the same rule. A
capture-seeded scenario can therefore be complete for `check` *and* for
`simulate` and still be rejected by `test` — with no supported way to fix it,
because `scenario create` refuses to touch an existing scenario.

## The three gates

| gate | demands data for |
|---|---|
| `scenario check` → `validateScenarioRunData` ([`simulate.mts:259-263`](../../lib/simulate.mts)) | only what's listed in `_decanterScenario.fill` — it never opens `workflow.json` |
| `preflight --simulate` → `buildSimulation` ([`simulate.mts:461-468`](../../lib/simulate.mts)) | network nodes **reachable in the capture**; untaken branches are neutralized |
| `test` → `buildTestPins` ([`testrun.mts:75-89`](../../lib/testrun.mts)) | **every** enabled, non-pure, non-loop-driver node — no reachability notion at all |

`scenario create --execution` seeds `fill` from the reachability set, so `check`
is structurally incapable of knowing the scenario is insufficient for `test`.

## Notes toward a decision

- **The matching predicate already exists** — `pinnableNodes()` is exactly
  `test`'s rule, but is used only in the bare `--scaffold` (no `--execution`)
  branch. That's why a from-scratch scaffold satisfies `test` and a
  capture-seeded one doesn't.
- `test`'s stricter rule has a **real safety rationale the docs never state**: it
  runs on the live instance with real credentials, so an unpinned node reached
  unexpectedly hits the real world — whereas simulate's unpinned node becomes a
  throwing Code node. Unifying downward needs that weighed.
- **Dead end today:** `test`'s abort says "run `n8n-decanter scenario create`",
  but `writeScenario` hard-refuses an existing scenario
  ([`simulate.mts:581`](../../lib/simulate.mts)), and regenerating recomputes the
  same short list. The only way out is hand-editing raw JSON for nodes the tool
  never listed, with no `inputSample`/`expectedSchema` — the reporter's "11
  additional nodes". An `--extend`/`--add-missing` mode is the obvious shape.
- **Undocumented escape hatch worth shipping either way:**
  `"Node": [{"data":{"main":[[]]}}]` satisfies **both** `buildTestPins` and
  `scenario check` — an explicit "this branch isn't exercised". Bare `"Node": []`
  does not (and gets reported as unfilled). `scenario create --scaffold` could
  pre-fill formality nodes with it instead of listing them for a human; the
  reporter's "11 of 23 pins were pure formality" is exactly this.
- Docs asserting the false symmetry: [`docs/cli/scenario.md:29-32`](../../docs/cli/scenario.md)
  ("Both replays hard-error on a gap"), `template/AGENTS.md.example:468`,
  `PLAN.md:812`. The per-verb pages are each individually correct — it's
  `scenario.md`, the page you land on *while filling pins*, that misleads.

Depends on [Plan 63](../open/63-field-feedback-bugfixes.md) task 4 (branch-aware
reachability) landing first, or `fill` stays wrong regardless of which gate wins.
