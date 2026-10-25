# Plan 89 — machine plan (derived, do not edit by hand)

Source: [89-rest-verbs-prerequisite-chain.md](89-rest-verbs-prerequisite-chain.md).
Content flows from there only; this file carries the cut, the shared contract
and the status.

Worktree `.claude/worktrees/plan-cut-89-rest-verbs-prerequisite-chain-b0df280e`,
branch `worktree-plan-cut-89-rest-verbs-prerequisite-chain-b0df280e` (from
`main` ff5e1c5). Root `AGENTS.md` governs: English in files, `.mts` with
erasable syntax only, Biome lint, no build step. **Never commit** — the run
commits each green wave itself.

Drift: snapshot 45521e2; the only commit since is ff5e1c5, the plan's own
rework. Nothing to surface.

Baseline on ff5e1c5, 2026-10-25: `npm test` green in 1m18s (unit suite, e2e
108 steps, guard-proxy 34, mcp-spawn 8, interactive 18); `git status` clean
afterwards, so hashing `test/` is stable across runs.

**Review at the end: `high`** — error wording and one error branch in
`lib/api.mts`; no guard, credential or deploy logic changes.

| # | Slug | Type | Turns | Test command | Status |
|---|---|---|---|---|---|
| 0 | tests | cut-opus | 35+15 | `node --test test/unit/api-not-found.test.mts test/unit/rest-prerequisite.test.mts test/unit/push-drift-hint.test.mts` — red for the right reason | done: 15 tests, 9 red on the new behaviour, 6 regression guards green |
| 1 | code | cut-sonnet | 40 | `npm run typecheck && npm run lint && npm test` | — |
| 1 | docs | cut-qwen | 20 | `npm run check:docs` | — |

Phases `code` and `docs` are one wave (disjoint files, listed under each).
Plan bookkeeping (Status → Done, move to `plans/done/`, inbound links) stays
with the hub after the review, once "done" is known.

**One deviation in technique from the operator plan.** Its acceptance asks for
the CLI-surface cases "as a mock-backed e2e step". They go into a standalone
`test/unit/rest-prerequisite.test.mts` instead — same thing (the real CLI as a
subprocess against a `node:http` mock of the `GET /api/v1/...` routes), but
each case independent. `test/e2e.mts` is one stateful scenario whose runner
skips every step after the first failure, so red steps added there hide each
other and every later step; and its 3,752 lines are the wrong size to load
into a phase. The intention — real CLI, mock REST, MCP-independence asserted —
is unchanged.

## Contract: the messages

What phase 0 tests against, phase 1 builds and phase 2 describes. Wording is
phase 1's call within these lines.

**404 (`lib/api.mts`, plan Task 1).** A 404 from the public API keeps today's
facts — `<METHOD> <path> failed: 404 Not Found` and n8n's body (first 2000
chars) — and adds a hint for two endpoints only:

- `GET /api/v1/executions/<id>`: that execution does not exist on this
  instance — check the id; n8n's execution data-retention pruning may have
  removed it.
- `GET /api/v1/workflows/<id>`: that workflow does not exist on this instance
  — deleted since the last pull, or the API key's project cannot see it.

Every other 404 (data tables above all) keeps the bare line. The token `404`
must stay in every 404 message: `lib/datatables.mts:237` matches `\b404\b` to
say "the data-tables API is not available". 401 and 403 are untouched
(`test/unit/api-scopes.test.mts` pins them).

**Not pulled (plan Task 3).** One exported definition in `lib/mcp.mts`, beside
`ENABLE_MCP_HINT` (a constant ending, or a function — phase 1 decides), that
says *pull it first, and `pull` needs the workflow opted into MCP:* followed by
`ENABLE_MCP_HINT` verbatim (reuse the constant, never retype it). Every
in-scope site uses it:

