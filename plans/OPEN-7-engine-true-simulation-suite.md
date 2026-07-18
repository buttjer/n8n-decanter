# Plan 7 — Engine-true simulation suite

**Priority:** P3 (spike may promote the rest; blocked on Plan 3 C for fixtures)
**Status:** Not started
**Theme:** replay a whole workflow through the *real* n8n engine offline —
network nodes pinned with captured execution data (LLM-guessed fixtures fill
the gaps), side-effect-free nodes executing for real — with a hard guarantee
that nothing external is written.

## Why

Today's confidence tools stop short of the engine. `run` (`lib/run.mts`)
executes a single Code node against a hand-built fake of the n8n globals — the
`$('…')` refs, item pairing, and run modes are approximations. `npm test` mocks
the n8n *API*, so it proves sync fidelity, not workflow behavior. Nothing
answers "does this workflow, with my edited Code nodes, still behave the same?"
the way n8n itself would answer it — connection traversal, expression
evaluation, `runOnceForEachItem` semantics, paired items.

The backlog item asks exactly that: can we execute the workflow with the n8n
engine, feeding captured executions data as the mock, dry — no API writes, no
side effects. The payoff is an engine-true regression check: edit a Code node,
replay the workflow against a captured execution, diff the outputs.

## Source

- [Plan 0](BACKLOG.md): "**Engine-true simulation suite** — real e2e test or
  simulation suite: is there a way to really execute the workflow with the n8n
  engine using executions data as a mock/dry run? Also making sure nothing is
  really written through APIs or similar. Keep in mind executions data can be
  flawed or change in the future."
- Depends on [Plan 3](OPEN-3-local-run-and-diff-fidelity.md) task C (execution
  datasets pulled to `workflows/<Name>/executions/<execId>.json`) as the
  fixture source; the spike can start from one hand-captured execution JSON.

## Design decision — how to get a real engine

Three candidate routes; the workflow transform in task 2 is shared by A and B,
so it can be built before the route is final.

- **A. In-process engine embed.** Dev-depend on `n8n-workflow` + `n8n-core`,
  instantiate `WorkflowExecute` with a custom `INodeTypes` registry: the real
  implementations for Code and pure nodes plus a synthetic "replay" node type
  that returns pinned items for network nodes.
  - Pros: fast, in-process, no Docker, debuggable.
  - Cons: `n8n-core`'s embedding surface is effectively internal and shifts
    across releases; the Code node needs `n8n-nodes-base` (huge) and newer n8n
    runs it via task runners; version skew vs the user's instance is on us.
- **B. Workflow transform + real n8n (`n8n execute`), in Docker.** Rewrite a
  *copy* of the workflow: materialize `//@file:` placeholders into real code
  (reusing `buildNodeCode` from `lib/push.mts`); keep side-effect-free nodes
  (Set, IF, Switch, Merge, Filter, …) intact so they *really* execute; replace
  every network/side-effectful node — anything credentialed, HTTP, DB,
  messaging, or of unknown type (default-deny) — in-place with a node
  returning its pinned items (same name and connections, so `$('…')` and
  expressions still resolve); swap the trigger for a Manual Trigger. Then run it on the n8n image pinned to the
  instance's version, `--network none`, no credentials mounted. n8n 1.x
  removed `execute --file`, so the in-container flow is
  `n8n import:workflow --input=sim.json && n8n execute --id=<id>` against the
  container's throwaway SQLite (import deactivates workflows by default —
  a free extra safety layer). Code node runs via internal-mode task runners
  (loopback broker, works under `--network none`) or in-process with
  `N8N_RUNNERS_ENABLED=false`.
  - Pros: engine-true by construction on *any* n8n version (pull the matching
    image); the no-side-effects guarantee is structural (no I/O-capable node
    remains) *and* enforced (no network); no fragile internal APIs.
  - The engine backend is pluggable, Docker is not required: default to
    `npx n8n@<ver>` with `N8N_USER_FOLDER` in a scratch dir (throwaway
    SQLite/config, per-run version pinning, keeps n8n out of the decanter's
    own dependency tree); Docker `--network none` is the opt-in hard-isolation
    mode (CI). Without Docker the no-side-effects guarantee is structural +
    sandbox-config (empty task-runner stdlib allowlist, telemetry/version
    fetches disabled via env), not a physical network cutoff.
  - Cons: heavy engine install either way (npx cache or image, native sqlite
    bindings, first-boot DB migrations); slower per run; output has to be
    scraped from `n8n execute`'s result JSON.
