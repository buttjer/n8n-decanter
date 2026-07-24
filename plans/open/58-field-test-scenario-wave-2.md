# Plan 58 — Field-test wave 2: full-surface scenarios seeded from real n8n workflows

**Status:** Not started
**Priority:** P2 — the harness exists and works ([Plan 35](35-blind-agent-field-test.md));
this widens *what* it tests. Task 1 (seed packs) is P1 within the plan: every
other task depends on it.
**Source:** extends [Plan 35](35-blind-agent-field-test.md) (S1–S5); maintainer
request 2026-07-24 ("more scenarios, use all functionality, look through the
docs for edge cases, start from real workflows instead of greenfield").
**Snapshot:** 2026-07-24T13:28Z @ 9f3a78a
**Theme:** S1–S5 cover the **authoring loop** on **hand-built greenfield**
workflows. Everything downstream of authoring — the verification ladder
(`preflight`/`simulate`/`executions`/`scenario`), disaster recovery (`backup`),
the publish lifecycle, bulk/config surfaces, and every documented failure mode —
has **never met a blind agent**, and nothing has ever been tested on a workflow
decanter didn't create. This plan adds a **seed-pack** mechanism that imports
real n8n workflows and seven scenarios (S6–S12) that close the verb coverage gap.
**Model:** Opus for the harness/seed work + grading; **Sonnet stays fixed for the
blind user agents** (Plan 35's maintainer call).

## Why

- **Coverage.** Of the ~20 verbs on the [command surface](../../docs/cli/overview.md),
  S1–S5 exercise about half. The half they miss is the half the docs call the
  *agent contract* — `preflight --json` is documented as "the one gate an agent
  needs before push/publish" and **no agent has ever run it**.
- **Greenfield is the easy case.** Every scenario so far starts from a workflow
  the harness hand-built out of four node types, with decanter-shaped names and
  no history. Real users adopt workflows they did not write: legacy node types,
  credential refs, punctuation in names, 17–29 nodes, no captures.
- **The docs are a written-down list of edge cases nobody has field-tested** —
  drift, ambiguous refs, the MCP availability gate, gap hard-errors, synthetic
  pins, "green means well-formed, not live", the not-auto-committed backup, the
  troubleshooting FAQ. Each is a claim about how a user recovers; the field test
  is the only thing that checks whether they actually do.

## What exists today — the answer to "can the harness start from given workflows?"

**No. There is no import path, and every seeded workflow is hand-built.**

- [`stage.mts`](../../test/field-test/stage.mts) defines a hardcoded `SEEDS`
  array of **4** workflows assembled by inline builders (`manualTrigger`,
  `scheduleTrigger`, `codeNode`, `noOp`, `chain`) and `POST`s them to
  `/api/v1/workflows`. They exist to serve S1–S4: an S1 skeleton (empty Code
  node), an S4 archive target, a realism filler, and one deliberately left
  `availableInMCP: false`.
- Seeds are **not selectable per scenario** — the same four are created every
  run; a scenario finds its target by `kind` in the manifest.
- There is **no** JSON import, no external corpus, no capture/pin seeding, and
  no way to point the stage at a workflow file or URL.

So Task 1 is to build that feature, not to configure one.

## The corpus — `n8n-io/test-workflows` (verified 2026-07-24)

n8n's **own** node-integration test workflows: 237 files under `workflows/`, with
matching `snapshots/<n>-snapshot.json` expected-output files. Measured facts (a
full scan of the corpus, not a sample):

| Fact | Number | Why it matters here |
| --- | --- | --- |
| workflows | 237 | more than enough; pick a curated handful |
| contain a Code/Function-family node | 67 | the rest are pure integration graphs |
| use the **modern** `n8n-nodes-base.code` | **10** | all LangChain/AI graphs (7–29 nodes, 2–14 credential refs), each with exactly 1 Code node |
| use the **legacy** `n8n-nodes-base.function` / `functionItem` | 56 / 5 | decanter extracts **only** `n8n-nodes-base.code` ([`lib/util.mts:4`](../../lib/util.mts)) — these are a blind spot |
| use `n8n-nodes-base.start` | 208 | **that node type no longer ships in n8n 2.30.7** (the `Code`, `Function`, `FunctionItem` node dirs do; `Start` is gone) — raw import lands an unrecognized trigger |
| ship a snapshot | most | shape is `data.resultData.runData["<Node>"][0]…` — **exactly** what decanter's `executions/<id>.json` captures and scenarios need ([`lib/simulate.mts:143`](../../lib/simulate.mts)) |

Concrete picks named in the scenarios below:

- `92.json` — *IF*, 24 nodes, **4 legacy `function` nodes, 0 credentials**: the
  legacy blind spot in its purest form.
- `259.json` — *ChainQA*, 16 nodes, 1 modern Code node, 3 credential refs,
  LangChain: a realistic inherited AI workflow.
- `235/236/240/247/249.json` — five workflows **all named `SummarizationChain:…`**:
  a natural **ambiguous name-prefix** cluster, free of charge.
- `233.json` / `252.json` — 18 and 29 nodes, 8 and 14 credential refs: scale +
  credential-rebind material for `backup restore`.
- Names carry `:` and `*` (`QdrantVectorStore:*`) — real input for the kebab
  slug rule and its stickiness.

**Licensing / provenance decision.** The repo ships **no license file** (treat as
all-rights-reserved). So: **fetch at stage time, cache gitignored, never commit
the JSON** — the same caution already applied to n8n's SUL-licensed type
material in [Plan 43](../done/43-emulated-globals-surface.md). The stage manifest
records `repo@sha` + filename per seed so a round stays reproducible without
vendoring. Fetching happens on the **host during staging**, never inside the
`--container` fence (which reaches Anthropic only).

## Coverage gap — what S1–S5 leave untested

| Surface | Covered by S1–S5? | Picked up by |
| --- | --- | --- |
| `pull` / `push` / `status` / `check` / `node run` / `test` / `watch` / guard / drift guard / TS conversion / MCP structure + `pull` reconcile | ✅ S1–S5 | — |
| `preflight` (every profile, `--json`, `--require`, coverage honesty) | ❌ **never run** | S7 |
| `simulate` (`--network-none`, `--n8n-version`, gap error, loop preview) | ❌ | S8 |
| `executions` (fetch, published-version warning, `clean`) | ❌ | S7, S11 |
| `scenario create` capture-seeded / `scenario check` / fill loop | partial (S2 `--scaffold` only) | S7 |
| `backup create` / `restore` / `list`, `backupLimit` | ❌ | S9 |
| `publish` on a real trigger, `push --publish`, `unpublish`, live-vs-draft `status` | ❌ (S1's publish is *expected* to fail) | S10 |
| `status --diff` | ❌ | S7, S12 |
| `data-tables` (+ filter/sort/`--all`, `clean`, `dataTables:false` gate) | ❌ | S11 |
| `list --remote` / `--json`, bulk no-ref verbs, non-TTY no-picker contract | partial | S6, S11 |
| `availableInMCP` gate, archived-workflow refusal | incidental | S6, S9 |
| compliance-guard violations, typecheck gate, `--no-typecheck`, deny rules | ❌ | S8, S12 |
| auth/config failure modes (401 / 404 / expired session / direct-MCP misroute, `mcp serve`) | ❌ | S12 |
| workflows decanter **didn't create** (legacy nodes, credentials, punctuation, scale) | ❌ | **all of S6–S12** |

## Design decisions

- **D1 — Seed packs, not more hardcoded seeds.** A pack is a declarative
  manifest; the built-in four become the `builtin` pack so **S1–S5 keep running
  byte-identically**. Scenarios name the pack they need.
- **D2 — Vet + modernize on import, never silently.** A corpus workflow is
  rewritten only by explicit, logged transforms (`start` → `manualTrigger`
  is required on 2.30.7). **`function` → `code` conversion stays OFF by
  default** — the un-converted workflow *is* the interesting case.
- **D3 — Credential refs are kept.** They are what makes `backup restore`'s
  rebind hints and `test`/`simulate` pinning real. Nothing on the throwaway
  instance can resolve them, which is the point: the pin path must hold.
- **D4 — Snapshots become captures.** Installing `snapshots/<n>-snapshot.json`
  as `executions/<id>.json` gives S7/S8 **real capture-provenance** pin data —
  so capture-diff semantics (exit 1 on divergence) get tested, not only the
  synthetic-pins path S2 reached.
- **D5 — One scenario, one theme.** Each new scenario is 2–4 turns and grades a
  coherent user intent, not a verb checklist. A verb appears in the scenario
  where a real user would reach for it.

## Tasks

1. **Seed-pack mechanism** — `test/field-test/seeds/<pack>.json` + a loader in
   [`stage.mts`](../../test/field-test/stage.mts), selected by
   `--seeds <pack>` / `FIELD_SEED_PACK` (default `builtin`). Each entry:
   `{ source: "n8n-io/test-workflows@<sha>", file: "259.json", as: { name?, kind,
   availableInMCP, transforms: [...] } }` — or `{ inline: <builder id> }` for the
   existing hand-built four. The loader fetches to a **gitignored cache under
   `harnessRoot`**, applies transforms, `POST`s via REST, toggles
   `availableInMCP`, and records `{ id, name, slug, kind, origin: { repo, sha,
   file }, nodeTypes, codeNodes, credentialRefs }` in the manifest.
2. **Vet + modernize pass** — refuse (with a named reason) any seed whose node
   types aren't registered on the target instance; rewrite `n8n-nodes-base.start`
   → `manualTrigger`; drop `active`; log every transform applied. A pack that
   can't be seeded fails the **stage**, never a scenario mid-round.
3. **Capture seeding** — a `seed-capture` preHook that writes a corpus snapshot
   into `workflows/<slug>/executions/<id>.json` (the snapshot already carries
   `data.resultData.runData`; add the `id` the capture format expects).
4. **New preHooks in [`run.mts`](../../test/field-test/run.mts)** — alongside the
   existing `remote-drift`: `seed-capture`, `publish-then-drift`,
   `revoke-mcp-access` (toggle `availableInMCP` off), `rotate-mcp-token`
   (invalidate the token), `disable-mcp` (`PATCH /rest/mcp/settings`),
   `inject-layout-violation` (orphan file / dangling `$('…')` / stray marker),
   `misroute-mcp` (rewrite `.mcp.json` to point straight at the instance),
   `fill-backup-store` (N backups, to trip `backupLimit`).
5. **Scenario pack S6–S12** — `test/field-test/scenarios/S6–S12.md`, each with
   persona / beats / success checklist / machine-readable `## Orchestration`
   block, per [`STYLE.md`](../../test/field-test/scenarios/STYLE.md) and the
   blinding rules (never name a verb in a nudge).
6. **`verify.mts` extensions** — legacy `function`/`functionItem` nodes are
   *expected* to be untracked (report as evidence, not a violation); read-only
   verbs must not mutate (`versionId` unchanged across S7/S8); `backup restore`
   produced a **distinct, unpublished** workflow with node ids preserved and the
   source untouched; `executions/` + `data-tables/` never reached git;
   `scenarios/*.json` structurally valid.
7. **Coverage matrix in [`test/field-test/README.md`](../../test/field-test/README.md)** —
   verb × scenario, with an explicit "not covered, because …" row for anything
   deliberately left out (`init` OAuth consent, `completion`). Cross-link from
   Plan 35's scenario section.
8. **Round ergonomics** — document the subset runs (`run.mts <manifest> S7 S9`),
   which scenarios are **host-only** (S5 and S8 need Docker/`fs.watch`), and the
   `FIELD_RUN_BUDGET_MIN` guidance for a 7-scenario round (~21 Sonnet turns).

## New scenarios

### S6 — "I inherited these" (adoption of workflows decanter didn't create)

**Seeds:** `92.json` (24 nodes, 4 legacy `function` nodes, no credentials),
`259.json` (ChainQA, LangChain + credential refs), the five
`SummarizationChain:…` workflows, one of them left `availableInMCP: false`.
**Turn 1:** "A colleague left me these flows in n8n — get them into this repo so
I can review the code, and tell me what's actually editable here."
**Under test:** `list --remote`; pull by name and by id; the **ambiguous
name-prefix** error and whether the agent recovers with more of the name;
kebab slugs for names carrying `:` / `*` and their stickiness; the *Available in
MCP* red third state and its guidance; `check`/`status` on a never-pushed
imported workflow; snapshot/placeholder fidelity on a 16–24 node graph.
**Expected finding (hypothesis):** decanter extracts only
`n8n-nodes-base.code` — a workflow whose logic lives in legacy `function` nodes
pulls down with **zero code files and no warning**, unlike the `pythonCode`
case which does warn ([`lib/validate.mts:232`](../../lib/validate.mts)). Grade
whether the agent notices, and what it tells the user.

### S7 — "Is it safe to ship?" (the verification ladder)

**Seeds:** a corpus workflow **plus its snapshot installed as a real capture**
(`seed-capture`). **Turns:** "before this goes anywhere near production I want to
know it still does the right thing" → a code change → "prove it".
**Under test:** `preflight` (default, `--quick`, `--full`, `--json`,
`--require=test`, `--fail-on=warn`) and whether an agent reads the **coverage
honesty** block rather than the score; `executions` fetch + the
published-version warning; `scenario create --execution` (capture provenance) →
fill → `scenario check`; the **gap hard-error**; capture-diff exit-1 semantics vs.
S2's synthetic-pins labeling; `status --diff`; `test`'s **non-interactive
never-mutate** message ("tested the draft, not your local code").
**Value:** this is the documented agent gate, unexercised.

### S8 — Air-gapped day (offline ladder) · **host-only (Docker)**

**Seeds:** the S7 workflow + a hand-built `splitInBatches` loop workflow in the
`builtin` pack (the corpus has no loop graph worth reusing).
**Turn 1:** "I'm on a plane / the instance is down — can you still check my
edits?"
**Under test:** `preflight --offline`; `simulate` with `--network-none` and
`--n8n-version`; the **multi-batch loop** viewer-only preview vs. the headless
hard-error; `node run` with a fixture, and the **instance-scoped globals**
signposting (`$vars`/`$secrets`/`$evaluateExpression` → "use `test`");
`check --no-typecheck` and a deliberate TS error.

### S9 — "Our n8n died" (disaster recovery)

**Seeds:** `252.json` / `233.json` (14 and 8 credential refs — real rebind
material) with `fill-backup-store` pre-run for the pruning case.
**Turns:** "make me a copy of this I can put back if the instance is lost" →
"the instance is rebuilt, put it back".
**Under test:** `backup create` and the deliberate **not-auto-committed** warning
(does the agent review and `git add`, or leave the recovery point uncommitted —
or worse, commit a full export without looking?); `backup list`; `backup restore`
producing a **new, unpublished** workflow with node ids preserved and the source
untouched; the credential-**rebind hints**; the `<backup>` ref shapes (bare date,
short `versionId`); `backupLimit` pruning. Log any `archive`-vs-`backup`
confusion (Plan 35 already flags that wording trap).

### S10 — Going live (publish lifecycle)

**Seeds:** a schedule-trigger workflow (`builtin`), published mid-scenario, then
`publish-then-drift`.
**Turns:** "put this live on the hourly schedule" → "someone says it's broken,
roll it back" → a fix.
**Under test:** `push --publish` vs. `publish`; `status`'s *live version is older
than the draft* line; `unpublish`; `executions` of a **real** run; drift on a
**published** workflow (draft moves, live doesn't); whether the agent understands
pushes never touch the live version. Complements S1, where the publish failure is
correct n8n behavior rather than a lifecycle test.

### S11 — The whole folder (bulk, data tables, hygiene)

**Seeds:** the full corpus pack (5–6 workflows) + a stage-created **data table**
with rows.
**Turns:** "sync everything and give me a picture of the whole folder" → "what's
in the Orders table?"
**Under test:** bare `pull`/`push`/`status`/`check` with **no refs** across a
multi-workflow config; the **non-TTY contract** (a ref-taking verb with no ref
must error, never block on a picker) — the single most important property for
agent harnesses; `list --json`; `data-tables` with `--filter`/`--sort`/`--limit`/
`--all`; `executions clean` / `data-tables clean`; the `dataTables: false` config
gate; and **git hygiene** — `executions/` and `data-tables/` are self-gitignored
and must never appear in a commit.

### S12 — Broken environment (the troubleshooting FAQ as a rubric)

**Seeds:** any; the preHooks do the damage — `revoke-mcp-access`,
`rotate-mcp-token` (401), `disable-mcp` (404), `inject-layout-violation`,
`misroute-mcp` (`.mcp.json` pointed straight at the instance).
**Turns:** ordinary requests ("just push my change") against a broken setup.
**Under test:** does each error message get a blind agent to the fix documented
in [troubleshooting](../../docs/faq/troubleshooting.md) **without a nudge** —
"not available in MCP", "MCP token was rejected (401)", "no MCP endpoint (404)",
a compliance violation that `--force` deliberately does **not** bypass (and the
deny rule that refuses `push --force` anyway), and the `mcp-route-check` nudge
firing on a directly-pointed MCP config — the one offender Plan 35's review noted
has **no default-path trigger**, plus `mcp serve` as the URL-configured
alternative. Every message that fails to route the agent is a **product finding
with an exact surface attached**.

## Acceptance / verification

1. `node test/field-test/stage.mts --seeds corpus-v1` boots, vets, seeds, and
   prints a manifest whose `seeded[]` carries `origin: {repo, sha, file}` and the
   applied transforms; `--seeds builtin` (the default) reproduces today's stage
   exactly, and **S1–S5 still run unchanged**.
2. `run.mts <manifest> S6 … S12 --dry-run` prints every filled turn and spawns
   nothing; each new scenario file has a valid `## Orchestration` block.
3. One fenced (`--container`) round of S6, S7, S9, S10, S11, S12 completes,
   `verify.mts` produces a verdict per scenario, and the round **auto-archives**
   to `test/field-test/runs/<iso>-<runId>/` (raw + report) — **committed**, per
   the Plan 35 archive rule. S8 runs host-only in the same pass.
4. `verify.mts`'s new invariants demonstrably fail when violated (prove each with
   a hand-broken fixture — the machinery must not be first exercised by a real,
   expensive round; this mirrors the existing
   [`test/unit/field-report.test.mts`](../../test/unit/field-report.test.mts)
   discipline).
5. No corpus JSON in git; the fetch cache is gitignored and lives under
   `harnessRoot` (blinding: the agent can't see provenance).
6. `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:docs` stay green.
7. The README coverage matrix accounts for **every** verb — covered, or covered
   with a stated reason for the gap.

## Non-goals

- Not a CI suite (cost + nondeterminism — Plan 35's standing rule).
- **Not fixing what the round finds.** Findings are the deliverable; product
  fixes are separate plans.
- Not vendoring the corpus, and not depending on it at runtime — a pack that
  can't be fetched fails the stage with a clear message, and `builtin` still works
  fully offline.
- No new product verbs, no changes to the LLM grading pass, no `init` OAuth
  browser-consent coverage (e2e owns it).

## Notes

- **Changelog / docs:** none. This is test-harness-only work with no user-facing
  surface — per `AGENTS.md`, internal and test-only changes get no `CHANGELOG.md`
  entry and no `/docs` page. `test/field-test/README.md` is the surface that must
  stay current.
- **PLAN.md:** unaffected — no data-model or flow change.
- **Cost:** ~21 Sonnet turns for a full 7-scenario round; scenarios are
  independently runnable, so the practical unit is 2–3 scenarios per round.
- **Hypotheses to confirm or refute** (write them down *before* the round so the
  grading isn't hindsight): the legacy `function`-node blind spot; slug behavior
  on `:`/`*` names; the `SummarizationChain:…` ambiguous-prefix recovery;
  `backup create`'s uncommitted recovery point; whether an agent reads
  `preflight`'s coverage block or just its score; whether the non-TTY no-ref
  contract holds everywhere.