- `resolveRef`'s `no workflow matches "<ref>"` throw (`n8n-decanter.mts:697`),
  keeping `— pulled workflows: "…", …` / `— nothing pulled yet` and adding the
  chain after it. **Except when the verb is `pull`**: there the no-match means
  nothing on the instance matches (or the remote list failed), so telling the
  user to pull is wrong — `pull` keeps a message without the chain.
- `lib/executions.mts:132` and `:152`, `n8n-decanter.mts:1125` (`backup:*`),
  `lib/backup.mts:100`.
- Where it costs nothing: `n8n-decanter.mts:904/992/1033/1102`,
  `lib/push.mts:205`, `lib/watch.mts:45`. **Not** `lib/push.mts:95` (drift),
  `lib/push.mts:275/277`, the `lib/validate.mts` layout errors, or
  `lib/diff.mts:125` (it warns only after an MCP read succeeded, so the
  workflow is already opted in) — those mean something other than "not in
  the mirror, and maybe not opted in".

Existing assertions that must keep passing without edits:
`test/e2e.mts:1670` (`no workflow matches "No Such Flow"` plus the candidate
list), `:1680` (`workflow wf-not-pulled not found under .* — pull it first`),
`:2514` (`belongs to workflow wf-other, which is not pulled`),
`:1143` and `test/unit/push.test.mts:132` (drift `pull first`),
`test/unit/validate.test.mts:56/67` (exact layout strings). So the
`workflow <ref> not found under <root> — pull it first` and
`execution <id> belongs to workflow <wfid>, which is not pulled` prefixes stay
as they are, and the chain goes after them.

**No MCP on the REST path.** `executions` and `backup create` on an unpulled
workflow fail with their local message and open no connection to
`/mcp-server/http`. Nothing in this plan adds an MCP call (plan Task 4 is
dropped; plan Notes: their independence is load-bearing).

## Phase `tests` — cut-opus, 35 turns

**Objective.** Two new test files exist, and every case that pins new
behaviour fails today for the right reason (the assertion on the new text, not
an import error or a broken mock). Regression guards that pass today are
expected and must be named as such in the report.

1. `test/unit/api-not-found.test.mts` — `N8nApi` (`lib/api.mts`; constructor
   `{ host, apiKey }`) against a `node:http` server that answers 404 with a
   recognisable body. Model it on `test/unit/api-scopes.test.mts` (read that
   file whole, it is 126 lines). Cases:
   - `getExecution("999")`: message has `404`, `Not Found`, the id, the raw
     body, and an execution-specific hint (does not exist on this instance;
     retention/pruning). Match loosely by meaning, not exact wording.
   - `getWorkflow("wfX")`: `404`, the body, a workflow-specific hint (deleted,
     or the key's project cannot see it).
   - `listDataTables()` on 404: still contains `404` (the datatables mapping
     depends on it) and carries neither the execution nor the workflow hint.
2. `test/unit/rest-prerequisite.test.mts` — the real CLI
   (`node n8n-decanter.mts …`, cwd = a temp sync dir) as an async subprocess
   against a `node:http` mock. AGENTS.md, "Verifying changes at the CLI
   surface", has the recipe (sync dir: `.env` with `N8N_HOST`,
   `N8N_MCP_TOKEN`, `N8N_API_KEY`; `decanter.config.json`; `git init` with
   local user). **Also pass `N8N_HOST`, `N8N_MCP_TOKEN` and `N8N_API_KEY` in
   the child's `env`, and drop `N8N_DECANTER_AUTH` and `N8N_DECANTER_DIR`
   from it**: `loadEnv` never overrides an inherited variable
   (`lib/config.mts:84-87`), so the operator's shell would otherwise win over
   the `.env` (e2e does the same at `test/e2e.mts:591-596`). Nothing at CLI
   startup opens MCP — the client is created on demand
   (`n8n-decanter.mts:669-673`). The mock serves `GET /api/v1/executions/<id>` (404 for
   unknown ids; 200 with an execution whose `workflowId` is not pulled) and
   counts every request to `/mcp-server/http`, answering it by destroying the
   socket — MCP unreachable. Seed one pulled workflow so the
   `pulled workflows:` list has an entry: either write its `workflows/<slug>/`
   state by hand (shape: `lib/state.mts`, `listWorkflowRefs`/`readState`) or
   bootstrap with `pull` against a minimal MCP answer before switching MCP
   off — your call; say which in the report. Cases, each asserting the exit
   code, the text, and **zero MCP requests** for the REST verbs:
   - `executions 999` (mock 404): the execution hint from the contract, not
     just `404 Not Found`.
   - `executions <id>` for an execution of an unpulled workflow: still the
     `belongs to workflow <wfid>, which is not pulled` message (the 404 hint
     must not shadow it), and it now contains `ENABLE_MCP_HINT` (import it
     from `lib/mcp.mts`) and tells the user to pull.
   - `backup create <id-shaped unpulled ref>` and
     `backup create "My New Workflow"` (display name with spaces): both name
     `pull` and contain `ENABLE_MCP_HINT`; the display-name one keeps the
     `pulled workflows:` list with the seeded workflow's name.
   - `executions "My New Workflow"`: same chain.
   - `pull "No Such Flow"` (MCP unreachable, so the remote lookup fails and
     the ref falls through): fails, and its message does **not** tell the user
     to pull it first. A regression guard — it passes today. Assert that
     `ENABLE_MCP_HINT` and `/pull it first/` are absent; never a bare
     `/pull/`, which "pulled workflows" and the "could not list remote
     workflows" warning both contain.

