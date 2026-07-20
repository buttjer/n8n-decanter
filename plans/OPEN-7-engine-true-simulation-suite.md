# Plan 7 — Engine-true simulation suite

| | |
|---|---|
| **Priority** | P3 (spike may promote the rest; **unblocked** 2026-07-19 — Plan 3 C shipped as the `executions` verb) |
| **Status** | Not started |
| **Theme** | replay a whole workflow through the *real* n8n engine offline — network nodes pinned with captured execution data (LLM-guessed fixtures fill the gaps), side-effect-free nodes executing for real — with a hard guarantee that nothing external is written. |
| **Model** | **Opus** — the highest-reasoning plan in the backlog: the route-B transform, the `n8n execute` subprocess orchestration, and above all the *safety-critical* default-deny node classification (a misclassified node runs for real) reward the strongest model. Once the spike (task 1) and transform are designed, the CLI/test wiring can drop to Sonnet. |

## Why

Three confidence layers exist today, and none answers "does this workflow,
with my edited Code nodes, still behave the same?" the way n8n itself would —
connection traversal, expression evaluation, `runOnceForEachItem` semantics,
paired items:

- `run` (`lib/run.mts`) executes a **single Code node** in-process against a
  hand-built fake of the n8n globals — `$('…')` refs, item pairing, and run
  modes are approximations; there is no expression engine and no graph.
- `npm test` mocks the n8n **API** — it proves sync fidelity, not workflow
  behavior.
- `test:smoke` (Plan 15) drives a **real n8n**, but proves the CLI's sync
  contract against it, not the behavior of *your* workflow.

The backlog item asks for the missing layer: execute the workflow with the
n8n engine, feeding captured executions data as the mock, dry — no API
writes, no side effects. The payoff is an engine-true regression check: edit
a Code node, replay the workflow against a captured execution, diff the
outputs.

## Source

- [Plan 0](BACKLOG.md): "**Engine-true simulation suite** — real e2e test or
  simulation suite: is there a way to really execute the workflow with the n8n
  engine using executions data as a mock/dry run? Also making sure nothing is
  really written through APIs or similar. Keep in mind executions data can be
  flawed or change in the future."
