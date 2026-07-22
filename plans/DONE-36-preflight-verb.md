# Plan 36 — `preflight` verb: the whole verification ladder as one scored gate

**Priority:** P2 (flagship differentiator; real design surface — orchestration,
scoring semantics, and a safety contract worth getting exactly right)
**Status:** Done (shipped 2026-07-23)
**Model:** Opus (safety contract + scoring/verdict semantics; the docs
propagation tasks can drop to Sonnet)
**Theme:** One command that runs **every safe check there is** — local static →
instance read-only → pinned draft runs — ordered fast-to-slow, and condenses
them into a scored, CI-gateable verdict with actionable feedback for humans
*and* agents. Nothing it does can touch the published version or the outside
world.

## Why

- **The vocabulary already exists; the verb doesn't.**
  [Plan 34](DONE-34-post-pivot-identity-and-messaging.md) coined **"preflights"**
  as the umbrella for `check`/`simulate`/`test` — scoped 2026-07-22 to
  *marketing/docs vocabulary only*, with the verb parked in
  [DECISIONS-NEEDED](DECISIONS-NEEDED.md). **Maintainer go-ahead 2026-07-22:
  build it** — this plan is the unparking, extended beyond the parked sketch
  with scoring, staged execution, and executions integration.
- **Today the ladder is manual and unaggregated.** Answering "is this workflow
  ready to publish?" takes four commands (`check`, `executions`, `test`,
  `simulate`), each with its own defaulting rules, and still yields no single
  verdict. Agents especially need one structured gate before `push`/`publish` —
  today they must orchestrate the ladder themselves and interpret four output
  formats.
- **Safety is the headline property, and it comes free.** Every stage already
  is safe by construction (offline, read-only, or pinned draft run).
  `preflight` adds **zero new execution paths** — it only orchestrates and
  scores existing ones, so the safety argument reduces to the per-stage
  arguments already made in Plans 7 and 33.

## Source

- [DECISIONS-NEEDED](DECISIONS-NEEDED.md) — "`preflight` verb — group
  `check`/`simulate`/`test` under one gate?" (2026-07-22). **Resolved by this
  plan** (entry removed; each cost it flags is answered in Design below:
  verb-surface growth → a real ref verb in the Plan 27 grammar; overlap with
  `push`'s gates → preflight *contains* them, `push` keeps its own; fixture
  selection → same defaulting as `test`/`simulate` plus auto-fetch; real verb
  vs alias → **real verb** — orchestration, skip logic, and scoring are new
  behavior, not a shell alias).
- [Plan 34](DONE-34-post-pivot-identity-and-messaging.md) — coins the term and
  names the extension slot ("the preflight card then points at one verb").
  Coordination only; Plan 34's copy tasks pick the verb up once it lands.
- User direction (2026-07-22): staged fast→slow, use *all* local + instance-MCP
  options, produce a validation **score**, bring **executions** into the game,
  breakable with good feedback for AI and user, and **totally safe**.
- Distinctive-features class: neither n8n nor generic git-sync has a scored,
  capture-grounded pre-publish gate — new
  [Plan 0](BACKLOG.md) distinctive-features entry at landing (as
  DECISIONS-NEEDED prescribed for adoption).

## Design

### The ladder — every check, fast → slow

Stable check ids (agents key on them). Reuse column names the real machinery —
no stage builds a new execution path.

| Tier | Check | What it verifies | Machinery (reuse) | Can produce |
| --- | --- | --- | --- | --- |
| **static** (offline, ms) | `layout` | compliance guard: placeholders, connections, dup names/ids, orphans, `$('…')` refs | `validateWorkflowDir` ([lib/validate.mts](../lib/validate.mts)) | fail / warn |
| | `types` | typecheck of node files (function-body wrap) | `runTypecheck` ([lib/validate.mts](../lib/validate.mts)) | fail |
| **sync** (instance read-only, seconds) | `connect` | MCP reachable, auth valid (exercises OAuth refresh) | first `McpClient` call, timed ([lib/mcp.mts](../lib/mcp.mts)) | fail |
| | `access` | workflow `availableInMCP` | `getWorkflowDetails` / `isUnavailableInMcp` | fail |
| | `parity` | local code == draft code (names the *subject* of the runtime verdict) | per-node hashes vs remote, as in `statusWorkflow` ([lib/status.mts](../lib/status.mts)) | warn |
| | `drift` | remote moved off `lastPushedHash` | `statusWorkflow` node states | warn ("changed remotely — pull") / **fail on CONFLICT** (changed both) |
| | `snapshot` | structure snapshot current | `workflowStructureHash` compare (status machinery) | warn |
| | `lifecycle` | draft vs published version, unpublished state | `publishedVersionLagsDraft` ([lib/util.mts](../lib/util.mts)) | info |
| | `history` | recent production runs: error rate, last error, recency | MCP `search_executions` (spike, Task 3) with REST `listExecutions` fallback | warn |
| | `capture` | a capture/mock exists for pinning; capture version matches the draft | `latestCaptureId` / `warnStaleFixtures` ([lib/executions.mts](../lib/executions.mts)) | warn / skip-gates-runtime |
| **runtime** (executes, minutes) | `test` | pinned run **on the instance's engine**, per-node diff vs capture | `runTest` → `TestReport` ([lib/testrun.mts](../lib/testrun.mts)), dedicated ≥320 s client | fail (divergence, engine error, 5-min cap) |
| | `simulate` | pinned replay on a **local** engine, per-node diff | `runSimulate` ([lib/simulate.mts](../lib/simulate.mts)), headless | fail |