**Boundaries.** Write only those two files. Do not touch `lib/`,
`n8n-decanter.mts`, `test/e2e.mts` or any existing test. You do not need to
open `test/e2e.mts` beyond its mock at lines 290–400 if you want a reference;
do not read it whole. Do not read the operator plan's "Tasks" section — test
the contract above, not a structure.

**Where.** This worktree and branch. Do not commit.

**Test command.** `node --test test/unit/api-not-found.test.mts test/unit/rest-prerequisite.test.mts`
— report, per case, red or green and the one-line reason.

## Phase `code` — cut-sonnet, 40 turns

**Objective.** The tests from phase `tests` pass, and the whole suite stays
green: the 404 hint and the shared not-pulled message from the contract above
are implemented, and every in-scope site uses the shared definition.

**Files** (only these): `lib/api.mts`, `lib/mcp.mts`, `lib/executions.mts`,
`lib/backup.mts`, `lib/push.mts`, `lib/watch.mts`, `n8n-decanter.mts`.

**Boundaries.** Do not edit anything under `test/` — the tests are fixed. Do
not touch docs, `CHANGELOG.md` or `PLAN.md`; phase `docs` owns them right now.
Add no MCP call to `executions` or `backup`. In `lib/api.mts` touch only the
`!res.ok` branch of `#request` (around line 172) and add a small path-matching
helper next to `scopeHint` if useful; leave 401/403 as they are. Grep for the
sites; you do not need to read `n8n-decanter.mts` (1,200+ lines) beyond
`resolveRef` (around 683–698) and the lines the contract names. Comments
explain why, matching the surrounding density.

**Where.** This worktree and branch. Do not commit.

**Test command.** `npm run typecheck && npm run lint && npm test` (about 80 s).
For a fast loop first: `node --test test/unit/api-not-found.test.mts test/unit/rest-prerequisite.test.mts test/unit/push-drift-hint.test.mts`.

## Phase `docs` — cut-qwen, 20 turns

**Objective.** The prerequisite chain is written down once, in prose, and the
changelog and design doc say what changed.

**Files** (only these): `docs/cli/overview.md`, `docs/cli/executions.md`,
`docs/cli/backup.md`, `docs/faq/troubleshooting.md`, `CHANGELOG.md`,
`PLAN.md`.