- **C. Grow `lib/run.mts` into a graph walker.** Already deferred by Plan 3
  (`run --chain`). **Rejected as the answer to this item** — it approximates
  the engine, which is precisely what the item wants to stop doing.

**Leaning B**, with A as the fallback if the spike shows the Docker round-trip
is too slow or `n8n execute`'s output too lossy for diffing. Decision gets
recorded here (and raised for PLAN.md) after task 1.

## Tasks

1. **Spike (timeboxed).** Hand-capture one execution
   (`GET /executions/{id}?includeData=true` → `data.resultData.runData`) from
   the live instance. Manually build the transformed workflow for one real
   workflow and run it through route B via the npx backend (`npx n8n@<ver>`
   with scratch `N8N_USER_FOLDER`, `import:workflow` + `execute --id`, see
   above); note wall time (first-boot SQLite migrations!), install weight,
   output shape, task-runner behavior (incl. whether sandboxed code can reach
   the network at all — `fetch` availability), and version pinning ergonomics.
   Sanity-check the same flow once under Docker `--network none`. Probe
   whether `n8n execute` honors native `pinData` in CLI mode — if yes, pinning
   network nodes can use the workflow's own `pinData` field (node stays
   intact, credentials still stripped) instead of node replacement; if not
   (pin data has historically been manual-mode-only), replacement it is. Skim
   route A's surface (`WorkflowExecute` constructor + `INodeTypes`) enough to
   price it. Record the route decision above.
2. **`lib/simulate.mts` — fixture loader + transform.**
   - Node classification: a maintained allowlist of side-effect-free node
     types executes for real; everything else is a **network node** and gets
     pinned. **Default-deny:** a node type not on the allowlist is treated as
     network — safety never depends on knowing the type.
   - Loader: read `workflows/<Name>/executions/<execId>.json`, validate the
     `runData` shape defensively (the item's caveat: executions data can be
     flawed or change format across n8n versions). A network node with no
     captured run data and no stored fixture is a **hard error** listing the
     nodes (and pointing at `--fill-gaps`, task 3); disabled nodes and untaken
     branches are exempt.
   - Transform: produce the simulation copy per route B above. Refuse to emit
     if any surviving executable node is outside the pure allowlist, and strip
     `credentials` from every node — the structural half of the dry-run
     guarantee.
3. **LLM gap filling (`--fill-gaps`).** For pinned nodes with no captured
   output (untaken branch, node added or reparametrized since the capture),
   ask an LLM for an educated guess: prompt from the node's type + parameters
   plus adjacent captured items as few-shot examples. Write the result to
   `workflows/<Name>/fixtures/<Node>.json` with provenance
   (`"source": "llm-guess"`, model, date, node-params hash) — reviewable and
   hand-editable, and loaded like any capture thereafter. Generation is the
   only online step; simulate runs stay offline and deterministic. Warn when a
   fixture's params hash no longer matches the node (stale guess).
4. **`simulate` verb.** `n8n-decanter simulate <id|dir> --execution <execId>`
   in `n8n-decanter.mts` (register in `VERBS`): transform to a temp file, run
   the engine per the chosen route, print per-node item counts, and diff each
   Code node's simulated output against the captured execution's output for
   that node. Divergence → nonzero exit (this is the regression check); a
   `--json` report for tooling.