Checks stream as they complete (existing style layer), so a fast red surfaces
in the first second even when the runtime tier takes minutes. `--fail-fast`
stops at the first fail; default always completes the card.

### Profiles — deterministic, no magic escalation

| Invocation | Tiers | Wall time | For |
| --- | --- | --- | --- |
| `preflight --quick` | static + sync | seconds | every-edit loop, pre-commit |
| `preflight` (default) | static + sync + `test` | ≤ ~6 min worst case | the pre-publish gate |
| `preflight --full` | default + `simulate` | + engine boot | maximum coverage; verifies *local* code too when parity warns |
| `preflight --offline` | static + `simulate` | no instance contact at all | air-gapped CI (committed mocks/fixtures) |

An **auto-escalation** variant (run `simulate` only when it adds signal —
parity warn or `test` skipped) was considered and **rejected**: nondeterministic
wall time and surprise Docker boots are worse than one explicit `--full`. Every
skipped stage prints its reason and the unlock (`simulate: skipped — pass
--full`), so nothing is silently narrower than it looks.

### Executions are the ground truth (the user's "bring executions into the game")

1. **Pins and diffs** (existing): captures are what `test`/`simulate` pin from
   and diff against.
2. **Auto-fetch** (new): before the runtime tier, `preflight` fetches the
   newest capture (`fetchExecutions`, REST, gitignored) when `N8N_API_KEY` is
   present and the local capture is missing or stale — so a bare `preflight`
   "just works" and runtime stages verify against *fresh* reality. Read-only;
   `--no-fetch` disables; without a key it skips with guidance.
   `--execution <id>` / `--mock <slug>` / `--trigger <node>` pass through to
   the runtime stages exactly as in `test`/`simulate`.
3. **History as a health signal** (new): the `history` check reads the last N
   (default 20) production executions — error rate, most recent failure,
   recency — and feeds the score. The live workflow failing is a *warn*
   (publish-onto-a-failing-workflow deserves a caution), never a fail — the
   draft isn't guilty of the past.
4. **Freshness honesty** (existing machinery, now scored): the `capture` check
   surfaces when pins predate the current draft version.

### Scoring & verdict

- Per check: `pass / warn / fail / skip(reason, unlock) / info`, duration,
  message, **remediation** (the exact next command).
- **Verdict** (deterministic): any fail → **`not ready`** (exit 1); else any
  warn → **`caution`** (exit 0; `--fail-on=warn` promotes to 1); else
  **`ready`** (exit 0). Exit codes stay 0/1 only — house convention.
- **Score 0–100**, starting weights (tunable during execution, documented on
  the docs page): gate fails (`layout`, `types`, `test`, `simulate`) −40 each,
  `drift` CONFLICT −30, each warn −10; floor 0. The score is the trend line;
  the verdict is the gate.
- **Coverage is first-class honesty**: the card always says which checks ran
  vs skipped and why — a 100 with no runtime run reads `ready (static + sync
  only — no runtime preflight ran: no capture; run 'n8n-decanter executions'
  or pass --mock)`, never a bare green. `--require=test` (comma list of check
  ids) turns a skip of that check into a fail — the CI teeth for "must have
  runtime coverage".

### Report — for users and agents

Human card (shape, not final art — streamed lines above it):

```txt
preflight: order-sync   draft v41 · published v38 · capture #8231 (fresh)
  static    ✓ layout   ✓ types                                          0.6s
  sync      ✓ connect  ✓ access  ! parity  ✓ drift  ✓ snapshot  ! history  1.8s
  runtime   ✓ test — 14 nodes ran on the instance, all matched the capture  47s
score 80/100 · verdict: caution · 10/11 checks ran (simulate: pass --full)
  ! parity: local code differs from the draft — the runtime verdict covers the
    draft; run `n8n-decanter push order-sync` first, or `--full` to simulate local
  ! history: 2 of 20 recent runs failed (last 2026-07-21) — `n8n-decanter executions order-sync --status=error`
```