1. `docs/cli/overview.md` — a short new section after "Offline vs. online"
   (line ~142), e.g. `## Which verbs need a pulled workflow`. Say plainly:
   - **Need the workflow pulled** into the local mirror: `push`, `diff`,
     `watch`, `preflight`, `test`, `scenario`, `executions` (also
     `executions <id>` — the execution's workflow must be pulled), `backup`.
   - **Do not**: `pull` (it creates the mirror), `list` (`list --remote`
     shows unpulled ones), `data-tables` (tables are project-scoped),
     `publish`/`unpublish` (they act on the instance by id — but a workflow
     that is not pulled yet is addressed by its **id**: a name only resolves
     against pulled workflows, except for `pull`, which also searches the
     instance).
   - The chain for a workflow just built in the n8n UI: **create it → turn on
     MCP access for it** (workflow card ⋯ menu in the workflows list, or the
     workflow settings) **→ `pull` → now the verbs above work.** A workflow
     without MCP access cannot be pulled.
   Links name site-root paths (`/docs/cli/pull/`), never a host.
2. `docs/cli/executions.md` and `docs/cli/backup.md` — one sentence each
   saying the workflow must be pulled first, linking to the new section
   (`/docs/cli/overview/#which-verbs-need-a-pulled-workflow` — match the anchor
   to the heading you write).
   `docs/faq/troubleshooting.md` — its `"no workflow matches"` section (around
   line 262) only says "use more of the name, or the id". Add one sentence: if
   the workflow was never pulled, that is the cause — link the same section.
3. `CHANGELOG.md` — under `## [Unreleased]`: the Fixed entry goes in the
   existing `### Fixed` (line ~26); `[Unreleased]` has no `### Changed` yet,
   so create it between `### Added` and `### Fixed` (Keep a Changelog order):
   - Fixed: a REST 404 (`executions <id>`, `backup create`) now explains the
     cause — the execution or workflow does not exist on the instance —
     instead of only surfacing the raw HTTP status.
   - Changed: the `pull it first` / `no workflow matches` errors now also name
     the MCP opt-in that `pull` needs.
   Written for users, matching the neighbouring entries' style.
4. `PLAN.md` — two or three sentences next to where it says `lib/api.mts`
   serves only what MCP cannot (grep `api.mts` and `REST` around lines
   121–140): the REST verbs address only pulled workflows, so the user-facing
   chain is create → opt in to MCP → pull; the not-pulled errors carry that
   chain from one shared definition in `lib/mcp.mts`, and a REST 404 on
   `/executions/<id>` and `/workflows/<id>` carries a per-endpoint hint.

**Boundaries.** No README change (no verb or flag changed). Do not touch
`lib/`, `n8n-decanter.mts` or `test/`. Do not read `PLAN.md` or `CHANGELOG.md`
whole — grep, then read about 60 lines around the spot.

**Where.** This worktree and branch. Do not commit.

**Test command.** `npm run check:docs`.

## Status

- Gate review (cut-review, 2026-10-25): 5 findings, all `technical`, all
  applied — listed the `e2e.mts:2514` assertion; added
  `docs/faq/troubleshooting.md` to `docs`; `### Changed` has to be created;
  child env carries the credentials; no bare `/pull/` regex. No `plan`
  findings. It confirmed every cited line, the `pull` exception, the docs
  verb classification, and that `diff.mts:125` stays out.
- Phase 0 review (cut-review, two rounds, 2026-10-25): round 1, 6 `fix`
  findings, all sent back and fixed — the 404 hint could match too many paths;
  the `GET <path> failed: 404 Not Found` line was not pinned; no check that the
  chain stays off `executions 999`; nothing reached `lib/executions.mts:132`;
  `nothing pulled yet` was not pinned; nothing guarded the push drift abort,
  now `test/unit/push-drift-hint.test.mts`. Round 2: none. No `plan` findings.
  17 behaviours pinned.
- End review: —