- Fixture source: [Plan 3](DONE-3-local-run-and-diff-fidelity.md) C's
  `executions` verb (**shipped 2026-07-19**) —
  `workflows/<Name>/executions/<execId>.json`, verbatim API responses, items
  under `data.resultData.runData["<Node>"][0].data.main[0][]` (shape recorded
  in Plan 3's C outcome, asserted weekly by the Plan 15 smoke suite — format
  drift shows up there before it breaks the loader here). The dirs are
  gitignored temp data; the keep/pin story is task 3's `--pin`. Note `runData`
  stores each node's **outputs** — exactly what pinning needs; the
  input-reconstruction problem that deferred `run --from-execution` (a node's
  own input isn't stored) doesn't apply, because pure nodes recompute their
  inputs' consequences and pinned nodes don't read inputs at all.
- Related: [Plan 20](OPEN-20-cli-publish-lifecycle.md) task 3 — the
  stale-capture warning there uses the same `workflowVersionId` signal the
  loader needs (executions run the *published* version, the repo holds the
  draft); share the helper with whichever lands second.
  [Plan 22](DONE-22-test-suite-depth.md) task 6 — the smoke version matrix is
  where the engine-interface canary belongs (its notes already keep
  `test:sim` separate from `npm test`).

## Design decision — the engine (decided 2026-07-20, user)

**Route B: workflow transform + real n8n (`n8n execute`).** The spike
(task 1) now de-risks this design rather than gating a choice.

The transform rewrites a *copy* of the workflow: materialize `//@file:`
placeholders into real code (reusing `buildNodeCode` from `lib/push.mts`);
keep side-effect-free nodes (Set, IF, Switch, Merge, Filter, …) intact so
they *really* execute; replace every network/side-effectful node — anything
credentialed, HTTP, DB, messaging, or of unknown type (default-deny) —
in-place with a node returning its pinned items (same name and connections,
so `$('…')` and expressions still resolve). The trigger is replaced the same
way — a pinned node **keeping its name** emitting the captured trigger output
(the exact manual-start mechanics are a task 1 probe; a bare "swap in a
Manual Trigger" would break `$('<Trigger>')` references).

The engine runs the transformed copy, pinned per the version policy below,
with no credentials mounted. n8n 1.x removed `execute --file`, so the flow is
`n8n import:workflow --input=sim.json && n8n execute --id=<id>` against a
throwaway SQLite (import deactivates workflows by default — a free extra
safety layer). The Code node runs via internal-mode task runners (loopback
broker, works under `--network none`) or in-process with
`N8N_RUNNERS_ENABLED=false`.

The engine backend is pluggable; Docker is optional:

- **Default: `npx n8n@<ver>`** with `N8N_USER_FOLDER` in a scratch dir —
  throwaway SQLite/config, per-run version pinning, keeps n8n out of the
  decanter's own dependency tree. The no-side-effects guarantee here is
  structural (no I/O-capable node survives the transform) plus sandbox
  config (empty task-runner stdlib allowlist, telemetry/version fetches
  disabled via env) — not a physical network cutoff.
- **Opt-in hard isolation: Docker `--network none`** (CI) — adds the
  enforced network cutoff on top.

Why B: engine-true by construction on *any* n8n version (run the matching
one); no fragile internal APIs. Accepted costs: heavy engine install either
way (npx cache or image, native sqlite bindings, first-boot DB migrations);
slower per run; output scraped from `n8n execute`'s result JSON.

**Rejected routes (footnote):**

- **A. In-process engine embed** — dev-depend on `n8n-workflow` + `n8n-core`,
  instantiate `WorkflowExecute` over a custom `INodeTypes` registry (real
  implementations for pure nodes, a synthetic replay type for pinned ones).
  Fast and debuggable, but the embedding surface is effectively internal and
  shifts across releases, the Code node drags in all of `n8n-nodes-base`,
  newer n8n runs it via task runners, and version skew vs the user's
  instance is on us. Kept only as the fallback if the task 1 checkpoint
  fails — a stop-and-raise, never a silent pivot.
- **C. Grow `lib/run.mts` into a graph walker** — Plan 3's deferred
  `run --chain`; approximates the engine, which is precisely what this item
  wants to stop doing.

## Design decision — engine version policy (2026-07-20)

**One configured engine version per run; no simulate-owned version matrix.**

- The surface simulate consumes — `n8n import:workflow`, `n8n execute --id`,
  the execution-result `runData` JSON — is old and stable (it predates 2.x;
  `runData` is n8n's own persisted execution format, the same shape its UI
  history reads). Treat it as **stable across the 2.x line** until the spike
  or the smoke matrix says otherwise.
- "Engine-true" still means true *to the user's instance*, and 2.x point
  releases can differ in verified behavior (pinData API writes are verified
  only on ≥ 2.30.7 — [Plan 18](DONE-18-pindata-smoke-seeding.md)), so the
  version stays a **parameter**, not a constant: optional `n8nVersion` in
  `decanter.config.json` → `npx n8n@<ver>` / the Docker tag. Matching the
  instance costs a string; a matrix costs a test farm. The pin is manual —
  the public API doesn't expose the instance version (see the
  `n8n-globals.d.ts` backlog item's findings).
- Absent `n8nVersion`: default to the smoke suite's pinned version (one
  shared constant — 2.30.7 today) with a one-line hint recommending a pin
  matching the instance.
- Verification runs on the smoke pin only. When Plan 22 task 6's smoke
  version matrix lands, add a cheap **engine-interface canary** step there
  (import + execute + parse the result JSON) — interface drift across 2.x is
  then caught by infrastructure that already exists.

## Tasks

1. **Spike (timeboxed; de-risks route B).** Hand-capture one execution
   (`GET /executions/{id}?includeData=true` → `data.resultData.runData`) from
   the live instance. Manually build the transformed workflow for one real
   workflow and run it through route B via the npx backend (`npx n8n@<ver>`
   with scratch `N8N_USER_FOLDER`, `import:workflow` + `execute --id`, see
   above); note wall time (first-boot SQLite migrations!), install weight,
   output shape, task-runner behavior (incl. whether sandboxed code can reach
   the network at all — `fetch` availability), and version pinning ergonomics.
   Sanity-check the same flow once under Docker `--network none` — reuse
   Plan 15's rig knowledge (readiness = `/rest/settings` returns real JSON;
   `/healthz` is liveness only; warm-up answers every route
   `200 "n8n is starting up"`). Specific probes:
   - Does `n8n execute` honor native `pinData` in CLI mode? If yes, pinning
     can use the workflow's own `pinData` field (node stays intact,
     credentials still stripped) instead of node replacement; if not (pin
     data has historically been manual-mode-only), replacement it is.
   - Trigger mechanics: how `execute --id` picks its entry point, and what
     the name-preserving trigger replacement must look like.
   - A multi-run capture (loop workflow): confirm what
     `runData["<node>"].length > 1` looks like, backing the v1 hard-error
     (Non-goals).
   **Checkpoint:** a warm (post-install) replay of the spike workflow
   completes in ≈30 s wall or less and the execute output supports a
   per-node diff. If either fails, stop and raise — route A is the recorded
   fallback (see the footnote), not a silent pivot. Record findings in this
   file.
