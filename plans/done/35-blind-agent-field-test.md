# Plan 35 — Blind agent field test: Sonnet "users" on a real Docker n8n

**Priority:** P1 — Plans 32+33 **and the skills-first wave (#107)** shipped a
Breaking rework of the entire agent-facing surface, **now released in 0.6.0
(2026-07-23, #133)**; this validates it the way it will actually be consumed,
before further releases build on it untested.
**Status:** **Done** (2026-07-27) — harness built, stabilized, fenced, and
**exercised across 22 archived rounds** (`test/field-test/runs/`); all six tasks
complete and **every finding triaged** to a merged fix or a plan. The three
*conditions* this plan never got around to measuring (unassisted PATH, cold
`init`, `watch`) are future rounds on a finished harness, not unfinished build
work — they moved to [Plan 62](../done/62-field-test-unrun-conditions.md). See
**"Close-out"** immediately below for the round index and the task-by-task
verdict; everything after it is the historical record, kept as written.
**Snapshot:** 2026-07-27T12:05Z @ 0be700c
**Theme:** Put the whole product — `init` → skills/MCP structure work →
Code-node authoring → `push` → runs — in front of **blind** Sonnet coding
agents acting as typical users against a real n8n in Docker, and grade what
happens. A UX/contract field test, not a CI suite.
**Model:** Opus for the orchestrator + graders (this plan's executor);
**Sonnet is fixed for the blind user agents** (by design, maintainer's call).

## Close-out (2026-07-27)

**Everything below this section is the historical record**, written round by
round and left as written. This section is the summary that closes the plan.

### Task verdicts

| task | verdict |
| --- | --- |
| 1 stage script | **Done** — plus `FIELD_N8N_URL`, `FIELD_NO_SEED_ENV`, `FIELD_NO_CLI`, tarball unblinding, per-scenario prerequisites |
| 2 scenario pack | **Done** — S1–S6 + `STYLE.md` (S6 added post-design for the Plan 57 condition) |
| 3 invariant verifier | **Done** — `verify.mts`, independent of `lib/` for the fail-generating checks |
| 4 round execution + report | **Done in substance, not in the named shape** — see "The report Task 4 asked for" below |
| 5 triage | **Done** — every finding routed; table below |
| 6 repo hygiene | **Done** — AGENTS.md Commands note; no changelog (internal tooling) |

Scope also grew well past the original design: **egress-fenced container mode**,
**committed run archives** (raw-first, view-derived), subscription-token billing,
and the discoverability condition — each documented in its own section below.

### Round index — 22 archived rounds

All in `test/field-test/runs/<iso>-<runId>/` as `raw.tgz` + `report.html`;
re-render any of them with `npm run field-test:report -- --from <raw.tgz>`.

| scenario | rounds | verify verdicts |
| --- | --- | --- |
| S1 green field | 10 | 9 PASS / 1 FAIL |
| S2 medium build via the guard | 10 | 8 PASS / 2 FAIL |
| S3 remote drift | 5 | 4 PASS / 1 FAIL *(the deliberate drift scored as failure — a verifier bug, fixed in #171)* |
| S4 refactor + lifecycle | 5 | 1 PASS / 2 FAIL / **2 unscored** (`ftrun-93355` has no verify file; `ftrun-90305` lacks its S4 verdict) |
| S6 fresh clone, no CLI | 6 | 6 PASS |
| S5 watch | **0** | never run — moved to [Plan 62](../done/62-field-test-unrun-conditions.md) |

**The close-out evidence is [`ftrun-99503`](../../test/field-test/runs/2026-07-27T10-48-15Z-ftrun-99503/)**
(2026-07-27): the **only round that sweeps S1–S4 in one go, all four PASS** —
and one of three rounds (`90305`, `92069`, `99503`) run on the **post-Plan-59/60
verb surface** (`preflight` + `diff`; no `check`/`status`/`simulate`). Every
other archived round measured a CLI whose verify verbs no longer exist. Those
three landed inside #179 and were, until this close-out, cited nowhere.

### What the rounds established

- **The core value prop holds under blind use:** structure over the guarded MCP,
  **code via files + `push`**, byte-equal on the instance — in every passing
  round, host and fenced alike.
- **The MCP guard has blocked nothing, ever** — 0 `jsCode` blocks across all 22
  rounds, including every round where the official `n8n-code-nodes-official`
  skill loaded. The scaffolded `AGENTS.md` contract **pre-empts** the skills
  pack's routing nudge rather than colliding with it. *(This answers the
  guard-stderr evidence question the plan was built to answer.)*
- **The fresh-clone agent finds and uses the CLI** (S6 ×6, `FIELD_NO_CLI=1`,
  ambient install shadowed) — via `package.json`, `.mcp.json`, or a
  `which … || npx …` probe. [Plan 57](57-cli-discoverability-for-agents.md)'s
  founding premise did **not** reproduce against today's scaffold.
- **S2's failures were the agent obeying our own contract**, not misreading
  state — traced from the transcripts, fixed at the source (#163: `push` is part
  of finishing the work; only `publish` needs the ask).
- **S3's drift guard fires correctly** and the conflict messaging lands.
- **The harness's own crutches are findings too** — the PATH prepend
  (now an explicit, printed policy) and the blinding leak in the packed
  `package.json` (now stripped at pack time).

### Findings ledger (Task 5 — all routed)

| finding | outcome |
| --- | --- |
| Discoverability — no project-level CLI | [Plan 57](57-cli-discoverability-for-agents.md) (Done) + S6 |
| `init` writes `https://` for a local host | Fixed #142 |
| `init` not agent-drivable | Fixed #144 (`--host`/`--token`/`--api-key`) |
| `.js→.ts` leaves `.decanter.json` stale | Fixed #143 |
| Converted-but-not-pushed; green `check` read as done | [Plan 30](../open/30-agent-llm-working-ergonomics.md) Theme A → #154, then subsumed by [Plan 59](59-declutter-verify-verbs.md)/[60](60-preflight-first-verb-surface.md) |
| Contract gated `push` behind an ask | Fixed #163 (+ #162's `preflight → push → test → publish`) |
| Blinding leak via packed `package.json` | Fixed — `unblindTarball` in `stage.mts` |
| Harness PATH crutch | Explicit + printed; `FIELD_NO_PATH_HELP=1` opts out ([Plan 58](58-guard-route-robustness.md) Tasks 3/4) |
| Round archives died with their worktree | Fixed — rounds auto-archive into git (#153/#157/#159) |

### The report Task 4 asked for

Task 4 named a single `## Run report — round 1` with per-turn Opus grading.
**That artifact was never written, and is not going to be** — round 1's fixes
landed, the CLI moved on twice (Plans 59/60), and grading a superseded surface
turn-by-turn buys nothing. What exists instead, and stands as the record:
"Round-1 results — preliminary", "Run report — round 2", "Run report — S6
discoverability", the cross-round sections, and 22 committed archives. Recorded
as **superseded, not delivered** — no report is fabricated here.

### Deferred — three conditions, not three tasks

Never measured, and each one a *round* on a finished harness rather than
missing machinery — spun out as [Plan 62](../done/62-field-test-unrun-conditions.md):
`FIELD_NO_PATH_HELP=1` (unassisted Bash PATH), `FIELD_NO_SEED_ENV=1` (the cold
`init` path — #144's flags have still never met a blind agent), and **S5**
(`watch`, host-only). Plan 61 *(unmerged — PR #160)* widens *what* is tested;
Plan 62 finishes *how* it is staged.

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
>    the Plan 50 *(dropped)* authoring-skill
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
>    (vs. running `check`/`simulate` piecemeal or skipping verification),
>    and it's a natural pre-`push` step in S1/S2's checklists. It is
>    read-only, so it never trips the drift guard. *(Meaning shifted 2026-07-25,
>    Plan 60/#162: `preflight` now grades **local code only** — the instance
>    `test` stage moved out of it to **after** the push, so `test` is no longer
>    a piecemeal alternative preflight subsumes but a distinct post-push step.
>    Rounds up to `ftrun-95299` ran the old preflight; grade "preflight
>    adoption" against whichever CLI the round's manifest packed — the cut-over
>    note in `scenarios/S1.md` records the same.)*
> 7. **Post-review drift reconciled (2026-07-23, since @710d3f1).** The backlog
>    reorg (#122) retired `plans/README.md`/`BACKLOG.md` — there is **no index
>    file to update** (the `ls plans/*/` dir listing is the index; conventions
>    live in `plans/AGENTS.md`), and the old **"Plan 0" grab-bag placeholder is
>    gone**: this plan's authoring-skill tie-in is now the concrete
>    Plan 50 *(dropped)*. The **watch
>    browser-reload proxy was removed** (#128 / Plan 52) — `watch` no longer
>    injects a reload proxy; n8n's editor reflects MCP draft edits natively and
>    `watch` just prints the editor deep link, so S5's "just show up in n8n" is
>    now n8n-native, not a decanter surface (S5 reframed below). And the template
>    `settings.local.json.example` pre-approves the read verbs but **not
>    `preflight`** — the harness allow-list extension must add it (read-only) so
>    headless runs don't stall on the very gate point 6 wants graded.
>    *(Superseded 2026-07-25: `preflight` has been pre-approved in the template
>    since #138, and the file is `settings.json.example` since #149 — the
>    harness extension is redundant here, not a requirement.)*
> 8. **[Plan 51](51-live-mirror-and-backups.md) (#125) shipped in 0.6.0
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
Plan 50 *(dropped)* authoring-skill entry
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
- [Plan 33](33-post-mcp-pivot-wave.md) Task 4 (the HTTP `mcp serve` guard)
  **and the skills-first wave (#107)** — which made the stdio **`mcp connect`**
  guard the auto-wired default that this test actually exercises;
  Plan 50 *(dropped)* distinctive-features →
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
  and `preflight`. *(Corrected 2026-07-25: this used to say `preflight` was
  "not yet in the template allow-list" — it has been pre-approved there since
  #138, so the harness's extension is merely redundant, not required. The file
  is also `template/.claude/settings.json.example` now, project scope since
  #149/Plan 56 — and the harness deliberately never writes the template file;
  it merges its overrides into the scratch dir's local layer.)* The template
  **deny rules stay active** (the
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
- **Artifacts** *(superseded 2026-07-24 by the archive redesign — see "Run
  archives" below; #153/#157/#159)*: transcripts (`--output-format
  stream-json`), the **captured guard stderr**, per-turn prompts, verify
  verdicts, a credential-scrubbed manifest, and the sync-dir git history (as a
  bare clone) are **committed**, compressed, to
  `test/field-test/runs/<iso>-<runId>/` as `raw.tgz` + `report.html`. The
  original design kept them in the scratch dir uncommitted — a $6 round died
  with its teardown, which is what forced the change. Only the instance
  end-state stays uncommitted (reconstructable from the history).

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
1. **Discoverability (P1) — TRIAGED 2026-07-24 → [Plan 57](57-cli-discoverability-for-agents.md).**
   No project-level `n8n-decanter` ⇒ a blind agent never finds it and hand-rolls
   raw n8n MCP. Harness now installs the CLI so the project carries the
   breadcrumb; the gap itself is the finding. Positioning/onboarding, not a
   one-line fix — given its own draft plan rather than folded into Plan 30.
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
   Plan 50 *(dropped)*.
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

## Post-fix repetitions — S2 ×2, S3 ×2 (2026-07-24, subscription-billed)

First rounds on a CLI carrying the [#154](https://github.com/buttjer/n8n-decanter/pull/154)
`check` change, and the first billed as **subscription quota** rather than API
tokens (`CLAUDE_CODE_OAUTH_TOKEN`, PR #157). One stage per repetition — a reused
instance would have let repeat 1's workflows contaminate repeat 2.

| round | S2 | S3 | push | status | check |
| --- | --- | --- | --- | --- | --- |
| `ftrun-81310` (pre-fix) | **FAIL(4)** | — | **0** | 0 | 4 |
| `ftrun-88381` (S1) | PASS | — | 2 | 3 | 2 |
| `ftrun-89930` (rep A) | PASS | PASS | 2 / 1 | 0 | 4 / 1 |
| `ftrun-91178` (rep B) | PASS | PASS | 2 / 3 | 0 | 4 / 1 |

**4/4 PASS, and both S2 repetitions pushed** — the exact failure is absent.

**This does not establish that the fix caused it, and the numbers say so.** S2
also passed in round 2, so its record across all runs is 3 PASS / 1 FAIL. If S2
simply passed ~75% of the time all along, two consecutive passes would occur
**56% of the time** — more likely than not. Two repetitions cannot separate "the
fix worked" from "the coin landed the same way twice". Distinguishing them needs
enough repetitions to bound the rate, which is a deliberate cost decision, not
something to infer from these four.

**A finding that IS solid, and inconvenient: `status` had zero uptake.** The
`check` hint names `status` explicitly and was displayed in every S2 turn
(verified in both archives) — yet **no S2 or S3 session ran `status` even once**.
The agents go straight from `check` to `push`. So whatever helped here, it was
**not** the mechanism that change was built around; the likelier lever is the
template edit (a green `check` is not a finished task; the `.js`→`.ts` recipe now
ends at `push`). Worth folding back into Plan 30 Theme A: pointing at a verb
agents don't reach for is weaker than telling them the state they're in.

**S3 is reliable** — 2/2 PASS here, on top of round 2's correct drift-guard
firing. The drift path needs no further attention.

## S2's failures were the agent obeying our own contract (2026-07-24)

**The finding, from reading the transcripts rather than counting verbs.** Across
five S2 rounds the correlation is exact — `push` executed → PASS, not executed →
FAIL — but *why* it wasn't executed is not what the earlier write-ups assumed.
The failing agent said so itself, in turn 2:

> "Still local-only (not pushed to the draft) — let me know when you'd like me to
> push/test/publish."

It was never confused about state. It knew exactly what it had not done, said so,
and **waited for authorisation** — because
[`template/AGENTS.md.example`](../../template/AGENTS.md.example) *told* it to, in
bold, twice — the contract **as it stood at the time of those rounds**: *"`push`
writes the DRAFT of the live instance — **only when the user asks**"*, and
*"Otherwise finish edits, verify with `check` + `run`, and report that the change
is ready to push."* Finish edits → verify with `check` + `node run` → report
ready to push is, step for step, what it did. **It followed the documented
contract and `verify.mts` scored it a violation.** *(#163 has since rewritten
both passages — push is now part of finishing the work; the quotes are kept
verbatim here because they explain those rounds.)*

**So S2 was mis-specified, not the product.** Its prompt said *"Build the
structure in n8n and write the Code steps here in the repo"* — work to do, never
a goal state — so it never granted the ask the contract requires. S1 was fixed
this way after round 1 (*"make sure the finished code actually ends up there —
not just sitting in this folder"*) and has passed reliably since; S2 never got
the same treatment. The passing S2 rounds pushed *despite* the contract; the
failing ones obeyed it. That is the whole variance.

**Consequences to be honest about:**
- The premise behind the `check` affordance work ([#154](https://github.com/buttjer/n8n-decanter/pull/154))
  — "the agent mistakes a green `check` for done" — **was not the failure
  occurring here**. The agent knew. That change is defensible on its own merits
  (a green `check` genuinely isn't proof of anything remote) but it did not fix
  this, and `status` uptake stayed at **zero across all seven rounds**.
- Fixed: S2's turn 1 now ends *"It should actually be running in n8n when you're
  done, not just sitting in this folder."* Goal level, no verb named — naming the
  verb would make the scenario pass trivially and measure nothing.
- Generalised into [`scenarios/STYLE.md`](../../test/field-test/scenarios/STYLE.md):
  any scenario whose invariants include remote state must state the goal state in
  the prompt, or it is testing obedience to the contract rather than the tool.

**~~The real product question this leaves open~~ — DECIDED (maintainer,
2026-07-24 → PR #163).** The question was whether the contract should
distinguish "the user described a goal that includes it running" from "the user
asked for an edit". The maintainer's call went further and simpler: **`push` is
part of finishing the work — only `publish` (changing what is live) needs the
ask.** A push lands on the draft and never changes what runs, so gating it
protected nobody while leaving build tasks unfinished. The scaffolded contract
and `/docs/agents` surfaces were rewritten accordingly (#163), and #162
completed the story with the documented order `preflight → push → test →
publish`.

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

**Skills-pack finding (feeds Plan 50 *(dropped)*
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

*(Checked off at close-out 2026-07-27 — evidence in "Close-out" above.)*

- ✅ Stage script boots + provisions the pinned tag end-to-end on a clean
  machine, and `FIELD_N8N_URL` mode works against a running local instance.
- ✅ ≥4 scenarios executed blind with Sonnet; every scenario's invariant checks
  ran; zero un-flagged contamination (grader-confirmed). **6 scenarios, 22
  rounds, 34 verify verdicts** — with two S4 rounds left unscored (named in the
  round index rather than glossed).
- ⚠️ Run report appended here with per-scenario verdicts, classified guard
  events, and a ranked findings list — **met in substance across four report
  sections + the findings ledger; the single "round 1" report Task 4 named was
  superseded, not written** (see "The report Task 4 asked for").
- ✅ The captured-guard-stderr evidence question is answered explicitly: **the
  nudge never bit — 0 blocked `jsCode` writes in 22 rounds**, including rounds
  where the official code-node skill loaded; the scaffolded contract steers
  file-first before the skills' routing advice applies. *(The Plan 50
  cross-reference is void — that plan was dropped in #178; this bullet is now
  where the answer lives.)*
- Blind sessions produced no changes to this repo. *(Amended 2026-07-25: the
  original criterion also said "no scratch artifacts were committed", which the
  archive redesign deliberately reversed — #153/#157/#159 **commit** each
  round's transcripts, verify verdicts, guard log, per-turn prompts and workflow
  history, credential-scrubbed and compressed, to `test/field-test/runs/`. The
  surviving invariant is narrower and the one that matters: **nothing a blind
  session writes lands in this repo uncurated** — archives are packed by the
  harness, secret-scrubbed, and committed by the operator, never by the blind
  agent.)*

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

## Finding — the harness's PATH crutch hides a real failure mode (2026-07-26)

Surfaced while fixing [Plan 58](58-guard-route-robustness.md) Task 1. The
harness stages **both** install shapes — host mode installs decanter
**locally** (`npm install <tgz>` into the workDir), container mode installs it
**globally** (`npm install -g`) — but then **masks the difference in both**:

- host mode prepends the workDir's `node_modules/.bin` to the blind session's
  PATH ([`run.mts`](../../test/field-test/run.mts#L396)), and
- container mode symlinks the global bin into `/work/node_modules/.bin`
  ([`run.mts`](../../test/field-test/run.mts#L81)),

so a bare `n8n-decanter` always resolves for the blind agent. **A real user's
agent gets neither.** That crutch is exactly why the guard's local-install
silent-fail (Plan 58 Task 1) went unseen through every round: the harness
supplied the one thing that made the bug invisible.

**Action:** drop the PATH prepend, or make it a deliberate, documented toggle
(e.g. an explicit "simulate a global install" flag) so the default run measures
what real agents hit. Until then, treat "the agent reached the CLI" results as
*conditional on a crutch the field doesn't have*. The paired regression test
(spawn the scaffolded command with a clean PATH, both install shapes) is
[Plan 58](58-guard-route-robustness.md) Task 3.

**Resolved 2026-07-26 (partially — deliberately).** The crutch is now explicit
rather than invisible:

- **The guard no longer needs it at all.** Plan 58 Task 1 made the scaffolded
  `.mcp.json` run `npx --no-install n8n-decanter mcp connect`, which resolves the
  workDir-local bin from cwd on its own. The MCP route is therefore measured
  unassisted in every round from now on.
- **The agent's `Bash` calls still need it**, because the workDir install is
  local and a bare `n8n-decanter` in a shell does not resolve. Removing the
  prepend outright would fail rounds for a reason unrelated to what they
  measure, so it is **kept as the default and renamed for what it actually is**:
  a simulation of the global install most users have.
- **`FIELD_NO_PATH_HELP=1`** drops it, giving a genuinely unassisted PATH — the
  configuration a real *local-install* user's agent gets.
- **Every run now prints its `PATH policy`** in the orchestration header, so a
  round's own record states whether the agent got a resolvable bare command.
  That is what stops this from silently qualifying results again.

**Follow-on 2026-07-26:** the same "what does the harness quietly supply?"
question produced `FIELD_NO_CLI=1` + scenario
[`S6`](../../test/field-test/scenarios/S6.md) — the deliberate version of round
1's accidental no-CLI condition ([Plan 57](57-cli-discoverability-for-agents.md)
direction 4). It shadows any ambient `n8n-decanter` off the session PATH and
empties the npm prefix, so a maintainer's global install cannot satisfy the
round; `run.mts` refuses S6 against a normal stage or in `--container` mode.

Remaining *(moved to [Plan 62](../done/62-field-test-unrun-conditions.md) at close-out —
never run under this plan)*: a round with `FIELD_NO_PATH_HELP=1` to measure the
unassisted Bash surface. **The fix is an invocation-form change, not an
install-shape one**
— see [Plan 58](58-guard-route-robustness.md) Task 4. A per-sync-dir
devDependency is a documented, supported install and works correctly when
invoked as `npx n8n-decanter <verb>`; requiring a global install is explicitly
not the answer.

## Run report — S6 discoverability, first round (2026-07-26, `ftrun-87406`)

**Result: FOUND-AND-USED. The round-1 premise did NOT reproduce.** One round,
host mode, unsandboxed, Sonnet, 2 turns; archive committed at
`test/field-test/runs/2026-07-26T19-21-54Z-ftrun-87406/`.

The agent's actual route, from `turn-1.jsonl`:

```
ls -la
find workflows -maxdepth 3
cat package.json                  ← read the breadcrumb
npx n8n-decanter list --remote    ← reached for the CLI, unprompted
npx n8n-decanter pull <id>
```

…then edited the file and pushed. `verify-S6.json`: **0 violations** — remote
`jsCode` byte-equals the local `.js`, `lastPushedHash` matches, and decanter
auto-committed (`decanter: pulled "Contact normalizer"`).

Three corroborating details:

- **It read `AGENTS.md`** (twice, turn 1) — the evidence was found *and* used.
- **`guard.log` is empty** — it never used the n8n MCP route at all, guarded or
  not. There was no bypass to catch.
- **`node_modules` was never restored** — it never ran `npm install`. `npx`
  fetched the published CLI from the registry on demand, which is a legitimate
  recovery path the stage deliberately leaves open.

**Condition validity confirmed in-run:** the runner logged
`[noCli] shadowed /Users/malte/.nvm/…/bin` — the maintainer machine *does* carry
a global `npm link` install, so without that shadowing this round would have
measured an agent that could run the CLI all along.

### Repeats 2–4 (2026-07-26): 4/4 FOUND-AND-USED — it reproduces

`ftrun-91113`, `ftrun-93211`, `ftrun-95680`, each on its own fresh stage, same
scenario text. **Every round: `verify` `passed: true`, 0 violations, and an
empty `guard.log`.** The n=1 objection is settled: with today's scaffold
committed, the fresh-clone agent finds and uses the CLI.

**Read `guard.log` correctly:** the guard logs only what it **blocks**, and
forwards everything else silently. An empty `guard.log` therefore means *"no
`jsCode` write was ever attempted"* — **not** "the MCP route went unused". In
fact 3 of 5 rounds did use the **guarded** route for reads
(`mcp__n8n-instance__get_workflow_details` / `get_workflow_history`, reached via
`ToolSearch`); the other two never needed it, because `pull` had already brought
the workflow down as files. Either way the division of labour held: **reads and
metadata over MCP, code over files + `push`.**

**How each one got there differs, and that is the useful part** — three distinct
breadcrumbs worked:

| round | how it found the CLI |
| --- | --- |
| `87406` | `cat package.json` → `npx n8n-decanter list --remote` |
| `91113` | `cat .mcp.json` → then used **that file's exact `npx --no-install` form** |
| `93211` | `which n8n-decanter \|\| npx n8n-decanter --version` → `npx … --help` |
| `95680` | `which n8n-decanter \|\| npx n8n-decanter --version` → `npx … --help` |

Two observations worth keeping:

- **Rounds 3 and 4 probed for the CLI explicitly** (`which … || npx …`) — i.e.
  the agent's own reflex is to test PATH and fall back to `npx`. That is exactly
  the recovery [Plan 58](58-guard-route-robustness.md) Task 4 documents, arrived
  at unprompted.
- **Round 2 learned the invocation from `.mcp.json`** — it read the guard entry
  and copied its `npx --no-install` form verbatim. The scaffolded MCP config is
  doing double duty as invocation documentation.
- **The scaffolded `AGENTS.md` contract is in the agent's context from the first
  token of every session.** The scaffolded `CLAUDE.md` begins with `@AGENTS.md`
  and Claude Code auto-loads `CLAUDE.md` and resolves that import. The agent
  confirmed it directly in `ftrun-98438` turn 3, using **no tools**, when asked
  how it got oriented:

  > "It was already available — I didn't have to go find it. It was loaded
  > automatically at the start of the session via `CLAUDE.md`'s `@AGENTS.md`
  > import, before I did any exploring of the repo myself."

  …and then stated the contract's ship flow correctly from memory
  (`edit → preflight → push → test → publish`, with `preflight` local-only,
  `push` to the draft, `test` on the draft, `publish` deliberate) — a
  decanter-specific fact it could not have inferred from general n8n knowledge.

  **Consequence for reading any transcript:** the absence of a `Read`/`cat` of
  `AGENTS.md` means nothing. The contract is background context, and transcripts
  record only `assistant`/`user`/`system:init` messages — never the system
  prompt. The files the agent *actively* consulted to work out how to invoke the
  CLI were `package.json` and `.mcp.json`.

### Why this contradicts round 1 — two candidates, not yet separated

1. **The world changed.** Round 1's project had far less evidence; today's
   scaffold ships `AGENTS.md`, `.mcp.json`, and a `package.json` naming
   `n8n-decanter` — and the agent demonstrably read the last one first.
2. **n = 1.** One round, one model, one prompt phrasing.

**Do not rewrite [Plan 57](57-cli-discoverability-for-agents.md) on this
alone.** What it does establish: with the *current* scaffold committed, a
fresh-clone agent finds and uses the CLI rather than hand-rolling MCP.

### Scenario bug found by the run (✅ fixed at close-out)

S6 reuses the `s1-skeleton` workflow, whose Code node is **empty**, but its
turn-1 prompt said *"on top of whatever it already does"*. The agent correctly
flagged the mismatch and spent turn 1 clarifying instead of working. It did not
invalidate the measurement (the *route* is what S6 scores, and the route was
taken before the mismatch surfaced), but it wasted a turn. **Fixed by rewording
turn 1** — the prompt no longer presupposes existing behaviour, and still states
the goal state (`STYLE.md`'s rule) without naming a verb. Rounds 1–6 stay
comparable: the route measurement is unaffected.

## Cross-round: skills uptake, and the MCP guard has never fired (2026-07-27)

Two dedicated verification rounds (`ftrun-6820`, `ftrun-13558`), each running
S1+S2 on its own fresh stage, both `verify` PASS / 0 violations:

| | round A | round B |
| --- | --- | --- |
| S1 | `n8n-code-nodes-official` | `n8n-code-nodes-official` |
| S2 | *(none)* | `using-n8n-skills-official`, `n8n-workflow-lifecycle-official` |

- **The official n8n skills pack is genuinely consulted** — `n8n-code-nodes-official`,
  the skill overlapping decanter's own territory, fired in **both** S1 rounds.
- **Uptake is variable, not a property.** S2 used 3–4 skills in earlier rounds,
  then **0** and **2** here. Any claim about skill usage needs several rounds
  behind it.
- **S6 (code-editing, fresh clone) used none in 5 rounds** — a property of that
  *task*, which is code-only; the skills cover building and wiring.

**The MCP guard has blocked nothing, ever: zero `jsCode` blocks across ~14
archived rounds**, including every round where `n8n-code-nodes-official` was
loaded. Agents read n8n's own code-node skill and still route code through
files + `push`.

Keep the two guards distinct when reading this: the **MCP guard**
(`mcp connect`, blocks code writes over MCP) has never fired; the **push-side
guards** (compliance + drift) do fire and are exercised by S3.

Agents also self-verify without being told — round B ran `check`×4, `node run`×3,
`test`×3, `status`×2, `preflight`×1 unprompted.

## Notes

- **CHANGELOG:** none (internal dev tooling + plan). **PLAN.md:** no design
  change; a post-run observation note only if round 1 surfaces one worth
  recording.
- **[Plan 39](39-docs-drift-refresh.md) landed (#123):** the verb-last
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
  variant would exercise the flags). *(Still true at close-out: no round has ever
  run the cold-`init` path → [Plan 62](../done/62-field-test-unrun-conditions.md).)*

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
   container-specific. **✅ FIXED 2026-07-24** — `stage.mts` rewrites the packed
   tarball in place (`unblindTarball`), dropping `field-test:*` before anything
   installs it. The *tarball* is the fix point because both install paths flow
   through it: host mode's `npm install <tgz>` and container mode's
   `npm install -g` inside the fenced image. Only `field-test:*` is stripped —
   `test`, `lint`, `test:smoke` … are what a genuine `npm i n8n-decanter` also
   shows, and removing them would make the blind environment *less* like a real
   user's. Verified on a real pack: 4 scripts removed, 11 kept, tarball still
   installs and the CLI runs.
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

**Triaged 2026-07-24 → fixed in Plan 30 Theme A** (docs + a one-line signal, no
new network call): `check`'s success line now reads `OK (local layout — status
compares with n8n)`; `check` **warns** when a placeholder has moved off what
`.decanter.json` records or the recorded file is gone; and
`template/AGENTS.md.example`'s `.js`→`.ts` recipe — which **ended at `check`**,
literally instructing the behaviour that failed — now ends at `push`.

The warning deliberately is **not** an error: `pushWorkflow` runs
`assertCompliant` *before* `reconcileFileMapFromSnapshot`, so erroring would
refuse the one command that heals the state. Pinned by a test.
