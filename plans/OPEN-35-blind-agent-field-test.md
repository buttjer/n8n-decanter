# Plan 35 — Blind agent field test: Sonnet "users" on a real Docker n8n

**Priority:** P1 — Plans 32+33 shipped a Breaking rework of the entire
agent-facing surface; this validates it the way it will actually be consumed,
before the next release is cut.
**Status:** Not started
**Theme:** Put the whole product — `init` → skills/MCP structure work →
Code-node authoring → `push` → runs — in front of **blind** Sonnet coding
agents acting as typical users against a real n8n in Docker, and grade what
happens. A UX/contract field test, not a CI suite.
**Model:** Opus for the orchestrator + graders (this plan's executor);
**Sonnet is fixed for the blind user agents** (by design, maintainer's call).

## Why

The MCP pivot (Plan 32) and its wave (Plan 33) are verified by unit/e2e/smoke
— scripted clients asserting known-correct call sequences. Nobody has yet
tested the product's real consumer: **a coding agent in a fresh sync dir,
driven by human-typical instructions**, discovering the tool through the
template contract, the docs, the CLI's own error messages, and the guard
rails. That surface (AGENTS.md.example wording, `init`'s flow, the guard-proxy
UX, skills-vs-decanter routing, drift-guard messaging) can only fail in ways
scripted tests don't model: an agent misreading an error, a skill nudging it
to write `jsCode` via MCP, a doc gap that stalls a session.

A **blind** test — the agent doesn't know it's being evaluated — is the only
honest read: an agent that knows it's a test run performs the contract instead
of using the product. Side benefit: the proxy-log evidence the
[Plan 0](BACKLOG.md) authoring-skill entry explicitly waits on ("proxy logs
show the n8n skills' routing nudge biting agents in practice").

## Source

- Maintainer request 2026-07-22: real-life scenario test — local Docker n8n,
  Sonnet as blind user agents, simple + medium workflows, typical inputs, MCP
  skills + code nodes, CLI from `init` to `push`, runs included, **no
  network/API nodes**.
- [Plan 30](OPEN-30-agent-llm-working-ergonomics.md) — the ergonomics this
  test measures (orientation, offline loop, grounding ladder).
- [Plan 33](DONE-33-post-mcp-pivot-wave.md) Task 4 — the guard-proxy stack
  under test; [Plan 0](BACKLOG.md) distinctive-features → authoring-skill
  entry (consumes this plan's proxy-log evidence).

## Design

### Cast & blinding protocol

- **Blind users:** fresh headless Claude Code sessions —
  `claude -p --model sonnet` (multi-turn via `--resume`) — with cwd inside a
  **neutral-named scratch project outside this repo** (e.g.
  `/tmp/flows-ops/`). Each session sees only: a realistic user prompt, the
  sync dir (as materialized by *its own* `init` run), and the instance.
  **Not** Agent-tool subagents: those can't load the sync dir's `.mcp.json`,
  skills, and hooks — `claude -p` from the dir is the actual product surface.
- **Blinding rules (hard):** no "test/eval/smoke/scenario/experiment"
  vocabulary anywhere the agent can see — prompts, dir names, container
  name, workflow names, git author. The agent never sees this repo, its
  plans/, or the harness. Follow-up user messages are written **in
  character** by the orchestrator (typical user tone: goal-oriented, mildly
  ambiguous, occasional change-of-mind). Graders are unblinded.
- **Contamination check:** a grader scans every transcript for signs the
  agent inferred an evaluation; a suspected-leak run is flagged and re-run
  with the leak fixed, not graded.
- **Permissions:** the scratch dir gets the template
  `settings.local.json` **plus** an allow-list extension covering the
  decanter verbs a consenting user would approve interactively
  (`init`/`pull`/`push`/`create`/`publish`/`test`/`archive`/…) so headless
  runs don't stall — the template **deny rules stay active**
  (`push --force`, `archive --force`, `.decanter.json` edits, `.env` reads):
  those guards are part of what's under test. Permission-prompt UX itself is
  out of scope.
- **Execution environment:** blind sessions run **unsandboxed** (nested
  `claude` needs Anthropic API network; `fs.watch`/FSEvents dies sandboxed).

### Stage (scripted, reusing the smoke recipe)

`scripts/field-test/stage.mts` (dev-only, never part of `npm test`; npm
script `field-test:stage`):

- Boot the pinned n8n image (same tag as `test/smoke-n8n.mts`) with a
  **neutral container name**; readiness-gate on `GET /rest/settings`, owner
  setup (special-char password), enable MCP via
  `PATCH /rest/mcp/settings`, mint the rotatable MCP token
  (`POST /rest/mcp/api-key/rotate`), optionally mint a scoped public API key
  — all per AGENTS.md "Driving a real n8n in Docker".
  `FIELD_N8N_URL=<url>` skips the boot and targets an already-running local
  instance instead (maintainer's own container); teardown then leaves it
  alone.
- Light **realism seeding**: a couple of human-named pre-existing workflows
  (pure nodes only) so the instance doesn't look sterile; one left
  `availableInMCP=false` (S1 may trip over the gate — that's signal).
- Build + `npm link` the CLI so `n8n-decanter` is on PATH (Node won't
  type-strip `.mts` under `node_modules` — see docs/cli/init.md).
- Scaffold the neutral scratch project dir; install the **official n8n
  skills pack** (n8n-io/skills) into its agent config the way a real user
  would. Write the settings allow-list extension.
- Print a **stage manifest** (JSON: host, tokens, dirs, seeded workflow ids)
  for the orchestrator; secrets are throwaway.

The orchestrator (not the stage script) starts `n8n-decanter mcp serve` in
the project dir when a scenario's story reaches it — per the template
contract that's the *human's* act, and whether the agent then finds
`.decanter-proxy.json` / heeds the `mcp-route-check` nudge is under test.

### Scenarios (all pure-node: Manual/Schedule trigger, Code, Set/Edit Fields, IF/Switch, Merge, NoOp — no network/API/credentialed nodes)

Committed as `scripts/field-test/scenarios/S*.md` — each defines persona,
goal prompt, scripted beats (condition → in-character follow-up), and a
success checklist. Round 1 = one run each; later rounds are cheap re-runs.

- **S1 — green field, simple.** User has a fresh n8n + an MCP token minted in
  the UI; wants the project set up and one simple workflow: manual trigger →
  Code node (dedupe/transform a pasted JSON list). Covers `init` (token
  paste path — OAuth browser consent is out of scope, e2e owns it), workflow
  creation, code-node authoring in `code/`, `check`, `node run` with a
  fixture, `push`, `publish`.
- **S2 — medium build via skills + proxy.** Same dir, later session: a 6–8
  node workflow (schedule trigger → Code generate → IF split → two Code
  branches → Merge → Code summary). Structure via the n8n MCP tools/skills
  **through the guard-proxy**; code via files + `push`; ends with an
  instance-side run (`n8n-decanter test` or MCP `test_workflow`) plus
  offline `node run` fixtures. This is the scenario expected to produce
  proxy-block events — each one graded "guard worked + agent recovered" vs
  "agent confused/stalled".
- **S3 — remote drift + edit request.** The harness plays a colleague editing
  a Code node instance-side (direct MCP as second client, harness
  credentials); the user then asks for a change to the same workflow.
  Exercises orientation (`status`/pull-first), the per-node drift guard, and
  conflict messaging under typical phrasing.
- **S4 — refactor & lifecycle.** Rename the workflow, `node rename`, convert
  one node to TypeScript, archive an obsolete seeded workflow. The newer
  verbs under casual user wording ("clean this up", "we don't need X
  anymore").
- **S5 (optional, unsandboxed only) — watch loop.** "I want my edits to just
  show up in n8n" → `watch`, a few edit-save-push cycles. Defer if flaky.

### Observation & grading

- **Scripted invariants** (`scripts/field-test/verify.mts`, run after every
  scenario — pass/fail, no LLM): remote `jsCode` byte-equals the local
  file for every Code node; `workflow.json` placeholders intact;
  `.decanter.json` never hand-edited (git history); no `jsCode` landed via
  MCP (proxy log clean of successful writes); sync-dir git log shows the
  CLI's auto-commits, not hand-crafted state.
- **Rubric (Opus graders over transcripts + artifacts):** task success per
  scenario checklist; process conformance (code via files+push, structure
  via MCP/verbs, orient-before-edit); guard events classified
  (working-as-intended vs confusing); friction log (failed commands,
  retries, misleading errors, doc gaps) each tied to the exact CLI/docs
  surface; turns/time to done.
- **Artifacts:** transcripts (`--output-format stream-json`), proxy log,
  sync-dir git history, instance end-state — kept in the scratch dir, not
  committed. Only the report lands in-repo.

## Tasks

1. **Stage script** — `scripts/field-test/stage.mts` + `field-test:stage`
   npm script, per Design → Stage. Reuse smoke-suite recipe facts; keep it
   boring and rerunnable; `FIELD_KEEP=1` skips teardown, `FIELD_N8N_URL`
   targets an existing instance.
2. **Scenario pack** — `scripts/field-test/scenarios/S1–S4.md` (+S5 draft)
   with persona/goal/beats/checklist, plus a one-page in-character style
   guide for orchestrator follow-ups (the blinding rules above, verbatim).
3. **Invariant verifier** — `scripts/field-test/verify.mts`: the scripted
   checks above, runnable per scenario against the stage manifest; exit 1 on
   any violation.
4. **Round 1 execution (agentic, Opus orchestrator):** stage → S1…S4 blind
   runs (Sonnet, headless, unsandboxed, `--resume` for beats) → verify →
   contamination check → grade → **run report appended to this plan**
   (`## Run report — round 1`): per-scenario verdicts, invariant results,
   ranked findings (severity × surface), proxy-log evidence for the
   authoring-skill backlog entry.
5. **Triage, not fixes:** findings are handed to the maintainer as a ranked
   list; each accepted one becomes a backlog/plan item **by the
   maintainer's call** — this plan changes no product code.
6. **Repo hygiene:** AGENTS.md gets a short "field test harness" note under
   Commands (dev-only, like `test:smoke`); plans/README.md index entry; no
   changelog (internal tooling — no user-facing surface).

## Acceptance / verification

- Stage script boots + provisions the pinned tag end-to-end on a clean
  machine, and `FIELD_N8N_URL` mode works against a running local instance.
- ≥4 scenarios executed blind with Sonnet; every scenario's invariant checks
  ran; zero un-flagged contamination (grader-confirmed).
- Run report appended here with per-scenario verdicts, classified guard
  events, and a ranked findings list the maintainer can triage 1:1.
- The proxy-log evidence question is answered explicitly (did the skills'
  routing nudge bite, yes/no + examples) and cross-referenced from the
  [Plan 0](BACKLOG.md) authoring-skill entry.
- Blind sessions produced no changes to this repo, and no scratch artifacts
  were committed.

## Non-goals

- **Not a CI suite** — cost and nondeterminism rule it out; the committed
  harness makes *re-running* cheap, not automatic.
- **No product fixes in this plan** — findings → maintainer triage (Task 5).
- **No network/API/credentialed nodes** in any scenario workflow.
- **No permission-UX evaluation** (headless allow-list approximates a
  consenting user); **no OAuth browser-consent flow** (e2e owns it); **no
  model benchmarking** — Sonnet is the fixed cast, not a variable.
- **No forking/patching of n8n-io/skills** for the test — the pack installs
  whole, as shipped ("override, not fork" stands).

## Notes

- **CHANGELOG:** none (internal dev tooling + plan). **PLAN.md:** no design
  change; a post-run observation note only if round 1 surfaces one worth
  recording.
- **Cost envelope round 1:** ~4–6 Sonnet sessions (multi-turn) + Opus
  grading — small next to the 16-agent Plan 33 review.
- The blind-agent mechanism (`claude -p` in a foreign dir, in-character
  orchestration) is reusable for future waves — treat this plan's harness as
  the template for "field-test the release" passes.
- Auth realism: S1's token-paste path is the *honest* headless story today;
  if a future wave makes OAuth consent agent-drivable, add a scenario then.
