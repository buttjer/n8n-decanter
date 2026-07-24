# Plan 35 — Blind agent field test: Sonnet "users" on a real Docker n8n

**Priority:** P1 — Plans 32+33 **and the skills-first wave (#107)** shipped a
Breaking rework of the entire agent-facing surface, **now released in 0.6.0
(2026-07-23, #133)**; this validates it the way it will actually be consumed,
before further releases build on it untested.
**Status:** In progress — **harness built + stabilized, round-1 blind
execution RUN**, and **3 of the 5 findings now fixed** (#142 host scheme, #144
non-interactive `init`, #143 `.js→.ts` pull reconcile). Tasks 1–3 + 6 done;
**S1 + S2 passed**; finding #1 (discoverability) stays open. **Next pass is
Round 2** (see "Round 2" below): re-run the blind harness on the fixed CLI +
the deferred per-turn grading / Task-4 run report.
**Snapshot:** 2026-07-23T21:55Z @ aef18b1
**Theme:** Put the whole product — `init` → skills/MCP structure work →
Code-node authoring → `push` → runs — in front of **blind** Sonnet coding
agents acting as typical users against a real n8n in Docker, and grade what
happens. A UX/contract field test, not a CI suite.
**Model:** Opus for the orchestrator + graders (this plan's executor);
**Sonnet is fixed for the blind user agents** (by design, maintainer's call).

> **Post-#107 review (2026-07-23), refreshed 2026-07-23 for the backlog reorg
> (#122), the watch-proxy removal (#128), and 0.6.0's live-mirror + `backup`
> wave (#125, released as 0.6.0 in #133) — the design is sound and unbuilt
> (`test/field-test/` does not exist), but the agent surface it tests was
> rebuilt after this plan was written; the corrections below apply before
> executing.**
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
>    the [Plan 50](../draft/50-code-node-authoring-skill.md) authoring-skill
>    evidence tie-in) with a **designed capture
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
>    author) with product vocabulary whitelisted.
> 6. **`preflight` is now the shipped pre-push gate (Plan 36 merged,
>    #117).** It joins the picker menu and is billed as *"the single gate an
>    agent runs before push."* Make it a first-class surface under test: the
>    rubric should record **whether blind agents discover and use `preflight`**
>    (vs. running `check`/`test`/`simulate` piecemeal or skipping verification),
>    and it's a natural pre-`push`/`publish` step in S1/S2's checklists. It is
>    read-only, so it never trips the drift guard.
> 7. **Post-review drift reconciled (2026-07-23, since @710d3f1).** The backlog
>    reorg (#122) retired `plans/README.md`/`BACKLOG.md` — there is **no index
>    file to update** (the `ls plans/*/` dir listing is the index; conventions
>    live in `plans/AGENTS.md`), and the old **"Plan 0" grab-bag placeholder is
>    gone**: this plan's authoring-skill tie-in is now the concrete
>    [Plan 50](../draft/50-code-node-authoring-skill.md). The **watch
>    browser-reload proxy was removed** (#128 / Plan 52) — `watch` no longer
>    injects a reload proxy; n8n's editor reflects MCP draft edits natively and
>    `watch` just prints the editor deep link, so S5's "just show up in n8n" is
>    now n8n-native, not a decanter surface (S5 reframed below). And the template
>    `settings.local.json.example` pre-approves the read verbs but **not
>    `preflight`** — the harness allow-list extension must add it (read-only) so
>    headless runs don't stall on the very gate point 6 wants graded.
> 8. **[Plan 51](../done/51-live-mirror-and-backups.md) (#125) shipped in 0.6.0
>    and changes the very guard surface under test — reconcile before executing.**
>    *(A) On-by-default live `workflow.json` mirror (Part A):* after the guard
>    **forwards** a non-blocked structure edit (either transport), it schedules a
>    **debounced background `pull`** of that **tracked** workflow — refreshing
>    `workflow.json` + `code/` files (incl. born-empty `addNode` files and
>    `renameNode` moves) and **auto-committing** (safety-commit before,
>    commit-on-pull after). So the **block→pull→seed loop of point 4 / S1 / S2 no
>    longer needs a *manual* `pull`** for a tracked workflow — the empty `code/`
>    file materializes on its own (a freshly `create_workflow_from_code`'d,
>    still-untracked workflow keeps the manual `pull <id>` hint). Grade the
>    automatic refresh as a **first-class surface** (helpful, or a confusing race
>    against the agent's own edits?), keep `liveMirror` **on** (the default a real
>    user gets — `liveMirror:false` is the CI/determinism escape hatch, not the
>    honest field-test config), and make `verify.mts`'s git-log invariant
>    **expect the mirror's background safety/pull commits** (still CLI
>    auto-commits — recognizable by message, e.g. "mirrored `<name>`", not
>    hand-crafted state). *(B) The `backup create`/`restore`/`list` verbs (Part B,
>    REST-only → `N8N_API_KEY`, committed `workflows/<slug>/backups/<ts>.<id>.json`
>    artifact):* **out of scope** for round-1 scenarios (git-native disaster
>    recovery is orthogonal to the authoring/guard surface), but a blind agent
>    reaching for `backup` under S4's "we don't need X anymore" wording is
>    **signal** worth logging; if any scenario does exercise it, add `backup` to
>    the allow-list extension and have the stage mint the scoped public API key.

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
[Plan 50](../draft/50-code-node-authoring-skill.md) authoring-skill entry
explicitly waits on (does "the n8n skills' routing nudge bite agents in
practice" — visible as blocked-`jsCode` warn-lines from the `mcp connect`
guard).

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
  [Plan 50](../draft/50-code-node-authoring-skill.md) distinctive-features →
  authoring-skill entry (consumes this plan's captured guard-stderr evidence).

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
  `simulate` + `mcp__n8n-docs`) **plus** a small allow-list extension so
  headless runs don't stall: the mutating verbs a consenting user would approve
  interactively (`init`/`push`/`publish`/`test`/`watch`, + git/npm as needed),
  **and `preflight`** — read-only, but **not yet in the template allow-list**
  (Plan 36 shipped the verb without templating it), so the gate point 6 wants
  graded would otherwise prompt. The template **deny rules stay active** (the
  four `push --force` variants, `.decanter.json` edits, `.env` read/edit): those
  guards are part of what's under test. *(`create`/`archive` are no longer
  verbs — #107.)* Permission-prompt UX itself is out of scope.
- **Execution environment:** blind sessions run **unsandboxed** (nested
  `claude` needs Anthropic API network; `fs.watch`/FSEvents dies sandboxed).

### Stage (scripted, reusing the smoke recipe)

`test/field-test/stage.mts` (dev-only, never part of `npm test`; npm
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

Committed as `test/field-test/scenarios/S*.md` — each defines persona,
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
  show up in n8n" → `watch`, a few edit-save-push cycles. Note the
  **browser-reload proxy is gone** (#128 / Plan 52): `watch` no longer serves a
  reload proxy — it pushes on save and prints the editor deep link, relying on
  n8n's **native** reflection of MCP draft edits, so "just show up" is now n8n's
  behavior to observe, not a decanter surface to grade. Defer if flaky.

### Observation & grading

- **Scripted invariants** (`test/field-test/verify.mts`, run after every
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

1. **Stage script** — `test/field-test/stage.mts` + `field-test:stage`
   npm script, per Design → Stage. Reuse smoke-suite recipe facts; keep it
   boring and rerunnable; `FIELD_KEEP=1` skips teardown, `FIELD_N8N_URL`
   targets an existing instance.
2. **Scenario pack** — `test/field-test/scenarios/S1–S4.md` (+S5 draft)
   with persona/goal/beats/checklist, plus a one-page in-character style
   guide for orchestrator follow-ups (the blinding rules above, verbatim).
3. **Invariant verifier** — `test/field-test/verify.mts`: the scripted
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
   Commands (dev-only, like `test:smoke`); **no `plans/README.md` index entry** —
   that file was retired (#122); the `ls plans/*/` listing is the index and
   `plans/AGENTS.md` holds the conventions; no changelog (internal tooling — no
   user-facing surface).

## Round-1 results — preliminary (2026-07-23)

First blind round ran end-to-end (Sonnet, headless `claude -p`, real n8n 2.30.7
in Docker). Getting a *valid* run took four harness corrections, each itself a
finding; the fixes are in `test/field-test/`. **S1 + S2 passed**; the full
per-turn grading + Task-4 run report are the next pass.

**Per-scenario (round-1b):**
- **S1 — PASS.** `init` (on a pre-seeded `.env`) → `pull` → author `normalize.js`
  → `push` → `publish`, verified on the instance. `verify.mts` 5/5 across 3
  pulled workflows.
- **S2 — PASS (headline).** The blind agent **built a 6-node workflow** (schedule
  → generate → IF → tag-high/tag-low → merge → summarize): **structure via the
  guarded MCP, every Code node via files+push, all byte-equal, zero rogue
  `jsCode`**. `verify.mts` clean across 4 workflows. Core value prop validated.
- **S3 — inconclusive (harness bug, since fixed).** The drift preHook edited
  *Contact normalizer* while the prompt targeted the *orders* workflow → the
  agent fixed the undrifted flow and the drift guard was never exercised. Prompt
  realigned to the drifted node for the next run.
- **S4 — mixed.** `archive_workflow` via MCP **worked** (confirmed archived);
  node-rename handled; the `.js→.ts` conversion exposed finding 4 below.

**Findings (ranked, for maintainer triage — Task 5):**
1. **Discoverability (P1) — OPEN.** No project-level `n8n-decanter` ⇒ a blind
   agent never finds it and hand-rolls raw n8n MCP. Harness now installs the CLI
   so the project carries the breadcrumb; the gap itself is the finding.
   Positioning/onboarding, not a one-line fix — no PR yet.
2. **`init` writes `https://` for a local `http://` host (P1, product) — ✅
   FIXED (#142).** Broke the guard (reads `.env` directly → `upstream request
   failed: fetch failed`) and the CLI. Now scheme-less local hosts default to
   `http://` (`normalizeHostInput`, unit-tested). Repro was `FIELD_NO_SEED_ENV=1`.
3. **`init` is hard for agents to drive (P2, product) — ✅ FIXED (#144).**
   Interactive stdin took 20+ attempts; no non-interactive flag path. Now
   `--host`/`--token`/`--api-key` drive `init` fully non-interactively (no
   prompt); the flag-less piped path is unchanged.
4. **`.js→.ts` conversion leaves `.decanter.json` stale (P2, product) — ✅
   FIXED (#143).** The agent swapped the file + re-pointed the `//@file:`
   placeholder correctly, but a pull in the window before the first TS push
   (notably the live-mirror refresh) rewrote the placeholder back to `.js` and
   left the node→file map at the deleted `.js`. Pull now runs the same
   placeholder→file-map reconcile push does.
5. **Positive.** Decanter's scaffolded `AGENTS.md` steered the agent **file-first**
   for code before it ever tried `jsCode` over MCP — the guard never had to block
   (Plan 50 evidence: the contract pre-empts the nudge). Contamination check
   clean (no agent inferred an evaluation).

**Harness hardening this round:** `stage` packs + **locally installs** our built
CLI (not a published version, and no global `npm link` — `run.mts` puts
`node_modules/.bin` on the session PATH so a bare `n8n-decanter` resolves, with
no machine-global state to clean up), pre-seeds a correct `.env`, disables the
nested session's sandbox (so the agent can reach the local n8n); `run.mts` gained
a per-turn timeout + `--smoke`/`--netcheck`/`--dry-run` probes; `report.mts` renders a
self-contained HTML timeline of the agentic sessions.

## Round 2 — re-run + full grading (validate the fixes)

Round 1 surfaced 5 findings; **three product bugs are now fixed** (#142 host
scheme, #144 non-interactive `init`, #143 `.js→.ts` pull reconcile). Round 2
re-runs the blind harness on the **fixed** CLI to confirm the friction is gone
end-to-end and to finish the Task-4/Task-5 grading that round 1 deferred. Same
blinding protocol, same Sonnet cast — **maintainer-run, UNSANDBOXED** (nested
`claude` needs the Anthropic API + the local n8n; `fs.watch` dies sandboxed).

**Scope (short):**
1. **Rebuild + stage on the fixed CLI.** `npm run field-test:stage` (or
   `FIELD_N8N_URL=…` against a running instance) — the stage packs + locally
   installs *our built CLI*, so build from a checkout that includes #142/#143/#144
   (merge them first, or stage from a worktree that has all three). No global
   `npm link` needed.
2. **Regression-confirm the three fixes (fast, targeted, before the full run):**
   - #144 — drive `init` **non-interactively**: `n8n-decanter init <dir> --host
     <local-http> --token <mcp> [--api-key <key>]` with no stdin; assert `.env`
     is correct, host is `http://…`, and no prompt hangs. This is the exact beat
     that cost round 1 20+ tries — it should now be one clean call.
   - #142 — with `FIELD_NO_SEED_ENV=1` (init writes its own `.env`), confirm a
     scheme-less local host lands as `http://…` and the `mcp connect` guard
     reaches the instance (no `fetch failed`).
   - #143 — in S4, convert a node `.js→.ts` (swap file + re-point `//@file:`),
     let the **live mirror** fire (or run `pull`) *before* the first TS push,
     then push: `.decanter.json` + the placeholder must stay `.ts` and the push
     must succeed (no `referenced node file missing`).
3. **Full blind run S1–S4** (round 1's flow), then `verify.mts` per scenario →
   contamination check → **Opus grading** (the per-turn grading round 1
   deferred) → append `## Run report — round 1/2` here: per-scenario verdicts,
   invariant results, classified guard events, captured `guard.log` evidence for
   [Plan 50](../draft/50-code-node-authoring-skill.md).
4. **S3 must actually exercise the drift guard this time.** Round 1's S3 was
   inconclusive — the drift preHook edited the *wrong* workflow (Contact
   normalizer vs. the *orders* target), so the guard never fired. The prompt is
   already realigned to the drifted node; confirm the run trips the per-node
   drift guard and grades the conflict messaging.

**Out of scope / notes.** Finding #1 (discoverability) is positioning, not a
code fix — track separately, don't gate round 2 on it. `backup` stays out of
the round-1 scenarios (add only if a scenario reaches for it — signal worth
logging). Cost envelope is the same small ~4–6 Sonnet sessions + Opus grading.
This validates that a real bug the field test surfaced is fixed *the way it's
consumed* — the payoff loop of the whole exercise.

## Container mode — safe, unattended blind runs (2026-07-24)

**Why.** Round 1/2 run the blind Sonnet sessions **unsandboxed on the host** with
`Bash` auto-approved and no human review — fine *supervised*, but the maintainer
wants **unattended** rounds, and unattended + unsandboxed-auto-`Bash` is the one
combination that's genuinely unsafe (nothing to Ctrl-C an injected/looping
agent). A container is also a *cleaner* user analogue than the tool developer's
own machine (neutral env, pinned toolchain), so isolation improves fidelity here
rather than hurting it. Decision (2026-07-24, after a safety review with the
maintainer): the nested agents run in a **Docker container, egress-fenced**.

**Isolation contract** (`test/field-test/docker/`, the compose file *is* the
audit surface):
- The `agent` container is on an **`internal`-only** docker network — no host
  filesystem, no host loopback, no host env beyond a single `ANTHROPIC_API_KEY`
  (from a gitignored `test/field-test/.env`, via `--env-file`).
- Its **only** egress is a `proxy` sidecar (tinyproxy allowlist) that forwards to
  **`api.anthropic.com` and nothing else** (`FilterDefaultDeny`). So an injected
  or looping agent cannot exfiltrate the key or reach any other host. **Fail-closed:**
  a misconfig means claude can't reach Anthropic and the run dies, never leaks.
- The staged **throwaway n8n** is `docker network connect`-ed to the internal net
  so the agent reaches it by container name; the host keeps its published port for
  `verify.mts` / provisioning.
- **Validated 2026-07-24** against a real key: from inside the fenced container,
  `example.com` is unreachable *and* proxy-denied while `api.anthropic.com` is
  reachable, and `claude -p` authenticates via `ANTHROPIC_API_KEY` **through
  `HTTPS_PROXY`** and returns a result (Claude Code honors the proxy — the one
  real unknown, now retired).

**Design constraints the wiring must respect:**
- **The fence blocks the npm registry**, so the decanter CLI + deps are **baked
  into the agent image at build time** (build is unfenced) — a per-run image
  `FROM` a stable base + the stage's packed tarball; **no runtime `npm install`**
  inside the fenced container. (Widening the allowlist to npm was rejected — it
  reopens a large egress surface.)
- The host's macOS `node_modules` must never run in Linux (native deps like
  esbuild): the container uses its **baked, Linux-native** CLI, not the workDir's.
- The in-container `.env` `N8N_HOST` is rewritten to the n8n's **in-network name**
  (`http://<container>:5678`); `manifest.host` stays the host-published URL for
  host-side `verify.mts`. The agent works in-container; verify works on the host.
- `S1–S4` run in-container; **`S5` (`watch`) stays host/optional** — `fs.watch`
  on container bind-mounts is unreliable. A **total wall-clock kill** (default 60
  min, `FIELD_RUN_BUDGET_MIN`) bounds an unattended round on top of the per-turn
  timeout.

**Status (2026-07-24):** container mode **BUILT + VALIDATED end-to-end** (foundation
+ `run.mts --container`/`stage.mts` wiring: per-run baked image, internal network
+ n8n join, per-turn `docker exec`, in-network `.env`, guard.log/artifact
extraction, wall-clock cap). Proven against a real stage with **zero claude
spend** via `run.mts --container --precheck` (baked CLI loads + n8n reachable
from inside the fence) on top of the earlier egress-fence + claude-auth
validation. **The first real fenced round RAN + was graded 2026-07-24** — see
"Run report — round 2": S1+S2 pass, S3's drift guard fires, S4 surfaces a new
`.js→.ts` "converted-but-not-pushed" finding; the container isolation held with
no loss of test quality.

## Run archives — a round is committed, not kept (2026-07-24)

**The problem this closes.** A blind round costs real money (~$6 for one S1) and
is **not reproducible** — same prompts, different session. Yet the first rounds'
artifacts lived only in a temp dir that `stage.mts --down` deleted, and one round
was in fact destroyed by tearing down before rendering the report. Deferring the
archive to a human step is the wrong shape for something both expensive and
irreplaceable.

**Decision: every round auto-archives at the end of `run.mts`, into git**, at
`test/field-test/runs/<iso>-<runId>/`:

| file | what |
| --- | --- |
| `raw.tgz` | the **source of truth** — `transcripts/` (stream-json), `verify-*.json`, `guard.log`, a credential-free `manifest.json`, and `work.git` |
| `report.html` | the rendered view, readable straight from the repo |

Three properties, each load-bearing:

1. **Raw-first, view-derived.** The tarball is authoritative; `report.html` is
   one rendering of it. `report.mts --from <raw.tgz>` unpacks and renders with no
   live run around — verified **byte-identical** to the live render. So *what we
   want to look at can change months later* without re-running a round, which is
   the whole point given rounds can't be reproduced.
2. **Committed, not stashed outside the repo.** The earlier design wrote to
   `<main-checkout>/.field-test-runs/` (gitignored) specifically so
   `git worktree remove` couldn't eat it. Being **in git** subsumes that: nothing
   local can lose it, and a round's evidence lands in the PR that produced it.
   `run.mts` deliberately does not `git add` — committing stays a human act.
3. **Deltas, not copies.** The workflow progression is stored as `work.git`, a
   bare clone whose history the harness thickens with a `harness: <S> after turn
   N` commit per turn (on top of decanter's own pull/push auto-commits). That
   replaced per-turn tree snapshots, a flat `.diff` dump *and* a full workDir
   copy — three encodings of one fact, ~780 KB of which the renderer never read.
   Not archived at all: the working tree (reconstructable from `work.git`) and
   the vendored skills pack (identical every run; provenance in
   `manifest.skills`). **~1.5 MB loose → ~75 KB compressed per round.**

Because it lands in git, **secrets are scrubbed at archive time, not render
time** — the MCP token and API key are replaced with `‹redacted›` across the
whole payload before packing (verified: zero JWTs across the committed
tarballs). `run.mts --archive <manifest>` re-archives a finished round without
re-running it: the recovery path if archiving failed, and how the mechanics are
exercised for $0.

**The shipped `report.html` is rendered *from* the tarball**, after packing —
so every round self-tests its own archive, and a renderer failure can no longer
cost us the raw.

**Prompt provenance.** The report captions each turn with its prompt, which
`claude -p` takes as **argv** — it appears nowhere in the stream-json transcript
(whose `user` events are tool results). Rendering therefore used to depend on the
scenario files, which are *deliberately* reworked between rounds, so an old round
re-rendered against new scenarios would show prompts that were never sent. Fixed
from both ends: each turn's prompt is recorded verbatim
(`transcripts/<S>/turn-N.prompt.txt`), and the archive carries the `scenarios/`
as run (the full input spec — persona, beats, checklist). A retroactively
archived round is flagged `scenariosAsRun: false` and its report says so.

**Tested without spend** (`test/unit/field-report.test.mts`, in `npm test`): a
synthetic harness — hand-written stream-json transcript, verify verdict, guard
log, a small git repo as the workDir — driven through the real `report.mts` /
`run.mts --archive`, asserting rendered diffs, the progression, redaction, and
that `--from` reproduces the shipped report **byte-for-byte after the live run is
deleted**. The machinery that preserves an expensive, irreproducible round must
not be first exercised by an actual round — which is exactly how the round that
was destroyed got destroyed.

The three Round-2 S1 rounds (`ftrun-64582`, `-67810`, `-69297`) are archived
retroactively under this scheme — 440 KB for all three.

## Harness status — capabilities (2026-07-23)

**Built (Tasks 1–3 + 6), in `test/field-test/`:**

- `stage.mts` (+ `skills-install.mts`) — `field-test:stage` boots + provisions a
  throwaway n8n (or `FIELD_N8N_URL` targets a running one), seeds 4 pure-node
  workflows (2 realism, 1 left `availableInMCP=false` as a gate-tripper, 1 S1
  **skeleton** = manual-trigger → **empty** Code node), scaffolds a **neutral**
  scratch project (`git init`, vendored n8n skills pack), and prints a manifest.
  Harness artifacts (manifest, transcripts, `guard.log`) live in a **sibling**
  dir the agent never enters, so their metadata can't leak into a blind session.
- `scenarios/S1–S5.md` + `STYLE.md` — persona/goal/adaptive-beats/checklist +
  a machine-readable `## Orchestration` turn spine; blinding rules verbatim. **S1
  decided CLI-only against the stage-seeded skeleton** (the guard can't load in
  the same process `init` first writes `.mcp.json`); S2 owns the MCP-guard path.
- `run.mts` — replays each scenario's scripted turns as headless
  `claude -p --model sonnet` sessions (`--resume` per beat), post-init merges the
  allow-list extension into `settings.local.json` (deny rules preserved) and
  rewrites `.mcp.json` to **capture the guard's stderr** to `guard.log`, then runs
  the verifier. `README.md` documents the full run + grade procedure.
- `verify.mts` — the scripted invariant oracle (independent of `lib/` for the
  fail-generating checks): placeholder integrity, `.js` byte-equality, `.ts`
  marker-hash relation, `lastPushedHash` tie, `.decanter.json` git-history, +
  `get_workflow_history` version-trail evidence.
- `field-test:{stage,run,verify}` npm scripts; AGENTS.md "field test harness"
  Commands note.

**Validated against real n8n 2.30.7 in Docker (2026-07-23):** stage
boots/provisions/seeds/vendors 14 skills end-to-end; `verify.mts` **PASSes** a
clean pull→author→push sync and **FAILs (exit 1)** a simulated rogue direct-MCP
`jsCode` write (byte-equality + `lastPushedHash` both caught, unaffected checks
stay green, version trail records the extra write); `run.mts --dry-run` parses +
substitutes all five scenarios. Typecheck + Biome lint clean.

**Round 1 (Task 4) is a maintainer-run, UNSANDBOXED step.** Nested `claude` is
blocked under the agent command sandbox (and per project convention the sandbox
is not disabled), and `fs.watch`/FSEvents dies sandboxed — so the blind sessions
run from a normal terminal: `npm run field-test:stage` → `node
test/field-test/run.mts <manifest>` → grade (Opus, unblinded) + contamination
check → append `## Run report — round 1`. No blind runs were executed in the
build session, so **no run report is fabricated here.**

**Skills-pack finding (feeds [Plan 50](../draft/50-code-node-authoring-skill.md)
— strong prior to confirm in round 1).** The official `n8n-io/skills` pack
(Apache-2.0) frames the **Code node as a "last resort"** and routes any code it
does write through `create_workflow_from_code` / `update_workflow` SDK code —
which decanter's guard **blocks**. So the pack's routing nudge should surface in
round 1 exactly as **guard-blocked `jsCode` warn-lines** in `guard.log`, i.e. the
block→pull→seed loop is the *expected* product of the nudge, not an error. The
authoring-skill evidence question ("does the nudge bite?") therefore has a clear
hypothesis to verify.

**Fidelity caveat for the grader.** The harness vendors `skills/*` into
`.claude/skills/` (auto-discovered) + reproduces the SessionStart routing cue in
`AGENTS.md`, but does **not** reproduce the official plugin's PreToolUse hooks or
`plugin:` namespacing (that install is interactive/non-deterministic). A
Code-node write nudged over MCP hits the guard the same either way; grade with
the missing hooks in mind.

## Acceptance / verification

- Stage script boots + provisions the pinned tag end-to-end on a clean
  machine, and `FIELD_N8N_URL` mode works against a running local instance.
- ≥4 scenarios executed blind with Sonnet; every scenario's invariant checks
  ran; zero un-flagged contamination (grader-confirmed).
- Run report appended here with per-scenario verdicts, classified guard
  events, and a ranked findings list the maintainer can triage 1:1.
- The captured-guard-stderr evidence question is answered explicitly (did the
  skills' routing nudge bite, yes/no + examples) and cross-referenced from the
  [Plan 50](../draft/50-code-node-authoring-skill.md) authoring-skill entry.
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
- **[Plan 39](../done/39-docs-drift-refresh.md) landed (#123):** the verb-last
  command hints a blind agent would have tripped on are fixed, so that
  anticipated friction source is already retired — the field test measures the
  current, corrected surface, not that known gap.
- **Cost envelope round 1:** ~4–6 Sonnet sessions (multi-turn) + Opus
  grading — small next to the 16-agent Plan 33 review.
- The blind-agent mechanism (`claude -p` in a foreign dir, in-character
  orchestration) is reusable for future waves — treat this plan's harness as
  the template for "field-test the release" passes.
- Auth realism: S1's token-paste path is the *honest* headless story today;
  if a future wave makes OAuth consent agent-drivable, add a scenario then.

## Run report — round 2 (fenced container, 2026-07-24)

**First round run in the new egress-fenced container harness**
(`run.mts --container`) — 4 blind Sonnet sessions, fully isolated
(Anthropic-only egress, no host FS/env), unattended. This both **validates the
three round-1 fixes under a real n8n** and **proves the container harness
end-to-end**.

**Per-scenario (verify = `verify.mts`):**
- **S1 — PASS (5/5).** `init` (pre-seeded `.env`) → author `normalize.js` →
  `push` → `publish` → `test`. Full flow, clean.
- **S2 — PASS (headline).** The fenced agent **built a 6-node workflow**
  (schedule → generate → IF → tag-high/tag-low → merge → summarize), **every
  Code node via files + push, all byte-equal, zero rogue `jsCode`**, and ran it
  live (execution 5). Core value prop holds — *inside the fence*.
- **S3 — drift guard fired (verify "FAIL" = the drift itself, working as
  designed).** The harness drifted the `Normalize` node instance-side; the agent
  **detected the conflict and refused to push** ("someone edited … bypassing the
  repo"). Round-1's S3 was inconclusive (wrong node drifted); the realigned S3
  now exercises the guard correctly.
- **S4 — mixed.** Workflow rename + node rename + `archive_workflow` via the
  guard all worked; the **`.js`→`.ts` conversion surfaced finding 1**.

**Three round-1 fixes — regression check:**
- **#142 (init https-for-local): no recurrence.** S1's `init` on a pre-seeded
  local-`http` `.env` synced fine; the guard reached n8n (no `fetch failed`).
- **#143 (`.js`→`.ts` pull/push reconcile): not regressed** — see finding 1: the
  agent never `push`ed the conversion, so the reconcile (which runs on
  push/pull) never executed. #143 is correct for its scope.
- **#144 (non-interactive init flags): not exercised** — the stage pre-seeds a
  correct `.env`, so `init` reused it without prompting (a `FIELD_NO_SEED_ENV`
  variant would exercise the flags).

**Findings (ranked):**
1. **`.js`→`.ts` conversion left unregistered — agent ran `check`, not `push`
   (P2, product/UX).** S4 turn 3: the agent wrote `generate-fake-orders.ts`,
   re-pointed the `//@file:` placeholder to `.ts` (correctly), `rm`'d the `.js`,
   then ran **`n8n-decanter check`** — which reported **"All green"** — and
   stopped. It **never pushed**, so the compiled `.ts` never reached the remote
   and `.decanter.json` still points at the deleted `.js` (verify:
   `… .js in .decanter.json but missing on disk`). **Not a #143 bug** (no sync
   ran). Two sub-issues: (a) an agent doing MCP **structure** edits (rename/
   archive, no push) didn't realize the **code** conversion still needs a
   `push`; (b) **`check` passes green while `.decanter.json` references a file
   missing on disk** — candidate product fix: `check`/`status` should flag a
   stale/missing node-file reference (would have caught this immediately).
2. **Blinding leak: the packed CLI's `package.json` exposes the `field-test:*`
   scripts (P3, harness).** The S1 agent read the installed CLI's `package.json`
   (npm-pack ships all `scripts`) and saw `"field-test:stage": …` etc. It did
   **not** infer an evaluation (its own reasoning never mentions it; the broader
   eval-awareness scan is clean), so the run is gradeable — but the harness
   should strip the `field-test:*` (and other dev) scripts from the packed
   `package.json` before install. Pre-existing (host mode too), not
   container-specific.
3. **Positive — file-first held, guard never blocked.** `guard.log` has **zero**
   blocked `jsCode`-over-MCP writes across all four scenarios: the scaffolded
   `AGENTS.md` steered the agent file-first for all code, even fenced (Plan 50
   evidence: the contract pre-empts the routing nudge).
4. **Positive — the container harness works and doesn't degrade the test.** Four
   blind Sonnet sessions ran fully **egress-fenced** (Anthropic-only), no host
   access, unattended, and produced the **same quality** as host mode (S1/S2
   pass, S3 guard fires). The safety redesign the maintainer's concern drove is
   proven in a real round.

**Artifacts:** transcripts + `verify-S*.json` + `guard.log` in the scratch
`harnessRoot`; **archived retroactively** to `test/field-test/runs/` (see "Run
archives" above), container torn down clean.

## S2 re-run — the same scenario failed the way S2 passed before (2026-07-24, `ftrun-81310`)

First round produced by the new archive path end-to-end (per-turn prompt capture
+ harness turn commits): `test/field-test/runs/2026-07-24T11-02-17Z-ftrun-81310/`
— **$3.87**, 3 turns (59 / 7 / 26 model turns), 284 KB archived.

**Result: verify FAIL (4 violations) — `remote (0b) ≠ local`** on every Code
node. The agent built the whole 6-node workflow, authored all the code locally…
and **never ran `push`**. Commands it did run: `pull`, `check` ×2, `node run`
×5, `simulate`, `scenario create/check`. No `push`, no `status`.

**Why this matters more than a single red run: the previous S2 PASSED** — same
scenario, same prompts, same model, and it pushed everything byte-equal. So the
variable isn't the CLI's correctness, it's **whether the agent ever discovers
that authoring locally is not the finishing move**. One session in two got it
right.

**The compounding factor is that `check` said it was fine.** Twice:

```
✓ Hourly Order Bucket Summary: OK
✓ typecheck OK
```

`check` is the *local* compliance guard (layout + typecheck); it never consults
the instance, so "OK" here means "your files are well-formed", not "your work is
live". The agent used it as its done-oracle and stopped. `status` — the verb
that *would* have shown `local ≠ remote` — was never reached for.

**This is now the same finding three times**, across three different scenarios:
S1 (authored, then *asked* whether to push), S4 (`.js`→`.ts` converted, ran
`check` instead of `push`), and now S2. Each time the tool reported green while
the code had never left the repo. That consistency makes it the strongest
product signal the field test has produced — and it is a **UX/affordance** gap,
not a bug: every individual command behaves as documented.

**For maintainer triage** (this plan changes no product code — Task 5):
- Should `check`'s green line say what it did *not* check (e.g. `✓ OK (local
  only — run status to compare with n8n)`)?
- Should `status` be what an agent naturally reaches for after editing — or
  should `check` fold in a cheap sync comparison?
- The scaffolded `AGENTS.md` steers agents file-first for *authoring*; nothing
  states that a push is what makes it real.