5. **Isolation.** npx backend: scrubbed env (no `N8N_*` credentials/env leak
   in), `N8N_DIAGNOSTICS_ENABLED=false` + version-notification/template
   fetches off, empty `N8N_RUNNERS_STDLIB_ALLOW`. Docker backend adds the
   enforced `--network none` cutoff. Engine version pinned via a new optional
   `decanter.config.json` field (e.g. `"n8nVersion"`) since the public API
   doesn't expose the instance version (see the `n8n-globals.d.ts` backlog
   item's findings).
6. **Tests.** The transform and fixture loader/validation are offline — cover
   them in `test/e2e.mts` (mock server grows nothing new beyond Plan 3 C's
   executions handler). The actual engine run needs a real n8n (npx
   download or Docker), which the e2e sandbox can't assume: put it behind an
   opt-in `npm run test:sim` that skips cleanly when no engine is available.

## Acceptance / verification

- `simulate` replays a captured execution through a real n8n engine — pure
  nodes executing genuinely, network nodes pinned — with no credentials
  present and no outbound-capable nodes (zero network enforced in the Docker
  mode), and exits 0 when Code-node outputs match the capture.
- Deliberately breaking a Code node locally makes `simulate` exit nonzero with
  a readable per-node diff.
- A network node without capture or fixture fails up front with the list of
  unpinnable nodes — never a half-real run; with `--fill-gaps` the guessed
  fixture is written with provenance, then used like a capture.
- The transform never emits a workflow containing an off-allowlist executable
  node or a `credentials` block (asserted in `test/e2e.mts`).
- `npm test` stays green without Docker; `test:sim` passes where Docker exists.

## Non-goals

- Simulating external services beyond replaying captured or LLM-guessed
  outputs (no live HTTP mocking layer, no credential faking).
- Live trigger semantics (webhook payload capture, schedule timing) — the
  trigger is always swapped for a Manual Trigger fed by the capture.
- Treating captured executions as ground truth — they're convenience fixtures
  that age (LLM guesses doubly so, and they're marked as such); the diff tells
  you "changed vs the capture", not "wrong".
- Replacing single-node `run` (Plan 3) — that stays the fast inner loop; this
  is the slower outer confidence check.

## Notes

- **Ordering:** trails Plan 3 (needs its executions capture); only the spike
  is worth pulling forward.
- **CHANGELOG:** `simulate` verb (incl. `--fill-gaps`), `test:sim`, and the
  `n8nVersion` config field are user-facing — Added entries under
  `[Unreleased]` when they land.
- **PLAN.md:** a new verb, a config field, the `workflows/<Name>/fixtures/`
  artifact, and consumption of `executions/` all touch the design doc — raise
  with the user before landing (per `CLAUDE.md`), including the route decision
  from task 1.
- **LLM dependency (first in the CLI):** gap filling needs an API key (env,
  e.g. `ANTHROPIC_API_KEY`) and is the only online step — absent key, `simulate`
  still works with captures/fixtures and hard-errors on gaps. The prompt/client
  plumbing should be shaped for reuse by the backlog's "LLM semantic
  validation" item.
- **Allowlist maintenance:** the pure-node allowlist is a curated, versioned
  list; misclassifying a node as pure would execute it for real, so additions
  need justification. Default-deny carries the safety, not the list.
- **Licensing:** n8n's Sustainable Use License permits running it for internal
  testing like this; we never redistribute engine code.
- **Fixture drift caveat (from the item):** loader validation is intentionally
  strict and version-aware — record the producing n8n version inside the
  fixture file when Plan 3 C writes it, and warn on mismatch with
  `n8nVersion`.
- **Known fidelity risks (spike must probe both):** replay Code nodes should
  emit `pairedItem` from the capture, or downstream `$('…').itemMatching()` /
  item-linking expressions may fail; binary data in captures is often a
  filesystem reference, not embedded — workflows with binary payloads may be
  out of scope for v1 (declare in Non-goals if so).
