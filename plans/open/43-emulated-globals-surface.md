# Plan 43 — Emulated n8n-globals surface: declared types ⇄ `run`, `test` as the fidelity backstop

**Status:** Not started
**Priority:** P2 (the `run` fidelity + boundary docs) — split **P3** for the
optional `types` refresh command (Task 5) and the `.d.ts` de-dup (Task 4).
**Source:** consolidates **draft 43** (`n8n-globals.d.ts` sourcing) + **draft
44** (`run`'s faked-context parity); both were "backlog item" origin. Merged in
favour of the lower number per [`plans/AGENTS.md`](../AGENTS.md) — **number 44 is
retired.** Closes the PLAN.md "run faked-context" fidelity gap.
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1
**Theme:** There is **one** "supported n8n-globals" surface; today it lives in
three places that drift — the shipped `n8n-globals.d.ts`, `run`'s `buildGlobals`
([lib/run.mts:114](../../lib/run.mts#L114)), and n8n itself. Define it once, make
the **declared** types and the **emulated** runtime agree, and where local
emulation can't reach fidelity, **signpost `test`** (the MCP `test_workflow`
real-instance run) instead of failing with a bare `ReferenceError`.

## Why

Two drafts were tracking two halves of the same surface:

- **`run`'s emulation drifts from n8n (was draft 44).** `buildGlobals` wires
  `$jmespath` to *throw* ("not implemented in `run`")
  ([lib/run.mts:164](../../lib/run.mts#L164)) even though it's one of the stable
  Code-node globals the project already treats as core (it ships in
  `n8n-globals.d.ts:80`). A node using `$jmespath` — common in data-shaping
  nodes — can't be `run` at all, and the failure only surfaces mid-run at the
  call site. Other real globals are simply **absent** (`$vars`, `$secrets`,
  `$ifEmpty`, `$evaluateExpression`, `$max`/`$min`; `$('Node').item` isn't the
  per-item *linked* item in `runOnceForEachItem`; `$runIndex`/`$itemIndex`
  pinned at 0), so those nodes hit an opaque `ReferenceError`. Meanwhile
  `docs/cli/node-run.md` sells it as "executes a node's body against a faked n8n
  context" with **no list of what is covered vs. absent**.
- **The declared surface is duplicated (was draft 43).** `n8n-globals.d.ts` is a
  hand-written "pragmatic subset" shipped in `template/` as a **byte-identical
  copy** of the repo root file (verified 2026-07-23: both 6670 bytes, identical)
  → two copies that can drift, guarded only by an e2e content-match assertion
  ([test/e2e.mts:509](../../test/e2e.mts#L509)).

Fixing one without the other just relocates the drift: implement `$jmespath` in
`run` but leave the `.d.ts` and the boundary docs behind, and the three surfaces
diverge again. **One plan, one guarantee: declared == emulated, boundary
documented once.**

## The MCP reality reframes the fidelity goal

This is the key shift since drafts 43/44 were written. Post-Plan-32/33 the
verification ladder has **three rungs**, and the top rung is real-instance
execution:

| Verb | Where it runs | Global fidelity |
| --- | --- | --- |
| `node run` | offline, one node body, faked `buildGlobals` | **approximate** |
| `simulate` | offline, whole-workflow replay of scenarios/captures | approximate |
| `test` | **real n8n draft** over MCP `test_workflow` | **exact** |

Pre-pivot, `run`/`simulate` local emulation was the *only* way to execute a node
offline, so an emulation gap (`$jmespath` throwing) was a **dead end**. Post-pivot,
`test` is the fidelity backstop — so `run`'s job is **not** to chase n8n's full
runtime. Its job is to be the **fast offline approximation**, and the plan's real
target becomes:

1. **Emulate the cheap, *pure* globals** that have a well-defined offline meaning
   (`$jmespath`, `$if`/`$ifEmpty`, `$min`/`$max`, `$items`/`$node` views over the
   fixture) so the common offline node just works; and
2. **Make the boundary a signpost to `test`** — a global whose value is
   genuinely instance-scoped (`$vars`, `$secrets`, live linked items, real
   `$execution` ids) should fail with a friendly *"not emulated in `run` — use
   `test` to run against the real instance, or pin it in the fixture"*, never a
   bare `ReferenceError`.

So we deliberately **do not** try to emulate instance state. `test` over MCP is
the escape hatch; `run` stays honest about its edges.

## Source

- Draft 43 — `n8n-globals.d.ts` sourcing (backlog item): de-dup + optional
  refresh command.
- Draft 44 — `run`'s faked context parity (backlog item), deferred severity
  "moderate": `$jmespath`, missing globals, undocumented boundary.
- **Relates to** [Plan 31](31-run-sandbox-boundary.md) — the sandbox/isolation
  boundary. This plan is the *inside* of that boundary (the emulated-global
  surface); Plan 31 line 151 already lists "changing the emulated-global
  surface" as its own **non-goal**, so the two are complementary by design.
- **Relates to** [Plan 47](../draft/47-run-from-execution.md) — a `run` *fixture
  source*, an orthogonal axis (where input comes from, not how faithfully
  globals are emulated).
- **Relates to** [Plan 30](30-agent-llm-working-ergonomics.md) — treats
  `n8n-globals.d.ts` as *the decanter authoring contract* agents read; keeping it
  single-source and current serves that.
- **Sibling to** [Plan 52](52-remove-watch-browser-reload-proxy.md) — both are
  *"the MCP/n8n-native reality reshapes a decanter hand-rolled layer."* Plan 52
  **deletes** the `watch` proxy (n8n reflects MCP edits natively, so it's
  redundant); this plan **keeps but reframes** `run`'s emulation, because `run`
  fills an offline niche n8n has no native answer for (see Non-goals). **Execute
  Plan 52 first** — it strips `browserReload`/proxy from `config`/`PLAN.md`/
  `test/e2e.mts`/docs that this plan also edits, so 43 lands on the leaner base.

## Tasks

1. **(P2) Emulate the pure, stable globals in `buildGlobals`.**
   - **`$jmespath` (confirmed by research — implement directly):** depend on
     `jmespath@0.16.0` (the exact version n8n pins), call `search(data, expr)`
     (data-first), and bind **both** `$jmespath` and the `$jmesPath` alias.
     Wire it like `luxon` is today ([lib/run.mts:137](../../lib/run.mts#L137)).
     Skip n8n's security guard — that's Plan 31's sandboxing concern, irrelevant
     to offline `run`.
   - Add the other cheap pure globals that have a clear offline meaning — the
     `$items(nodeName, …)` / `$node` / `$item` views that are just alternate
     shapes over the fixture's `nodes` map already built in `buildGlobals`.
   - **Reconcile the candidate list against the authoritative source before
     emulating.** The research names `WorkflowDataProxy.getDataProxy()`
     (`n8n-workflow/src/workflow-data-proxy.ts`) as ground truth. Some globals
     the shipped `.d.ts` currently declares (`$if`, `$min`, `$max`) are n8n
     *expression-language extensions*, **not** necessarily Code-node runtime
     globals — verify each against the proxy base before adding it (and fix the
     `.d.ts` if it over-declares; that's the "one surface" payoff).
   - Keep `$runIndex`/`$itemIndex` pinned at 0 (single-item `run`) but **say so**
     (Task 3), rather than leaving it implicit.

2. **(P2) One friendly boundary for un-emulatable globals.**
   - A central helper that, for a genuinely instance-scoped global (`$vars`,
     `$secrets`, live per-item `$('Node').item` linking, real `$execution`
     ids/`$evaluateExpression` if the expression engine isn't emulated), throws a
     consistent message: names the global, and points to **`test`** (real
     instance over MCP) *or* the fixture field that would satisfy it. Replaces
     the ad-hoc `throw new Error("$jmespath is not implemented …")` and the bare
     `ReferenceError`s.
   - Decide per global: *emulate* (Task 1), *pin from fixture* (already the model
     for `$env`/`nodes`), or *signpost `test`* — and encode that decision in one
     table the helper and the docs share.

3. **(P2) Document the emulated-vs-unsupported boundary.**
   - `docs/cli/node-run.md`: a **covered / partial / unsupported** table of globals
     and the "when emulation isn't enough, escalate to `test`" rule. Stop selling
     `run` as a faithful n8n context without stating its edges.
   - Docs-drift rule: reflect any surface change in `README.md` + the
     [docs overview](../../docs/cli/overview.md), and add a CHANGELOG
     `[Unreleased]` entry.

4. **(P3) De-dup the declared `.d.ts` (was draft 43, part 1).**
   - Have `init` copy the single root `n8n-globals.d.ts` instead of the static
     `template/n8n-globals.d.ts.example` duplicate — one source of truth. Adjust
     the e2e template content-match assertion
     ([test/e2e.mts:509](../../test/e2e.mts#L509)) accordingly. (Keep the
     `.example` suffix convention for anything that *stays* a template file.)

5. **(P3) Drift-audit, not an auto-refresh command — the research settled this.**
   - The draft's original idea (an `n8n-decanter types` command that regenerates
     `n8n-globals.d.ts` from an official source) is **dropped**: the only official
     source is **SUL-licensed**, so extracting-and-shipping its text would import
     fair-code content into decanter's MIT template (see *Sourcing options*).
   - Instead: **keep the hand-written MIT-clean subset** and add a lightweight
     **drift-audit** that *reads* n8n's editor-ui `type-declarations/` (or
     `WorkflowDataProxy`) at a **pinned git tag** purely as a reference to flag
     **newly-added globals we don't declare** — without copying any text. Resolve
     the path per tag (it already drifted `packages/editor-ui/…` →
     `packages/frontend/editor-ui/…`), so don't hardcode it. This folds into the
     existing root ⇄ `template/` `.d.ts` check (Housekeeping step 7).

## Sourcing options — what official tools exist (deep-research, 2026-07-23)

Findings from a fan-out/adversarial-verify research pass (23/25 claims confirmed,
all on primary `github.com/n8n-io` + npm sources). Headline: **no official
standalone drop-in exists for any of the three needs — and the sources that *do*
exist are Sustainable-Use-Licensed (SUL), not MIT, which is the deciding
constraint for a redistributable CLI.**

- **Q3 — `$jmespath` (green light).** n8n's `$jmespath(data, expr)` maps
  **exactly** onto the stock `jmespath` npm package's `search(data, expr)`:
  same data-first argument order, **no** fork, **no** custom operators. n8n pins
  `jmespath@0.16.0` and wraps it only in a thin security guard (rejects some
  property tokens, shallow-copies object input); it also binds a `$jmesPath`
  alias. → **Task 1 is safe:** depend on `jmespath@0.16.0`, call
  `search(data, expr)`, bind both `$jmespath` and `$jmesPath`. The security guard
  is a sandboxing concern (Plan 31's territory), not needed for offline `run`.
  *(Sources: `packages/workflow/src/workflow-data-proxy.ts`,
  `packages/workflow/package.json`, docs.n8n.io/code/builtin/jmespath.)*
- **Q1 — declared types.** Real static `.d.ts` files for the runtime globals
  **do exist and are git-trackable**: `globals.d.ts`, `n8n.d.ts`,
  `n8n-once-for-all-items.d.ts`, `n8n-once-for-each-item.d.ts` (+ newer
  `*-combined.d.ts`) under the editor-ui `.../codemirror/typescript/worker/
  type-declarations/` dir (PR #12285). **But three catches:** they're **bundled
  in a frontend package, not published on npm**; they're **SUL-licensed**; and
  they're **hybrid** — the static shape is augmented at runtime by per-workflow
  generated types (`dynamicTypes.ts`), so a static extract is only a subset. The
  *authoritative implementation* of the sugar is the **`WorkflowDataProxy`**
  class in the `n8n-workflow` package (`packages/workflow/src/
  workflow-data-proxy.ts`) — its `getDataProxy()` base defines `$input`, `$json`,
  `$binary`, `$env`, `$evaluateExpression`, `$item`, `$items`, `$node`,
  `$parameter`, `$now`, `$today`, `$jmespath`/`$jmesPath`, `$workflow`,
  `$getPairedItem`, `$position`; `$vars`/`$secrets` are merged in from n8n-core's
  `getAdditionalKeys` (i.e. genuinely instance-scoped — they belong on the
  *signpost `test`* side, Task 2).
- **Q2 — local engine.** `@n8n/task-runner` is the real Code-node engine
  (version-pinnable, executes user JS via `node:vm`) — **but it's SUL-licensed
  and architecturally welded to a websocket task broker** (constructor opens a
  broker socket, pulls input over a round-trip). The "it's just `node:vm`, so
  it's a standalone path" claim was **refuted 0-3.** → **No clean local-engine
  adoption.** MCP `test_workflow`/`execute_workflow` on the real instance stays
  the only realistic high-fidelity route — which is exactly this plan's
  *escalate-to-`test`* reframe.
- **Dead ends for a *type file / engine*:** n8n-mcp (third-party, node-schema
  surface) and `codemirror-lang-n8n` (expression-language grammar) ship **no**
  runtime-globals types and **no** local engine.
- **n8n-io/skills — NOT a dead end for us (the useful one).** It ships no `.d.ts`
  and no engine, but its **`n8n-code-nodes-official`** + **`n8n-expressions-official`**
  skills document the common globals surface in prose + examples (`$input.all()/
  .first()/.item`, `$('Node').all()/.item`, `$itemIndex`, the two Code modes, the
  `{json:…}` return shape, Luxon `DateTime`) — and it is **Apache-2.0**, i.e.
  *permissive / MIT-compatible*, unlike every SUL source above. So it is the
  **licence-cleanest reference to hand-mirror from** — readable *and quotable*.
  Caveat: it's illustrative, not an exhaustive enumeration (no `$vars`/`$secrets`/
  `$getWorkflowStaticData` listing), so `WorkflowDataProxy` stays the completeness
  cross-check.

**Deciding constraint — licensing.** Both the editor-ui `.d.ts` and
`@n8n/task-runner` are **SUL / fair-code, not MIT**. Extracting n8n's `.d.ts`
text and shipping it in decanter's `template/` would import SUL-licensed content
into an otherwise-MIT tool — so an **automated extract-and-ship `types` command
is *not* advisable.** decanter's hand-written `n8n-globals.d.ts` is its *own*
MIT-clean paraphrase; that's a feature, not debt. **`n8n-workflow` itself (home of
`WorkflowDataProxy`) is also SUL** (confirmed 2026-07-23: package.json
`LicenseRef-n8n-sustainable-use`; repo-root LICENSE.md = Sustainable Use License
v1.0), so *vendoring* the real globals logic is ruled out too — **hand-mirroring
is the only licence-clean path, and there is no open decision here.** n8n source
serves only as a read-only *reference* to mirror from (Task 5's drift-audit).

**Mirror map — what to read, what to write (for the executing agent).** The
hand-mirror is agent-executable: "hand" means *authored, not auto-copied*, and an
agent writing decanter's own paraphrase satisfies that (license-clean as long as
it authors decanter's code, never pastes n8n's).

- **Write (decanter's own, MIT) — the two files kept in agreement:**
  `n8n-globals.d.ts` (declared surface) and `buildGlobals` in
  [lib/run.mts](../../lib/run.mts#L114) (emulated behavior). The parity test
  (Acceptance) enforces the agreement.
- **Read (reference only, never copy):** primarily one n8n file —
  `packages/workflow/src/workflow-data-proxy.ts` → `getDataProxy()` for the
  authoritative global *surface* (read at a pinned tag); plus n8n-io/skills
  `n8n-code-nodes-official` + `n8n-expressions-official` (**Apache-2.0**, quotable)
  for behavior/examples.
- **Scope of the mirror:** the *surface* (which globals exist + their signatures)
  and the *pure/cheap* semantics **only** — NOT the full proxy engine
  (paired-item graph traversal, expression resolution). Anything that would need
  the engine is a *signpost `test`* case (Task 2), not something to port.

## Acceptance / verification

- **Parity guarantee (the whole point):** a test asserts **every** global the
  reconciled `n8n-globals.d.ts` declares is *accounted for* in `buildGlobals` —
  each one either emulated (Task 1), pinnable from the fixture, or present as a
  friendly-throwing signpost (Task 2). Nothing declared may fall through to a
  bare `ReferenceError`, and `buildGlobals` provides nothing the `.d.ts` doesn't
  declare. That two-way closure is the "one surface" invariant.
- A node using `$jmespath` **runs offline** and matches n8n's result on a known
  fixture case.
- An unsupported/instance-scoped global produces the **friendly, `test`-pointing
  message** (unit test), not a `ReferenceError` or the old bare throw.
- `docs/cli/node-run.md` carries the boundary table; `README.md` + overview + CHANGELOG
  updated per the docs-drift rule.
- After Task 4, the `.d.ts` `init` ships is sourced from the single root file (no
  byte-identical duplicate); e2e stays green.

## Non-goals

- **Deleting `run`'s emulation the way [Plan 52](52-remove-watch-browser-reload-proxy.md)
  deletes the proxy.** Tempting to apply the same "n8n does it natively → drop the
  hand-rolled layer" rule — but it doesn't hold here. The proxy was *redundant*:
  n8n does the identical thing (reload the open editor) in the identical place.
  `run` is *not* — its fidelity backstop `test` needs a **live instance + network**,
  whereas `run` is the **offline / no-instance / CI** path nothing else fills.
  Hand-mirroring `run`'s surface is justified by a niche the proxy never had, so
  the answer is *reframe* (defer fidelity to `test`), not *delete*.
- **Sandboxing `run`** — that's [Plan 31](31-run-sandbox-boundary.md); this plan
  is the emulated-global *surface* inside that boundary, not the isolation
  mechanism.
- **`run --from-execution`** fixture loading — [Plan
  47](../draft/47-run-from-execution.md).
- **Emulating instance-scoped state** (`$vars`/`$secrets` *values*, live linked
  items, real execution ids) — `test` over MCP is the fidelity path; here we
  signpost, not emulate.
- Full expression-engine parity for `$evaluateExpression` (signpost unless the
  research surfaces a cheap standalone evaluator).

## Notes

- **CHANGELOG** (`[Unreleased]`): `$jmespath` now works in `node run`; clearer
  "not emulated in `run` — use `test`" messages for instance-scoped globals.
- **New dependency:** `jmespath@0.16.0` (+ `@types/jmespath`) — pin to n8n's
  exact version for byte-faithfulness; small, pure-JS, MIT.
- **PLAN.md:** update the `run` faked-context description (the `buildGlobals`
  paragraph) to state the emulated-vs-unsupported boundary and the `test`
  escalation — PLAN.md must not keep implying `run` is a faithful context.
- **docs:** `docs/cli/node-run.md` boundary table. No new verb → no overview
  command-surface change (Task 5 is an internal drift-audit, not a CLI command).
- **Split delivery:** Tasks 1–3 (P2) are the valuable, mostly-offline core and
  can land first; Tasks 4–5 (P3) — the `.d.ts` de-dup and the drift-audit — are
  a lower-value tail that can follow independently.
