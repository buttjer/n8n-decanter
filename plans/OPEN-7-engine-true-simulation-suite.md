# Plan 7 — Engine-true simulation suite

| | |
|---|---|
| **Priority** | P3 (spike may promote the rest; **unblocked** 2026-07-19 — Plan 3 C shipped as the `executions` verb) |
| **Status** | **In progress** — spike + tasks 2–5 done 2026-07-20/21 (Docker backend): the `simulate` verb ships and replays engine-true against real n8n, with a browsable viewer, picker entry, and `--pin`. Remaining: **task 6 gap handling** (guide-to-pin default + viewer-pin + `--guess-gaps` LLM last resort — see the trust ladder) and the **npx engine backend**, now split to [Plan 26](OPEN-26-npx-engine-backend.md). |
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
- Related: [Plan 20](DONE-20-cli-publish-lifecycle.md) task 3 (**shipped**) —
  its stale-capture warning already implements the `workflowVersionId` signal
  the loader needs (executions run the *published* version, the repo holds the
  draft), as `warnStaleFixtures` in `lib/executions.mts` (currently private;
  export/extract it rather than re-derive). [Plan 22](DONE-22-test-suite-depth.md)
  task 6 — the smoke version matrix (**shipped**: 2.30.7 / 2.31.0 / 2.31.4) is
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

The engine backend is pluggable:

- **Shipped: Docker** (`n8nio/n8n:<ver>`) — a throwaway `--rm` container runs
  `import:workflow` + `execute`; `--network none` adds an enforced outbound
  cutoff on top of the structural guarantee (no I/O-capable node survives the
  transform). This is the only backend built (v1) and the one that's validated.
- **Deferred → [Plan 26](OPEN-26-npx-engine-backend.md): `npx n8n@<ver>`** with
  `N8N_USER_FOLDER` in a scratch dir — the *dependency-free default* the plan
  originally wanted (no Docker; runs on the Node the CLI already needs). Split
  into its own plan because it needs its own validation (native sqlite install,
  first-boot migrations) and a lifecycle story for the browsable viewer (a
  kept-alive `npx n8n start` is a host daemon, not a named container — see
  Plan 26). The headless diff run is npx's natural home; the viewer likely
  stays Docker-preferred.

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
- Verification runs on the smoke pin only. Plan 22 task 6's smoke version
  matrix has **shipped** (CI `smoke` job over 2.30.7 / 2.31.0 / 2.31.4) — add
  a cheap **engine-interface canary** step there (import + execute + parse the
  result JSON) so interface drift across 2.x is caught by infrastructure that
  now exists.

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

   **Spike findings (2026-07-20 — route B VALIDATED, checkpoint passed).**
   Ran against `n8nio/n8n:2.30.7` in Docker, reusing the Plan 15 rig
   (`/rest/settings` readiness, owner-setup + API-key bootstrap). Created a
   `Webhook → Compute(Code) → Tag(Set) → Fetch(HTTP)` workflow, fired the
   webhook to capture a real execution, then replayed the transform through a
   **fresh throwaway `docker run --rm` container** (`N8N_USER_FOLDER=/tmp/n8n`,
   own SQLite) with `n8n import:workflow --input=… && n8n execute --id=… --rawOutput`.
   - **Wall time ≈ 4.4 s** cold (fresh container incl. first-boot migrations),
     well under the 30 s budget. First-boot migrations are cheap here; the
     heavy cost is the one-time image pull (already cached).
   - **`execute --rawOutput` prints the full `resultData.runData` for *every*
     node** as JSON — identical shape to the captured execution
     (`runData["<Node>"][0].data.main[0][]`). **Per-node diff fully supported.**
   - **`pinData` is NOT honored by `execute` in CLI mode** (probes A & C: the
     pinned trigger/network nodes emitted default/empty output, so `Compute`
     ran against an empty item and threw). **Node replacement is therefore
     mandatory** — the plan's default path, not the pinData shortcut. Probe 1
     bullet answered: **no**, replacement it is.
   - **Trigger mechanics (probe answered):** `execute --id` needs a real
     trigger node as entry. Replacing the trigger with a plain Code node
     leaves no entry point and fails (probe B). **Winning transform (probe D,
     `code=0`):** prepend a bare `manualTrigger` (`__sim_start__`) as the entry
     and replace the trigger + every network node with **name-preserving Code
     nodes** (`type: code`, same `name`, `return <captured items>`) so
     `$('<Trigger>')`/`$('<Node>')` still resolve. Pure nodes (`Compute`,
     `Tag`) executed for real; `Fetch` emitted the captured value with **no
     live HTTP call**. Round-trip verified: replayed `Compute` = captured
     `{doubled:42}`.
   - The synthetic `__sim_start__` node appears in the output `runData` — the
     **diff must skip nodes absent from the original workflow.**
   - **Task runners:** the JS Task Runner registers and runs fine in the fresh
     container; the "Python 3 missing" message is a harmless warning (no Python
     nodes). `N8N_RUNNERS_ENABLED=false` did not suppress the broker on 2.30.7
     — irrelevant, since the fresh throwaway container has no port conflict.
   - **Multi-run probe:** the single-pass capture has `runData["Fetch"].length
     === 1`; backs the v1 hard-error on `length > 1` (Non-goals).
   - Docker `--network none` not yet exercised (opt-in hard-isolation mode);
     the default npx backend also still un-probed — both deferred to task 4,
     neither gates route B. Repro script kept in the spike scratchpad.
