# Plan 3 — Local run/diff fidelity

**Priority:** P2
**Status:** In progress (A + B done 2026-07-18; C open, needs a live-API spike)
**Theme:** make offline iteration trustworthy — seed staticData in `run`, diff
local vs live before push, and capture real execution data as fixtures.

## Why

The reviewer's second-biggest friction (after the red guard) was local testing:
heavy cross-node `$('…')` coupling makes single-node `run` painful, and nodes
that read workflow static data can't be exercised at all. Meanwhile `status`
detects per-node drift but won't show *what* changed, so pushes are riskier than
they need to be. All three fixes reuse machinery that already exists.

## Source

- IDEAS (new): `run` staticData seeding (P2)
- IDEAS (new): `status --diff` (P2)
- IDEAS: "pull latest execution datasets … as separate command" (P2), plus a
  `run --from-execution <id>` fixture flag

## Tasks

### A. `run` staticData seeding — DONE (2026-07-18)

`lib/run.mts` `buildGlobals` currently exposes no `$getWorkflowStaticData`, so a
node calling it dies with a ReferenceError — even though `findNode` already
parses the sibling `workflow.json`.

1. Read `workflow.json`'s `staticData` (it holds `global` + per-node scopes) in
   `runNode`/`buildGlobals`.
2. Provide `$getWorkflowStaticData(type)` returning the matching slice; let a
   fixture field (e.g. `fixture.staticData`) override it. ~10 lines.

### B. `status --diff` — DONE (2026-07-18)

`lib/status.mts` already does four-way per-node classification and computes both
local and remote hashes (compiling `.ts` the same way push does).

1. Add a `--diff` flag to the `status` command in `n8n-decanter.mts`.
2. When set, for each node that differs, render a content diff of the local body
   vs the remote body — respecting the placeholder/compiled-marker rules already
   encoded in `status.mts` (`splitMarker`, `compileTs`). A minimal line diff is
   enough; both sides are already materialized in memory.

### C. Execution datasets + `run --from-execution`

1. **Pull execution datasets.** On `pull` (and as a standalone
   `n8n-decanter executions <id>` command), fetch recent executions via the
   public API and write them to `workflows/<Name>/executions/<execId>.json`.
   Guard against writing anything back through the API (read-only). Requires an
   executions endpoint in `lib/api.mts`.
2. **`run --from-execution <id>`.** Load an execution dataset as a `run` fixture:
   reconstruct `$input`, the `$('…')` node outputs, and staticData from the
   captured run so a coupled node can be exercised against real data.
   - Caveat (from IDEAS): execution data can be flawed or change over time — treat
     it as a convenience fixture, not ground truth.

Defer `run --chain "A" "B"` (pipe one node's output into the next's `$('…')`) —
it has real ordering/mode semantics; revisit after `--from-execution` lands.

## Acceptance / verification

- A node using `$getWorkflowStaticData` runs offline and returns expected data
  seeded from `workflow.json` (and can be overridden by a fixture).
- `status --diff` prints a readable diff for a locally-edited node and nothing for
  in-sync nodes.
- `pull` writes execution JSON under `workflows/*/executions/`; `run
  --from-execution` reconstructs a coupled node's inputs. `npm test` covers the
  offline paths (executions fetch mocked by the e2e n8n stub).

## Notes

- CHANGELOG: `status --diff`, staticData in `run`, execution-dataset pull, and
  `run --from-execution` are all user-facing — add entries under `[Unreleased]`.
- The executions endpoint is the one piece here that touches the live API; the
  e2e suite's mock server must grow a handler for it.

## A + B outcome (2026-07-18)

- **A**: `$getWorkflowStaticData('global'|'node')` seeded from
  `workflow.json` using n8n's key scheme (`global`, `node:<name>`;
  string-form staticData parsed). Fixture `staticData: { global?, node? }`
  replaces the matching slice whole (`node` = the node being run). Mutations
  visible during the run, never persisted. Template fixture docs updated.
- **B**: implemented with a zero-dep LCS unified differ (`lib/diff.mts`,
  unit-tested) instead of shelling out to `git diff --no-index` — no temp
  files, works without git, output styled through the Plan 11 layer
  (`-` red / `+` green on a TTY, plain when piped). Diffs print under
  push-pending, changed-remotely, and CONFLICT nodes; `.ts` nodes diff their
  compiled JS (what the hashes compare). Structural (`workflow.json`) diffing
  stayed out of scope.
- **C — executions API ground truth (captured 2026-07-19 by the Plan 15
  smoke suite against n8n 2.30.7):** `GET /api/v1/executions?includeData=true`
  → `{ data: [{ id, status: "success", mode: "webhook", workflowId,
  workflowVersionId, startedAt, stoppedAt, jsonSizeBytes, data: {
  resultData: { runData: { "<Node Name>": [{ data: { main: [[{ json: {…},
  pairedItem: {…} }]] } }] } }, workflowData, customData }] }` — items are
  under `runData.<name>[0].data.main[0][]` with `.json` payloads; note the
  2.x per-execution `workflowVersionId` (executions run the *published*
  version). The smoke suite asserts this shape weekly, so drift shows up
  before C is built on it.
- **C — open questions raised before starting (record of 2026-07-18 review):**
  execution data may contain credentials/PII, and `workflows/<Name>/executions/`
  sits inside the commit-on-pull pathspec — storage must default to
  gitignored (or live outside `root`); fetching on every `pull` is scope
  creep vs a standalone `executions` verb; and the `resultData.runData` →
  fixture mapping needs a live-instance spike (incl. the n8n 2.x
  draft-vs-published mismatch: executions run the published version).