`--json` emits one document (precedent: `list`/`simulate`/`test`/`mock`):
workflow + subject (`draftVersionId`, `publishedVersionId`, `parity`), `checks[]`
(`id`, `tier`, `status`, `message`, `remediation`, `durationMs`), `score`,
`verdict`, `coverage` (`ran`, `skipped[] {id, reason, unlock}`), `profile`.
Stable ids + remediation strings are the agent contract; template `AGENTS.md`
teaches `preflight --json` as the pre-push/publish gate.

### Safety contract (headline — goes verbatim-ish into the docs page)

**`preflight` never mutates: no push, no publish, no restore, no draft write.**
Its only instance interactions are reads and the pinned draft `test` run.
Concretely:

- Unlike `test`'s TTY flow, `preflight` **never offers to push local code
  first** — a gate must not mutate what it gates, and CI/terminal behavior
  stay identical. The `parity` check + remediation covers the "but I wanted to
  test local" case; `runTest` is always invoked in its never-mutate mode.
- `test` stage: draft tip only, external touchpoints (trigger / network /
  credentialed nodes) pinned from the capture, **gap = abort before anything
  runs**, published version untouched (Plan 33's guarantees, inherited).
- `simulate` stage: throwaway container, default-deny pure-node allowlist,
  credentials stripped — and `preflight` runs it headless **with
  `--network-none` always on** (belt + braces; the viewer never applies here).
- sync tier: reads only. Auto-fetch is a read (`GET /api/v1/executions`), and
  captures land in the self-gitignored `executions/` dir.
- `node run` is **not** a stage (see Non-goals).

## Tasks

1. **`lib/preflight.mts` — registry, orchestrator, scorer.** A check registry
   (`id`, `tier`, availability probe, run fn → structured finding), profile
   selection, the scorer/verdict/coverage logic as **pure functions**
   (unit-testable without IO), and the card/JSON renderers. Findings carry
   `remediation` strings.
2. **Report-mode seams in the reused machinery.** `validateWorkflowDir`
   already returns `{errors, warnings}`; `runTypecheck` throws — wrap into
   findings. `statusWorkflow` ([lib/status.mts](../lib/status.mts)) computes
   parity/drift/snapshot/lifecycle facts but logs as it goes — extract or
   parameterize so `preflight` gets facts without duplicate printing.
   `runTest`/`runSimulate` already return reports (`TestReport`, simulate's
   `--json` path); invoke them log-quiet and consume the structures. Keep each
   seam a small refactor, no behavior change to the standalone verbs.
3. **`history` check + `search_executions` spike.** Preferred path: MCP
   `search_executions` (recorded as real on 2.30.7, currently unused — needs a
   wrapper in [lib/mcp.mts](../lib/mcp.mts) and a smoke-suite verification of
   its param/result shape, incl. whether `availableInMCP` gates it). Fallback:
   REST `listExecutions` when `N8N_API_KEY` is set — add a **lightweight
   variant without `includeData`** to [lib/api.mts](../lib/api.mts) (the
   current one always pulls full run data; a health probe must not). Neither
   available → skip with reason.
4. **Auto-fetch wiring.** Reuse `fetchExecutions`/`latestCaptureId`
   ([lib/executions.mts](../lib/executions.mts)): fetch when key present and
   capture missing/stale; `--no-fetch`; surface as part of the `capture`
   check's story.
5. **Dispatcher + surfaces.** `VERBS`/`REF_VERBS`/usage/`__complete` in
   [n8n-decanter.mts](../n8n-decanter.mts); flags `--quick --full --offline
   --json --fail-on --fail-fast --require --no-fetch` plus the `--execution/
   --mock/--trigger` passthroughs; **multi-ref** iteration per the
   `pull`/`push`/`status` loop pattern (no-ref TTY → picker via
   `pickOneWorkflow`; no-ref piped → all configured workflows, aggregate exit);
   `PICKER_VERBS` entry in [lib/picker.mts](../lib/picker.mts). The `test`
   stage reuses the dedicated ≥320 s-timeout client wiring.
6. **Tests.** Unit: scorer/verdict/coverage/profile selection + renderer
   snapshots (pure). E2e (mock server per the verify recipe — it already
   speaks `test_workflow`): full-ladder happy path, skip paths (no key, no
   capture, no Docker), `--json` shape, exit codes, `--require`,
   `--fail-on=warn`, CONFLICT drift → not ready. Smoke (opt-in): one
   `preflight` step against the real container + the Task 3
   `search_executions` shape verification.
7. **Docs + bookkeeping (all surfaces, one PR).** New `docs/cli/preflight.md`
   (ladder, profiles, scoring table, safety contract);
   [overview](../docs/cli/overview.md) command surface + safety table row +
   picker line; the "Preflights" sections in
   [test.md](../docs/cli/test.md)/[simulate.md](../docs/cli/simulate.md)/[check.md](../docs/cli/check.md)
   point at the one-command form; README `## Commands` + the preflights
   feature bullet + compare-table cell; CHANGELOG `[Unreleased]` Added;
   **PLAN.md** new design section (registry, profiles, scoring, safety
   contract); template `AGENTS.md` agent loop (`… → check → preflight →
   push`); [Plan 0](BACKLOG.md) distinctive-features entry. Housekeeping in
   this plan's own PR (already done if you're reading this): DECISIONS-NEEDED
   entry removed, Plan 34 cross-linked.