2. **`lib/simulate.mts` — fixture loader + transform.** ✅ **Done 2026-07-20**
   — allowlist (14 types, signed off) + default-deny classification, capture
   loader with fixture precedence and defensive `runData` validation, and the
   route-B transform (name-preserving Code replacement + synthetic
   `__sim_start__` manual trigger + credential strip + `assertDryRunSafe`
   guard). Covered by `test/unit/simulate.test.mts` (13 cases) and validated
   end-to-end: the shipped transform's output executes engine-true on real n8n
   (2.30.7), per-node outputs matching the capture. The `warnStaleFixtures`
   helper is now exported from `lib/executions.mts` and reused here.
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
     how to pin — hand-authored fixture / viewer-pin / `--guess-gaps`, task 6);
     disabled nodes and untaken branches are exempt.
     Any surviving node with **more than one run** in the capture is a hard
     error too ("loop workflows are out of scope", Non-goals). Warn when the
     capture's `workflowVersionId` differs from the local draft's `versionId`
     (stale capture — published vs draft; reuse `warnStaleFixtures` from
     `lib/executions.mts`, shipped by Plan 20 task 3).
   - Transform: produce the simulation copy per route B above. Refuse to emit
     if any surviving executable node is outside the pure allowlist, and strip
     `credentials` from every node — the structural half of the dry-run
     guarantee.
3. **`simulate` verb.** ✅ **Done 2026-07-20** — `n8n-decanter <ref> simulate
   --execution <id>` ships (registered in `VERBS` + `REF_VERBS`), with
   `lib/engine.mts` (Docker backend, route B), per-node diff, `--json`,
   `--pin`, `--network-none`, and the `n8nVersion` config field
   (`--n8n-version` override). Exits 1 on divergence. Diff unit-tested;
   full path verified live by `test:sim` (task 5) against n8n 2.30.7,
   including a deliberately-broken Code node failing and `--network-none`
   passing. **Deferred:** the npx backend (task 4's dependency-free default;
   Docker shipped first as validated). Original spec:
   `n8n-decanter simulate <ref> --execution <execId>` in
   `n8n-decanter.mts` (register in `VERBS` + `REF_VERBS`). **Picker: added
   2026-07-21** — the original "menu can't supply an execution id" objection was
   resolved by defaulting `--execution` to the newest local capture, so the
   picker offers `simulate` and runs it against the latest capture. Transform to
   a temp file, run the engine per the chosen route,
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
4. **Isolation.** ✅ **Docker done 2026-07-20** — scrubbed env (no `N8N_*`
   credential/env leak in; `N8N_DIAGNOSTICS_ENABLED=false`,
   version-notification/template fetches off, empty task-runner stdlib
   allowlist) plus the enforced `--network none` cutoff; engine version per the
   version-policy section (`n8nVersion` config, smoke-pin default). The **npx
   backend's** own isolation (structural + sandbox config, no physical cutoff)
   moves to [Plan 26](OPEN-26-npx-engine-backend.md).
5. **Tests.** The transform and fixture loader/validation are offline — cover
   them in `test/e2e.mts` (mock server grows nothing new beyond Plan 3 C's
   executions handler). The actual engine run needs a real n8n (npx download
   or Docker), which the e2e sandbox can't assume: put it behind an opt-in
   `npm run test:sim` (own script; Plan 22 keeps it out of `npm test` and out
   of the smoke suite) that skips cleanly when no engine is available. If
   built on `test/harness.mts`, Plan 22 task 1's step filter applies here
   for free.
