# Plan 35 — Blind agent field test: Sonnet "users" on a real Docker n8n

**Priority:** P1 — Plans 32+33 **and the skills-first wave (#107)** shipped a
Breaking rework of the entire agent-facing surface; this validates it the way it
will actually be consumed, before the next release is cut.
**Status:** Not started
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1
**Theme:** Put the whole product — `init` → skills/MCP structure work →
Code-node authoring → `push` → runs — in front of **blind** Sonnet coding
agents acting as typical users against a real n8n in Docker, and grade what
happens. A UX/contract field test, not a CI suite.
**Model:** Opus for the orchestrator + graders (this plan's executor);
**Sonnet is fixed for the blind user agents** (by design, maintainer's call).

> **Post-#107 review (2026-07-23) — the design is sound and unbuilt
> (`scripts/field-test/` does not exist), but the agent surface it tests was
> rebuilt after this plan was written; five corrections before executing.**
> 1. **The guard is now stdio `mcp connect`, auto-wired — not a human-started
>    `mcp serve` proxy.** The scaffolded `.mcp.json` carries `n8n-instance` =
>    `{"command":"n8n-decanter","args":["mcp","connect"]}`; the agent's harness
>    spawns it. So the "orchestrator starts `mcp serve` when the story reaches
>    it" beat, the `.decanter-proxy.json` discovery test, and the
>    `mcp-route-check` nudge (which only fires on a config pointing *directly*
>    at an instance) have **no offender on the default path** — make them a
>    deliberate *misconfigured-MCP* scenario variant if still wanted.
> 2. **"Proxy log" evidence does not exist.** Neither guard writes a log file;
>    a blocked `jsCode` write is a single **stderr warn-line** of the
>    agent-spawned `mcp connect` process, and successful forwards are unlogged.
>    Replace every "proxy log" mention (Why, invariants, artifacts, acceptance,
>    the Plan 0 authoring-skill evidence tie-in) with a **designed capture
>    channel** (stage-scaffold the `.mcp.json` command with a stderr redirect,
>    e.g. `sh -c 'n8n-decanter mcp connect 2>>guard.log'`) plus **instance-state
>    verification** (`get_workflow_history` version trail + remote-file
>    byte-equality) for "no `jsCode` landed via MCP".
> 3. **S1 "workflow creation" and all of S4 (workflow rename / node rename /
>    archive) use retired verbs** — they are MCP acts through the guard now.
>    Recast S4 as a **guard + `pull`-reconciliation** scenario (it now
>    field-tests exactly the #107 reconciliation machinery — arguably *more*
>    valuable); TS conversion = replace file + re-point `//@file:` placeholder +
>    push. Decide whether S1 includes the one MCP creation act or gets a
>    stage-seeded workflow so it stays CLI-only.
> 4. **The block→pull→seed loop is the DESIGNED path, not an exception.** A new
>    Code node is added over MCP **without** `jsCode` (the guard blocks it),
>    lands as an **empty** `code/` file on pull, is authored locally, and its
>    first push seeds the source. S2's rubric must grade this expected sequence
>    (and treat mid-scenario "empty remote vs empty file" byte-equality as
>    legitimate), not score every guard block as a recovery event.
> 5. **Two invariants/rules are self-defeating as written:** the byte-equality
>    invariant is **false for the TS-converted node S4 creates** (a `.ts` node's
>    remote `jsCode` is compiled JS + a `@ts-n8n` marker line — verify via the
>    marker-hash relation, not byte-equality); and the blinding rule banning
>    "test/scenario/…" vocabulary now **collides with the shipped `test` and
>    `scenario` verbs** the agent will see in `--help`/docs — rescope the ban to
>    harness-authored artifacts (prompts, dir/container/workflow names, git
>    author) with product vocabulary whitelisted. Also update the **`plans/README.md`
>    index blurb**, which repeats the stale guard-proxy/proxy-log story.
> 6. **`preflight` is now the shipped pre-push gate (Plan 36 merged,
>    #117).** It joins the picker menu and is billed as *"the single gate an
>    agent runs before push."* Make it a first-class surface under test: the
>    rubric should record **whether blind agents discover and use `preflight`**
>    (vs. running `check`/`test`/`simulate` piecemeal or skipping verification),
>    and it's a natural pre-`push`/`publish` step in S1/S2's checklists. It is
>    read-only, so it never trips the drift guard.

## Why

The MCP pivot (Plan 32) and its wave (Plan 33) are verified by unit/e2e/smoke
— scripted clients asserting known-correct call sequences. Nobody has yet
tested the product's real consumer: **a coding agent in a fresh sync dir,
driven by human-typical instructions**, discovering the tool through the
template contract, the docs, the CLI's own error messages, and the guard
rails. That surface (AGENTS.md.example wording, `init`'s flow, the auto-wired
`mcp connect` guard UX, skills-vs-decanter routing, drift-guard messaging) can
only fail in ways scripted tests don't model: an agent misreading an error, a
skill nudging it to write `jsCode` via MCP, a doc gap that stalls a session.

A **blind** test — the agent doesn't know it's being evaluated — is the only
honest read: an agent that knows it's a test run performs the contract instead
of using the product. Side benefit: the **captured guard-stderr** evidence the
[Plan 0](../draft/) authoring-skill entry explicitly waits on (does "the n8n
skills' routing nudge bite agents in practice" — visible as blocked-`jsCode`
warn-lines from the `mcp connect` guard).

## Source

- Maintainer request 2026-07-22: real-life scenario test — local Docker n8n,
  Sonnet as blind user agents, simple + medium workflows, typical inputs, MCP
  skills + code nodes, CLI from `init` to `push`, runs included, **no
  network/API nodes**.
- [Plan 30](../open/30-agent-llm-working-ergonomics.md) — the ergonomics this
  test measures (orientation, offline loop, grounding ladder).
- [Plan 33](../done/33-post-mcp-pivot-wave.md) Task 4 (the HTTP `mcp serve` guard)
  **and the skills-first wave (#107)** — which made the stdio **`mcp connect`**
  guard the auto-wired default that this test actually exercises;
  [Plan 0](../draft/) distinctive-features → authoring-skill entry (consumes
  this plan's captured guard-stderr evidence).

## Design

### Cast & blinding protocol

- **Blind users:** fresh headless Claude Code sessions —
  `claude -p --model sonnet` (multi-turn via `--resume`) — with cwd inside a
  **neutral-named scratch project outside this repo** (e.g.
  `/tmp/flows-ops/`). Each session sees only: a realistic user prompt, the
  sync dir (as materialized by *its own* `init` run), and the instance.
  **Not** Agent-tool subagents: those can't load the sync dir's `.mcp.json`,
  skills, and hooks — `claude -p` from the dir is the actual product surface.
- **Blinding rules (hard):** no "eval/experiment/blind-run"-style vocabulary in
  **harness-authored artifacts** — prompts, dir names, container name, workflow
  names, git author. **`test` and `scenario` are shipped decanter verbs**, so
  that product vocabulary is whitelisted (the agent *will* see it in `--help`,
  the allowlist, the docs, and its own commands — S2 ends on
  `n8n-decanter test`); the ban is on *evaluation-signalling* words in what the
  harness writes, not on the product's own surface. The agent never sees this
  repo, its plans/, or the harness. Follow-up user messages are written **in
  character** by the orchestrator (typical user tone: goal-oriented, mildly
  ambiguous, occasional change-of-mind). Graders are unblinded.
- **Contamination check:** a grader scans every transcript for signs the
  agent inferred an evaluation (**judging intent, not the mere presence of the
  `test`/`scenario` verbs**); a suspected-leak run is flagged and re-run
  with the leak fixed, not graded.
- **Permissions:** the scratch dir gets the template
  `settings.local.json` (already pre-approves the read/offline verbs —
  `pull`/`check`/`node`/`status`/`list`/`executions`/`data-tables`/`scenario`/
  `simulate` + `mcp__n8n-docs`) **plus** a small allow-list extension for the
  mutating verbs a consenting user would approve interactively
  (`init`/`push`/`publish`/`test`/`watch`, + git/npm as needed) so headless
  runs don't stall — the template **deny rules stay active** (the four
  `push --force` variants, `.decanter.json` edits, `.env` read/edit): those
  guards are part of what's under test. *(`create`/`archive` are no longer
  verbs — #107.)* Permission-prompt UX itself is out of scope.
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

**Guard startup (rewritten for #107).** Nothing is started by a human on the
default path: the scaffolded `.mcp.json` wires the stdio `mcp connect` guard
that the blind agent's own harness spawns (so the stage must ensure the scratch
project's MCP servers are enabled — e.g. `enableAllProjectMcpServers` or
`--mcp-config` — or the guard never loads). The HTTP `mcp serve` + `.decanter-proxy.json`
+ `mcp-route-check` path is now exercised **only** by a deliberate variant that
scaffolds a *misconfigured* direct-instance MCP entry, so the route-check hook
has an offender to warn about — add that as an optional scenario, not the
default.

### Scenarios (all pure-node: Manual/Schedule trigger, Code, Set/Edit Fields, IF/Switch, Merge, NoOp — no network/API/credentialed nodes)

Committed as `scripts/field-test/scenarios/S*.md` — each defines persona,
goal prompt, scripted beats (condition → in-character follow-up), and a
success checklist. Round 1 = one run each; later rounds are cheap re-runs.

- **S1 — green field, simple.** User has a fresh n8n + an MCP token minted in
  the UI; wants the project set up and one simple workflow: manual trigger →
  Code node (dedupe/transform a pasted JSON list). Covers `init` (token
  paste path — OAuth browser consent is out of scope, e2e owns it), then —
  since there is no `create` verb — **one MCP creation act through the
  auto-wired guard** (`create_workflow_from_code`) *or* a stage-seeded
  workflow so S1 stays CLI-only (decide and state which); then the
  block→pull→seed loop for the Code node (added over MCP without `jsCode` →
  empty `code/` file → author → first push seeds), `check`, `node run` with a
  fixture, `push`, `publish`.
- **S2 — medium build via skills + the mcp connect guard.** Same dir, later
  session: a 6–8 node workflow (schedule trigger → Code generate → IF split →
  two Code branches → Merge → Code summary). Structure via the n8n MCP
  tools/skills **through the auto-wired `mcp connect` guard**; each Code node
  rides the **designed** block→pull→seed loop (the guard blocking `jsCode` in
  `addNode` is the *expected* path, not an error — grade the block→pull→seed
  sequence as success, and treat mid-scenario "empty remote vs empty file"
  byte-equality as legitimate until first push); ends with an instance-side run
  via `scenario create <wf> --scaffold` (synthetic pins, no captures exist yet)
  → `n8n-decanter test --scenario <slug>` (labeled "synthetic pins — proves
  executability, not output correctness") plus offline `node run`
  fixtures. Genuine *confusion/stall* events (agent doesn't recover from a
  block, or retries `jsCode`-over-MCP) are the finding signal.
- **S3 — remote drift + edit request.** The harness plays a colleague editing
  a Code node instance-side (direct MCP as second client, harness
  credentials); the user then asks for a change to the same workflow.
  Exercises orientation (`status`/pull-first), the per-node drift guard, and
  conflict messaging under typical phrasing.
- **S4 — refactor & lifecycle via the guard + `pull` reconciliation.** Under
  casual user wording ("clean this up", "we don't need X anymore"): rename the
  workflow and a node **over MCP through the guard** (`renameNode` /
  workflow rename), archive an obsolete seeded workflow (`archive_workflow`
  over MCP), and convert one node to TypeScript (**replace the file + re-point
  its `//@file:` placeholder + push** — there is no `--ts` verb). Then `pull`
  reconciles: local files follow node renames, the workflow name re-caches, the
  folder stays sticky. This scenario now field-tests exactly the #107
  reconciliation machinery — its most valuable role. *(No decanter
  rename/archive/node-rename verbs exist anymore.)*
- **S5 (optional, unsandboxed only) — watch loop.** "I want my edits to just
  show up in n8n" → `watch`, a few edit-save-push cycles. Defer if flaky.

### Observation & grading

- **Scripted invariants** (`scripts/field-test/verify.mts`, run after every
  scenario — pass/fail, no LLM): remote `jsCode` byte-equals the local file for
  every **plain `.js`** Code node — **but a `.ts`-converted node (S4) is
  compiled JS + a `@ts-n8n sha256:` marker line, never byte-equal to the local
  `.ts`; verify those via the marker-hash relation, not byte-equality**;
  `workflow.json` placeholders intact; `.decanter.json` never hand-edited (git
  history); **no `jsCode` landed via MCP** — verified from **instance state**
  (the MCP `get_workflow_history` version trail + final remote-file equality),
  since there is no proxy log; sync-dir git log shows the CLI's auto-commits,
  not hand-crafted state.
- **Rubric (Opus graders over transcripts + artifacts):** task success per
  scenario checklist; process conformance (code via files+push, structure
  via MCP/verbs, orient-before-edit); guard events classified
  (working-as-intended vs confusing); friction log (failed commands,
  retries, misleading errors, doc gaps) each tied to the exact CLI/docs
  surface; turns/time to done.
- **Artifacts:** transcripts (`--output-format stream-json`), the **captured
  guard stderr** (stage-scaffold the `.mcp.json` command to redirect it to a
  file — there is no proxy log), sync-dir git history, instance end-state —
  kept in the scratch dir, not committed. Only the report lands in-repo.

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
   ranked findings (severity × surface), captured guard-stderr evidence for the
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
- The captured-guard-stderr evidence question is answered explicitly (did the
  skills' routing nudge bite, yes/no + examples) and cross-referenced from the
  [Plan 0](../draft/) authoring-skill entry.
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