## Acceptance / verification

- One command runs the full available ladder fast→slow with streamed results,
  a score, a verdict, and per-finding remediation; `--json` carries the same
  under stable ids.
- **Safety:** in every profile, the only writes anywhere are gitignored local
  capture files; a wire-log of an e2e run shows reads + `test_workflow` only —
  no `update_workflow`, no `publish_workflow`, no REST mutation. TTY and CI
  behavior identical (never the push-local prompt).
- Skips are always explained with an unlock; `--require` turns a named skip
  into exit 1; `--fail-on=warn` promotes caution; otherwise exits are 0/1 per
  the verdict.
- A workflow with zero captures still gets a static+sync verdict labeled as
  such — and the label names the command that unlocks runtime coverage.
- Standalone `check`/`test`/`simulate`/`status` behave byte-identically to
  today (seam refactors are invisible).
- All Task 7 surfaces updated; verb greps clean per AGENTS.md.

## Non-goals

- **No `node run` stage.** Auto-running every Code node without per-node
  fixtures yields false reds; `run --from-execution` (the automation that
  would fix that) is a deliberately deferred backlog item, and
  [Plan 31](OPEN-31-run-sandbox-boundary.md)'s sandbox question makes
  auto-executing node bodies in the CLI process a safety regression besides.
  `node run` stays the inner-loop tool; preflight's runtime tiers use real
  engines with real pins.
- **No unpinned execution, ever — not even behind a flag.** A stage that lets
  network nodes fire would break the verb's one-line safety promise; that's
  what a human-driven `publish` + real run is for.
- **No server-side `validate_workflow` check on existing drafts.**
  `validate_workflow` takes an SDK *code string* ([lib/mcp.mts](../lib/mcp.mts)
  `validateWorkflowCode`); no workflow→code read exists, so there's nothing to
  feed it. Revisit if n8n grows one.
- **No LLM/semantic scoring.** The scorer is deterministic. The Plan 0 "LLM
  semantic validation" item stays separate — if it ever lands, the check
  registry is its natural opt-in slot.
- **No `push --preflight`/`publish --preflight` gating** in v1 — follow-up
  candidate once the verb has settled.

## Notes

- **Weights/thresholds are starting values** — deterministic and documented,
  tuned freely during execution; the verdict rules (fail→not-ready etc.) are
  the stable contract, the numeric score is presentation.
- **CHANGELOG:** Added — `preflight` verb (one scored gate over the
  verification ladder). PLAN.md gains the design section (Task 7); this is a
  new-surface plan, no breaking changes.
- **Recorded-fact dependencies:** `search_executions` shape unverified (Task 3
  spike); `test_workflow`'s server-side execution-record footprint worth one
  smoke assertion (does a test run appear in `search_executions`? If so, the
  `history` check should exclude test-mode runs).
- **Relation to [Plan 26](OPEN-26-npx-engine-backend.md):** when the npx
  backend lands, `simulate`'s availability probe (today: Docker) widens
  automatically — preflight inherits it through the registry's availability
  logic; no coupling now.
- **Relation to [Plan 30](OPEN-30-agent-llm-working-ergonomics.md):** the
  agent research-ladder docs should name `preflight --json` as the one gate
  once shipped — coordination note, not a dependency.
- **Relation to [Plan 37](OPEN-37-scenario-pin-sets.md):** Plan 37 renames
  `mock` → `scenario` (`--mock` → `--scenario`, `mocks/` → `scenarios/`,
  `fixtures/` folded in) and adds `scenario create --scaffold`. Wherever this
  plan says mock/`--mock`/"committed mocks/fixtures" (the `capture` check, the
  `--offline` profile, passthrough flags, skip-message examples), the
  post-37 spelling is `scenario`/`--scenario`, and the `capture` check's
  unlock should name **both** paths: a real capture (`executions`) or
  `scenario create --scaffold`. A runtime pass pinned from a scenario with
  non-`capture` provenance is labeled/scored "executability only", never full
  runtime green. Independent — either plan can land first; the second one
  sweeps the wording.