6. **Gap handling — the trust ladder for unpinnable nodes** (decided
   2026-07-21, user). A *gap* is a network node reached in the replay with no
   pinned data (untaken branch, or a node added/reparametrized since the
   capture). Data supplied for a gap is a **mock pin — mechanically identical
   to a captured pin, differing only in provenance** — so the whole job is to
   *prefer real data and surface provenance*, never to quietly rest on invented
   data. Three rungs, best first:
   1. **Guide-you-to-pin (default; no LLM; cheap, ship first).** A gap stays a
      hard error, but the message **leads with how to pin**: it names the nodes
      and points at hand-authoring `fixtures/<Node>.json` and the viewer-pin
      flow below. *Tidy owed regardless:* the current gap error leaks an
      internal `(task 6)` reference and points at a `--fill-gaps` flag that
      doesn't exist yet — drop both, lead with pinning.
   2. **Pin-from-viewer (preferred non-LLM filler).** In the browsable viewer
      (see Notes), pin the missing node's data in the n8n editor — native
      `pinData` **is** honored in the server's manual executions, unlike CLI
      `execute` — run it, and capture that output back into
      `fixtures/<Node>.json`. Real, human-verified, deterministic; no API key.
   3. **`--guess-gaps` (LLM, last resort) — severable; v1 ships without it**
      (the CLI's first LLM dependency). Ask an LLM for an educated guess from
      the node's type + parameters plus adjacent captured items as few-shot
      examples; write it to `fixtures/<Node>.json` with provenance
      (`"source": "llm-guess"`, model, date, node-params hash) — reviewable,
      hand-editable, loaded like any capture, and **warned when the params hash
      drifts** (stale guess). Generation is the only online step; simulate runs
      stay offline/deterministic. Needs an API key (env, e.g.
      `ANTHROPIC_API_KEY`); absent it, `simulate` still works with
      captures/fixtures and hard-errors on gaps. **Named `--guess-gaps`, not
      `--fill-gaps`** — the flag must signal the data is an LLM *guess*,
      matching the `"source": "llm-guess"` stamp (renaming a released flag is
      breaking, so it's decided up front). Shape the prompt/client plumbing for
      reuse by the backlog's "LLM semantic validation" item.

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
- With task 6 landed: a gap leads the user to pin (fixture / viewer-pin), and
  `--guess-gaps` writes an LLM-guessed fixture with provenance, then uses it
  like a capture.

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
- **Verified 2026-07-20 (2nd pass).** Every code/plan fact re-checked against
  main: `lib/run.mts`, `buildNodeCode` in `lib/push.mts`, the `executions`
  verb + `runData["<Node>"][0].data.main[0][]` shape (asserted in
  `test/e2e.mts` and the smoke input→output roundtrip), `decanter.config.json`,
  and the 2.30.7 smoke pin all hold. Two soft ties have since **shipped** and
  are now updated above from "pending" to done: Plan 20 task 3's staleness
  helper (`warnStaleFixtures`, `lib/executions.mts`) and Plan 22 task 6's smoke
  version matrix (2.30.7 / 2.31.0 / 2.31.4). Design unchanged; still Not started.
- **Route decided 2026-07-20 (user): B.** Route A reduced to a fallback
  footnote; the spike de-risks B instead of gating a choice.
- **Ordering:** independent now — the spike can start anytime. Soft ties:
  Plan 20 task 3 (shared staleness helper), Plan 22 task 6 (canary lands
  with the matrix).
- **CHANGELOG:** `simulate` verb (incl. `--pin`, later `--guess-gaps`),
  `test:sim`, and the `n8nVersion` config field are user-facing — Added
  entries under `[Unreleased]` when they land.
- **Browsable viewer (added 2026-07-21, user request).** In an interactive
  terminal `simulate` also prints a URL to the run in a *kept-alive* local n8n
  (`lib/engine.mts` `startViewer`): reap+run a named container that does `import
  + n8n execute` (persists the run) then `n8n start` (serves it), seed a fixed
  throwaway owner, and print `…/workflow/<id>/executions/1` + login. The diff
  still comes from the headless run; the viewer is display-only. TTY-gated
  (off for pipes/`--json`/`--network-none`, so CI is unaffected and leaves no
  container). Gotcha found & fixed: the detached container bind-mounts the sim
  file, so it must **outlive `docker run -d`** (a stable temp path, not a
  per-call `mkdtemp` deleted immediately). n8n `execute` only persists when the
  workflow opts in (`saveDataSuccessExecution: "all"`), so the viewer forces
  those settings. "Public/shared execution link" isn't possible — n8n OSS has
  no execution-sharing feature.
- **PLAN.md sign-off list (raise with the user before landing, per
  `CLAUDE.md`):** the `simulate` verb, the `n8nVersion` config field, the
  committed `workflows/<Name>/fixtures/` artifact (the guard already
  reserves the subdir), consumption of `executions/`, the pure-node
  allowlist, and the route-B design (user-decided 2026-07-20 — PLAN.md gets
  it when the feature lands). **Allowlist signed off 2026-07-20 (user):** the
  14 seed types as-is, the three exclusions kept out.
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