2. **`lib/simulate.mts` — fixture loader + transform.**
   - Node classification: a maintained allowlist of side-effect-free node
     types executes for real; everything else is a **network node** and gets
     pinned. **Default-deny:** a node type not on the allowlist is treated as
     network — safety never depends on knowing the type. **Seed list (needs
     sign-off — misclassifying a node as pure executes it for real):**
     `n8n-nodes-base.` `code`, `set`, `if`, `switch`, `filter`, `merge`,
     `sort`, `limit`, `aggregate`, `splitOut`, `removeDuplicates`,
     `renameKeys`, `dateTime`, `noOp`. Deliberately excluded despite being
     side-effect-free: `splitInBatches` (loop driver — loops are out of
     scope v1), `wait` (time semantics), `executeWorkflow` (crosses the
     workflow boundary).
   - Loader: fixture precedence is `workflows/<Name>/fixtures/<Node>.json`
     (committed, provenance-stamped — tasks 3/6) over
     `executions/<execId>.json` (gitignored temp). Validate the `runData`
     shape defensively (the item's caveat: executions data can be flawed or
     change format across n8n versions; the recorded shape in Plan 3 C is the
     reference). A network node with no captured run data and no stored
     fixture is a **hard error** listing the nodes (and pointing at
     `--fill-gaps`, task 6); disabled nodes and untaken branches are exempt.
     Any surviving node with **more than one run** in the capture is a hard
     error too ("loop workflows are out of scope", Non-goals). Warn when the
     capture's `workflowVersionId` differs from the local draft's `versionId`
     (stale capture — published vs draft; same signal as Plan 20 task 3).
   - Transform: produce the simulation copy per route B above. Refuse to emit
     if any surviving executable node is outside the pure allowlist, and strip
     `credentials` from every node — the structural half of the dry-run
     guarantee.
3. **`simulate` verb.** `n8n-decanter simulate <ref> --execution <execId>` in
   `n8n-decanter.mts` (register in `VERBS` + `REF_VERBS`; the picker's verb
   menu stays unchanged — simulate needs an execution argument the menu can't
   supply): transform to a temp file, run the engine per the chosen route,
   print per-node item counts, and diff each Code node's simulated output
   against the captured execution's output for that node. Divergence →
   nonzero exit (this is the regression check); a `--json` report for tooling.
   - **Diff policy (v1):** exact compare of item `json` payloads,
     key-order-insensitive (stable stringify, like the structure hash);
     `pairedItem`/metadata excluded. Nodes with nondeterministic output
     (`$now`, `Math.random`, `new Date()`) legitimately diverge — a
     documented failure mode, not masked; an `--ignore <path>` escape hatch
     is deferred until real need.
   - **`--pin <execId>`** — the keep/pin story for gitignored captures: copy
     the network nodes' `runData` into `fixtures/<Node>.json` with
     provenance (`"source": "capture"`, execId, `workflowVersionId`, date),
     making replays reproducible and committable. Warn on pin: execution
     data can hold credentials/PII (the reason `executions/` is gitignored)
     — review before committing.
4. **Isolation.** npx backend: scrubbed env (no `N8N_*` credentials/env leak
   in), `N8N_DIAGNOSTICS_ENABLED=false` + version-notification/template
   fetches off, empty task-runner stdlib allowlist. Docker backend adds the
   enforced `--network none` cutoff. Engine version per the version-policy
   section (`n8nVersion` config, smoke-pin default).
5. **Tests.** The transform and fixture loader/validation are offline — cover
   them in `test/e2e.mts` (mock server grows nothing new beyond Plan 3 C's
   executions handler). The actual engine run needs a real n8n (npx download
   or Docker), which the e2e sandbox can't assume: put it behind an opt-in
   `npm run test:sim` (own script; Plan 22 keeps it out of `npm test` and out
   of the smoke suite) that skips cleanly when no engine is available. If
   built on `test/harness.mts`, Plan 22 task 1's step filter applies here
   for free.
6. **LLM gap filling (`--fill-gaps`) — severable; v1 ships without it** (the
   hard error on gaps is the safe baseline, and this is the CLI's first LLM
   dependency). For pinned nodes with no captured output (untaken branch,
   node added or reparametrized since the capture), ask an LLM for an
   educated guess: prompt from the node's type + parameters plus adjacent
   captured items as few-shot examples. Write the result to
   `workflows/<Name>/fixtures/<Node>.json` with provenance
   (`"source": "llm-guess"`, model, date, node-params hash) — reviewable and
   hand-editable, and loaded like any capture thereafter. Generation is the
   only online step; simulate runs stay offline and deterministic. Warn when
   a fixture's params hash no longer matches the node (stale guess). Needs an
   API key (env, e.g. `ANTHROPIC_API_KEY`); absent key, `simulate` still
   works with captures/fixtures and hard-errors on gaps. Shape the
   prompt/client plumbing for reuse by the backlog's "LLM semantic
   validation" item.

## Acceptance / verification

- `simulate` replays a captured execution through a real n8n engine — pure
  nodes executing genuinely, network nodes pinned — with no credentials
  present and no outbound-capable nodes (zero network enforced in the Docker
  mode), and exits 0 when Code-node outputs match the capture.
- Deliberately breaking a Code node locally makes `simulate` exit nonzero with
  a readable per-node diff.
- A network node without capture or fixture fails up front with the list of
  unpinnable nodes — never a half-real run. A capture with a multi-run node
  fails with the loops-out-of-scope error; a capture whose
  `workflowVersionId` differs from the draft warns.
- `simulate --pin` writes provenance-stamped fixtures that replay identically
  to the capture they came from, with the PII review warning printed.
- The transform never emits a workflow containing an off-allowlist executable
  node or a `credentials` block (asserted in `test/e2e.mts`).
- `npm test` stays green without Docker or npx downloads; `test:sim` passes
  where an engine is available and skips cleanly where not.
- With task 6 landed: `--fill-gaps` writes the guessed fixture with
  provenance, then uses it like a capture.

## Non-goals

- Simulating external services beyond replaying captured or LLM-guessed
  outputs (no live HTTP mocking layer, no credential faking).
- Live trigger semantics (webhook payload capture timing, schedules) — the
  trigger is always a pinned replay of the captured trigger output.
- **Loop workflows (v1):** any surviving node with more than one run in the
  capture hard-errors — multi-run replay semantics (which run pins? loop
  drivers) are their own project; revisit after v1.
- Treating captured executions as ground truth — they're convenience fixtures
  that age (LLM guesses doubly so, and they're marked as such); the diff tells
  you "changed vs the capture", not "wrong".
- **Replacing single-node `run` (Plan 3).** Different layers, kept
  deliberately: `run` is the sub-second inner loop — one node, in-process,
  zero install, works from a hand-built fixture or none; `simulate` is the
  slow outer check — whole graph, real engine (npx download or image,
  first-boot migrations), needs a capture. Folding them into one verb
  (`run --engine`) would couple a zero-dep instant command to an engine
  download; two verbs stay. One inversion worth recording: `run` executes
  node code **in the CLI process with full host privileges** (see the
  backlog's security recommendation), while `simulate` runs it inside n8n's
  task-runner sandbox with network cut — for generated/untrusted node code,
  `simulate` is the *safer* executor despite being the heavier one.
- An n8n version matrix owned by this plan — Plan 22 task 6's smoke matrix
  carries the canary (version policy above).

## Notes

- **Refreshed 2026-07-20** against shipped Plans 3 C/15/18 and open Plans
  20/22: unblocked; version policy decided; `--pin` keep/pin story added;
  loops scoped out of v1; trigger-swap shorthand corrected (name
  preservation); allowlist seeded; LLM gap filling made severable.
- **Route decided 2026-07-20 (user): B.** Route A reduced to a fallback
  footnote; the spike de-risks B instead of gating a choice.
- **Ordering:** independent now — the spike can start anytime. Soft ties:
  Plan 20 task 3 (shared staleness helper), Plan 22 task 6 (canary lands
  with the matrix).
- **CHANGELOG:** `simulate` verb (incl. `--pin`, later `--fill-gaps`),
  `test:sim`, and the `n8nVersion` config field are user-facing — Added
  entries under `[Unreleased]` when they land.
- **PLAN.md sign-off list (raise with the user before landing, per
  `CLAUDE.md`):** the `simulate` verb, the `n8nVersion` config field, the
  committed `workflows/<Name>/fixtures/` artifact (the guard already
  reserves the subdir), consumption of `executions/`, the pure-node
  allowlist, and the route-B design (user-decided 2026-07-20 — PLAN.md gets
  it when the feature lands).
- **Allowlist maintenance:** curated, versioned; additions need
  justification. Default-deny carries the safety, not the list.
- **Licensing:** n8n's Sustainable Use License permits running it for
  internal testing like this; we never redistribute engine code.
- **Capture staleness & versioning:** capture files are verbatim API
  responses (Plan 3 C shipped without a producer-version stamp, and the
  recorded response shape carries no n8n version) — the available staleness
  signal is `workflowVersionId` (published-vs-draft, warned by the loader).
  Engine-version pinning therefore comes *solely* from `n8nVersion` config.
  If producer-version stamping ever matters, it means changing the shipped
  `executions` verb (sidecar file — the verbatim property is by design);
  deferred.
- **Known fidelity risks (spike must probe):** replay nodes should emit
  `pairedItem` from the capture, or downstream `$('…').itemMatching()` /
  item-linking expressions may fail; binary data in captures is often a
  filesystem reference, not embedded — workflows with binary payloads may be
  out of scope for v1 (declare in Non-goals if so).
