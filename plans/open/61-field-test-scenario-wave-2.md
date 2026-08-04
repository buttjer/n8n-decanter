# Plan 61 — Field-test wave 2: the surfaces no blind agent has ever touched

**Status:** Not started
**Priority:** P2 — the harness is finished and proven ([Plan 35](../done/35-blind-agent-field-test.md),
22 archived rounds); this widens *what* it tests. **Sequenced behind the
field-report bugfix wave** ([Plan 63](63-field-feedback-bugfixes.md),
[65](../draft/65-three-gate-scenario-mismatch.md),
[68](../draft/68-live-mirror-visibility.md)) — running it first would spend
Sonnet rounds re-finding defects that are already written down.
**Source:** extends [Plan 35](../done/35-blind-agent-field-test.md) (S1–S6);
maintainer request 2026-07-24 ("more scenarios, use all functionality, look
through the docs for edge cases, start from real workflows instead of
greenfield"); **reworked 2026-08-04** against the post-Plan-59/60 verb surface
and the 2026-07-30 production field report.
**Snapshot:** 2026-08-04T17:05Z @ 420c4b0 *(previous: 2026-07-24T13:28Z @ 9f3a78a)*
**Theme:** S1–S6 cover the **authoring loop** plus **discoverability**. Everything
downstream of authoring — the verification ladder (`preflight`/`executions`/
`scenario`/`test`), disaster recovery (`backup`), the publish lifecycle,
bulk/config surfaces, and every documented failure mode — has **never met a blind
agent**. Wave 2 is seven scenarios (**S7–S13**) that close that gap, plus the
staging machinery they need.
**Model:** Opus for the harness/seed work + grading; **Sonnet stays fixed for the
blind user agents** (Plan 35's maintainer call).

Half the verb surface — `preflight`, `backup`, the publish lifecycle, the bulk
and failure-mode paths — has never been driven by a blind agent, and the parts
that were measured were measured against verbs Plans 59/60 have since deleted.
Wave 2 adds seven scenarios (S7–S13) plus the staging machinery they need, and
deliberately runs **after** the field-report bugfix wave so its Sonnet turns buy
new findings instead of re-confirming written-down ones.

## What changed since this plan was written (2026-07-24 → 2026-08-04)

This plan was drafted against a CLI and a backlog that have both moved. The
rework below is not cosmetic — two of its premises were falsified.

| Then | Now |
| --- | --- |
| scenarios `S6–S12` | **`S6` is taken** — [Plan 57](../done/57-cli-discoverability-for-agents.md) shipped [`S6.md`](../../test/field-test/scenarios/S6.md) (fresh clone, `FIELD_NO_CLI=1`, 6 rounds, 6 PASS). Wave 2 is **S7–S13** |
| verbs `check` / `status` / `simulate` | **removed** ([Plan 59](../done/59-declutter-verify-verbs.md)/[60](../done/60-preflight-first-verb-surface.md), `REMOVED_VERBS` in [`n8n-decanter.mts:118`](../../n8n-decanter.mts)) → `preflight` (+`--simulate`/`--offline`/`--viewer`/`--execution`/`--scenario`) and `diff` |
| `preflight --quick` / `--full` profiles | **gone** — one gate, tuned by `--json` / `--fail-on` / `--fail-fast` / `--require=<ids>` / `--simulate` / `--offline` |
| "nothing has ever been tested on a workflow decanter didn't create" | **false** — the **2026-07-30 field report** drove a 45-node production workflow (Shopify → eBay, 39 renames) and produced nine plans ([63](63-field-feedback-bugfixes.md)–[71](../draft/71-data-table-writes.md)) |
| Plan 35 open, S1–S5 | Plan 35 **Done**; its `S5` (watch) and the two staging crutches moved to [Plan 62](62-field-test-unrun-conditions.md) |
| — | Only **3 of 22 archived rounds** ran on the post-59/60 verb surface, and all three were S1–S4. Every other round measured verbs that no longer exist |

**Consequence for scope.** The corpus is no longer the *realism* argument — a
real 45-node production workflow already delivered that, offline and for free.
What the corpus still buys is narrow and specific: **legacy `function` nodes,
punctuation in names, an ambiguous-prefix cluster, and scale**. The value of
wave 2 has shifted from "meet a real workflow" to **"meet the half of the verb
surface nobody has ever run, on a surface that was rebuilt twice since it was
last measured"**.

## Why

- **Coverage.** Of the 18 verbs on the [command surface](../../docs/cli/overview.md),
  S1–S6 exercise about half. The half they miss is the half the docs call the
  *agent contract* — `preflight --json` is documented as the gate an agent runs
  before `push`/`publish` and **no blind agent has ever run it**, in either its
  old or its current shape.
- **The ladder was rebuilt underneath the evidence.** Plans 59/60 collapsed
  three verbs into one and changed what "green" means. 19 of 22 rounds grade a
  CLI that no longer exists; the three that don't only cover S1–S4.
- **The docs are a written-down list of edge cases nobody has field-tested** —
  drift, ambiguous refs, the MCP availability gate, scenario gap errors,
  synthetic pins, "green means well-formed, not live", the not-auto-committed
  backup, the troubleshooting FAQ. Each is a claim about how a user recovers.
- **New, entirely unmeasured surface has landed since.** [Plan 64](../done/64-mcp-rename-does-not-rewrite-refs.md)
  shipped a guard that **refuses a `publish_workflow` that would go live broken**
  (#200) and rewrites node references on rename (#198). Both are agent-facing,
  both are brand new, and neither has met a blind agent.

## What exists today — the answer to "can the harness start from given workflows?"

**No. There is no import path, and every seeded workflow is hand-built.**

- [`stage.mts`](../../test/field-test/stage.mts) defines a hardcoded `SEEDS`
  array of **4** workflows assembled by inline builders (`manualTrigger`,
  `scheduleTrigger`, `codeNode`, `noOp`, `chain`) and `POST`s them to
  `/api/v1/workflows`. They exist to serve S1–S4/S6: an S1 skeleton (empty Code
  node), an S4 archive target, a realism filler, and one deliberately left
  `availableInMCP: false`.
- Seeds are **not selectable per scenario** — the same four are created every
  run; a scenario finds its target by `kind` in the manifest.
- There is **no** JSON import, no external corpus, no capture/pin seeding, and
  no way to point the stage at a workflow file or URL.
- Scenario files declare **prerequisites** (`requires` in the `## Orchestration`
  block, #159) and `run.mts` refuses an unmet subset before spending anything —
  new scenarios must carry that field.

**But Task 1 is no longer the plan's bottleneck.** S8 and S11 — the two
highest-value scenarios — need a **capture** and a **published workflow**, not a
corpus. Both are producible from the existing `builtin` seeds against the real
instance the stage already boots (see D4). So the corpus work gates S7/S10/S12
only, and the plan can ship its best half without it.

## The corpus — `n8n-io/test-workflows` (verified 2026-07-24, not re-verified)

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
| ship a snapshot | most | shape is `data.resultData.runData["<Node>"][0]…` — the same shape decanter's `executions/<id>.json` captures carry ([`lib/simulate.mts:142`](../../lib/simulate.mts)) |

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

**One Code node per workflow is the corpus's ceiling.** It is a good source of
*graph* realism and a poor source of *code* realism — which is fine, because the
code layer is exactly what S1–S6 and the 2026-07-30 report already cover.

**Licensing / provenance decision.** The repo ships **no license file** (treat as
all-rights-reserved). So: **fetch at stage time, cache gitignored, never commit
the JSON** — the same caution already applied to n8n's SUL-licensed type
material in [Plan 43](../done/43-emulated-globals-surface.md). The stage manifest
records `repo@sha` + filename per seed so a round stays reproducible without
vendoring. Fetching happens on the **host during staging**, never inside the
`--container` fence (which reaches Anthropic only).

## Coverage gap — what S1–S6 leave untested

| Surface | Covered by S1–S6? | Picked up by |
| --- | --- | --- |
| `pull` / `push` / `diff` / `node run` / `test` / guard / drift guard / TS conversion / MCP structure + `pull` reconcile | ✅ S1–S4 *(only 3 rounds on the current verb surface)* | re-measured incidentally by all of S7–S13 |
| CLI discoverability from a fresh clone | ✅ S6 (6 rounds) | — |
| `watch` | ❌ written, **never run** | [Plan 62](62-field-test-unrun-conditions.md), not this plan |
| `preflight` (`--json`, `--require`, `--fail-on`, `--fail-fast`, coverage honesty) | ❌ **never run, in any shape** | S8 |
| `preflight --simulate` / `--offline` / `--viewer` / `--n8n-version`, loop preview | ❌ | S9 |
| `executions` (fetch, published-version warning, `clean`) | ❌ | S8, S12 |
| `scenario create --execution` (capture provenance) / `scenario check` / fill loop | partial (S2 `--scaffold` only) | S8 |
| `backup create` / `restore` / `list`, `backupLimit` | ❌ | S10 |
| `publish` on a real trigger, `push --publish`, `unpublish`, live-vs-draft reporting | ❌ (S1's publish is *expected* to fail) | S11 |
| **guard publish gate** — a `publish_workflow` refused because it would go live broken ([Plan 64](../done/64-mcp-rename-does-not-rewrite-refs.md), #200) | ❌ **shipped after every round** | S11 |
| **guard rename-ref rewrite** — all four node-reference forms (#198) | ❌ **shipped after every round** | S7 |
| `data-tables` (+ filter/sort/`--all`, `clean`, `dataTables:false` gate) | ❌ | S12 |
| `list --remote` / `--json`, bulk no-ref verbs, non-TTY no-picker contract | partial | S7, S12 |
| `availableInMCP` gate, archived-workflow refusal | incidental | S7, S10 |
| compliance-guard violations, typecheck gate, `--no-typecheck`, deny rules | ❌ | S9, S13 |
| auth/config failure modes (401 / 404 / expired session / direct-MCP misroute, `mcp serve`) | ❌ | S13 |
| workflows decanter **didn't create** (legacy nodes, credentials, punctuation, scale) | ❌ *(covered once by a human's 2026-07-30 report, never by the harness)* | S7, S10, S12 |

## Design decisions

- **D1 — Seed packs, not more hardcoded seeds.** A pack is a declarative
  manifest; the built-in four become the `builtin` pack so **S1–S6 keep running
  byte-identically**. Scenarios name the pack they need.
- **D2 — Vet + modernize on import, never silently.** A corpus workflow is
  rewritten only by explicit, logged transforms (`start` → `manualTrigger`
  is required on 2.30.7). **`function` → `code` conversion stays OFF by
  default** — the un-converted workflow *is* the interesting case.
- **D3 — Credential refs are kept.** They are what makes `backup restore`'s
  rebind hints and `test`/`preflight --simulate` pinning real. Nothing on the
  throwaway instance can resolve them, which is the point: the pin path must
  hold.
- **D4 — Captures come from the instance, not from corpus snapshots.**
  *(Changed 2026-08-04 — the old D4 installed `snapshots/<n>-snapshot.json` as an
  `executions/<id>.json`.)* The stage already boots a real n8n and can **execute
  a seeded workflow**, so `executions <id>` fetches a capture with **genuine
  provenance** — the exact artifact `scenario create --execution` is designed
  around, with no hand-forged `id` and no corpus dependency. Corpus snapshots
  stay available as a fallback for graphs that can't run headlessly.
- **D5 — One scenario, one theme.** Each new scenario is 2–4 turns and grades a
  coherent user intent, not a verb checklist. A verb appears in the scenario
  where a real user would reach for it.
- **D6 — Mechanical facts get proven offline; rounds grade only the reaction.**
  *(New 2026-08-04.)* Several "expected findings" below are product facts
  provable with a unit test or a mock — e.g. "a legacy `function` node yields no
  code file and no warning", or "a `:`/`*` name kebabs to X". **Prove those in
  `test/unit/`, not with Sonnet turns.** The blind round's only job is the part
  a test cannot answer: *what does the agent conclude, and what does it tell the
  user?*

## Progress (2026-08-04)

**The scenario pack is written; the staging machinery is not.** `S7`–`S13` exist
as full specs with `## Orchestration` spines, and the runner now **refuses** a
scenario whose pre-hook or seed kind does not exist — so the specs can sit ahead
of the machinery without any risk of a round quietly measuring an untouched
environment (the failure mode the old bare `if (preHook === "remote-drift")`
allowed). Landed:

- `scenarios/S7–S13.md` (Tasks 4 + 7, the spec half)
- `run.mts`: a pre-hook **registry** + hard refusal of an unknown hook;
  `requiresSeedKinds` + hard refusal of a missing seed kind; `--expect-drift`
  generalised from one hook name to a set
- `test/unit/field-scenarios.test.mts` — every scenario file parses, its id
  matches its filename, `requires` resolves, and no turn leaks
  evaluation-signalling vocabulary or a Plan 59-removed verb (offline, in
  `npm test`)
- the verb × scenario coverage matrix in `test/field-test/README.md` (Task 10)

### Wave 2a machinery — built and validated against a live n8n (2026-08-04)

**Wave 2a is complete: S8, S9, S11 and S13 are runnable.** Every piece was
exercised against a real n8n 2.30.7 in Docker before being called done (the
plan's acceptance criterion 4), one hook at a time via the new `--hook=<name>`
diagnostic:

- **Seed packs** — `stage.mts --seeds <pack>` / `FIELD_SEED_PACK`. `builtin`
  (default) reproduces every earlier round's world byte-for-byte; `wave2` adds
  `s8-ladder` (two chained Code nodes, so a run gives the second one a real
  *input* sample — a single self-contained node would reproduce exactly the
  synthetic-pin shape S8 exists to move past) and `loop-preview` (a
  `splitInBatches` loop, which needs explicit two-output connections the
  straight-line `chain()` helper cannot express).
- **All nine pre-hooks**, each verified end to end: `seed-capture`,
  `publish-then-drift`, `break-published-draft`, `revoke-mcp-access`,
  `rotate-mcp-token`, `disable-mcp`, `inject-layout-violation`, `misroute-mcp`
  (plus the pre-existing `remote-drift`).
- **`--hook=<name>`** — play one hook and exit. The hooks are the only part of
  the harness that mutates a real n8n, and until now the only way to exercise
  one was to spend a scenario.
- **The owner cookie** is carried in the manifest (redacted in archives): n8n's
  internal `/rest/mcp/*` surface is the only way to revoke MCP availability,
  rotate the token, or switch the server off.

**Verified facts, not assumptions:** `test_workflow(workflowId, pinData:{})` is
the synchronous execution path (`execute_workflow` returns `{status:"started"}`
and needs polling); both persist a normal execution with full
`resultData.runData`. The injected layout violation produces the exact refusal
S13 grades; the rotated token produces the exact 401.

**One product finding fell out, offline and for free** — the D6 principle in
action: a switched-off MCP server answers **403**, never 404, and decanter has
no message for it → [Plan 74](../draft/74-mcp-disabled-403.md). `AGENTS.md`'s
"404 when disabled" claim is corrected in the same change.

**Still to build:** the corpus seed-pack loader and its vet/modernize pass
(Tasks 5 + 6) and `fill-backup-store`, which gate **S7, S10 and S12** — wave 2b.

## Tasks

Split into two waves so the corpus work does not gate the best scenarios.

### Wave 2a — no corpus needed

1. **Capture seeding (D4)** — a stage step / `seed-capture` preHook that
   **executes** a `builtin` seed on the instance and leaves the execution id in
   the manifest, so a scenario can fetch it with `executions`. Fallback path:
   install a corpus snapshot as `workflows/<slug>/executions/<id>.json`.
2. **Lifecycle preHooks in [`run.mts`](../../test/field-test/run.mts)** —
   alongside the existing `remote-drift`: `publish-then-drift`,
   `break-published-draft` (leave the draft in a state the Plan 64 publish gate
   must refuse), `fill-backup-store` (N backups, to trip `backupLimit`).
3. **Failure-mode preHooks** — `revoke-mcp-access` (toggle `availableInMCP`
   off), `rotate-mcp-token` (401), `disable-mcp` (`PATCH /rest/mcp/settings`
   → 404), `inject-layout-violation` (orphan file / dangling `$('…')` / stray
   marker), `misroute-mcp` (rewrite `.mcp.json` to point straight at the
   instance).
4. **Scenarios S8, S11, S13** — the verification ladder, the publish lifecycle,
   the broken environment. Each with persona / beats / success checklist /
   machine-readable `## Orchestration` block **including `requires`**, per
   [`STYLE.md`](../../test/field-test/scenarios/STYLE.md) and the blinding rules
   (never name a verb in a nudge).

### Wave 2b — corpus-dependent

5. **Seed-pack mechanism** — `test/field-test/seeds/<pack>.json` + a loader in
   [`stage.mts`](../../test/field-test/stage.mts), selected by
   `--seeds <pack>` / `FIELD_SEED_PACK` (default `builtin`). Each entry:
   `{ source: "n8n-io/test-workflows@<sha>", file: "259.json", as: { name?, kind,
   availableInMCP, transforms: [...] } }` — or `{ inline: <builder id> }` for the
   existing hand-built four. The loader fetches to a **gitignored cache under
   `harnessRoot`**, applies transforms, `POST`s via REST, toggles
   `availableInMCP`, and records `{ id, name, slug, kind, origin: { repo, sha,
   file }, nodeTypes, codeNodes, credentialRefs }` in the manifest.
6. **Vet + modernize pass** — refuse (with a named reason) any seed whose node
   types aren't registered on the target instance; rewrite `n8n-nodes-base.start`
   → `manualTrigger`; drop `active`; log every transform applied. A pack that
   can't be seeded fails the **stage**, never a scenario mid-round.
7. **Scenarios S7, S9, S10, S12** — adoption, the offline ladder, disaster
   recovery, the whole folder.

### Both waves

8. **Offline proofs first (D6)** — before any round: unit tests for the legacy
   `function`/`functionItem` blind spot, kebab slugs for `:`/`*` names and their
   stickiness, and the ambiguous-name-prefix error text. These are the plan's
   cheapest deliverable and they make the round's grading about *messaging*
   rather than *behavior*.
9. **`verify.mts` extensions** — legacy `function`/`functionItem` nodes are
   *expected* to be untracked (report as evidence, not a violation); read-only
   verbs must not mutate (`versionId` unchanged across S8/S9); `backup restore`
   produced a **distinct, unpublished** workflow with node ids preserved and the
   source untouched; `executions/` + `data-tables/` never reached git;
   `scenarios/*.json` structurally valid.
10. **Coverage matrix in [`test/field-test/README.md`](../../test/field-test/README.md)** —
    verb × scenario, with an explicit "not covered, because …" row for anything
    deliberately left out (`init` OAuth consent, `completion`, `watch` → Plan 62).
    No edit to [Plan 35](../done/35-blind-agent-field-test.md): it is Done, its
    close-out already links here, and its scenario section is explicitly
    "historical record, kept as written".
11. **Round ergonomics** — document the subset runs (`run.mts <manifest> S8 S10`),
    which scenarios are **host-only** (S9 needs Docker for `--simulate`), the
    `FIELD_RUN_BUDGET_MIN` guidance, and which [Plan 62](62-field-test-unrun-conditions.md)
    conditions compose with which scenario (e.g. `FIELD_NO_SEED_ENV=1` rides
    along with any wave-2a round at no extra turn cost).

## New scenarios

### S7 — "I inherited these" (adoption of workflows decanter didn't create)

**Seeds:** `92.json` (24 nodes, 4 legacy `function` nodes, no credentials),
`259.json` (ChainQA, LangChain + credential refs), the five
`SummarizationChain:…` workflows, one of them left `availableInMCP: false`.
**Turn 1:** "A colleague left me these flows in n8n — get them into this repo so
I can review the code, and tell me what's actually editable here."
**Under test:** `list --remote`; pull by name and by id; the **ambiguous
name-prefix** error and whether the agent recovers with more of the name;
kebab slugs for names carrying `:` / `*` and their stickiness; the *Available in
MCP* red third state and its guidance; `preflight --offline` on a never-pushed
imported workflow; snapshot/placeholder fidelity on a 16–24 node graph; and —
new since [Plan 64](../done/64-mcp-rename-does-not-rewrite-refs.md) — a rename
over the guard on a graph with **all four node-reference forms**, where the
rewrite has only ever been unit-tested.
**Expected finding (hypothesis, to be *proven offline first* per D6):** decanter
extracts only `n8n-nodes-base.code` — a workflow whose logic lives in legacy
`function` nodes pulls down with **zero code files and no warning**, unlike the
`pythonCode` case which does warn ([`lib/validate.mts:318`](../../lib/validate.mts)).
The round grades only what the agent *notices and says*.

### S8 — "Is it safe to ship?" (the verification ladder) · **highest value**

**Seeds:** a `builtin` workflow **executed at stage time**, so a genuine capture
is fetchable (D4). **Turns:** "before this goes anywhere near production I want to
know it still does the right thing" → a code change → "prove it".
**Under test:** `preflight` (bare, `--json`, `--require=test`, `--fail-on=warn`,
`--fail-fast`) and whether an agent reads the **coverage honesty** block rather
than the score; `executions` fetch + the published-version warning;
`scenario create --execution` (capture provenance) → fill → `scenario check`;
the scenario **gap hard-error**; capture-diff exit-1 semantics vs. S2's
synthetic-pins labeling; `diff`; `test`'s **non-interactive never-mutate**
behavior.
**Value:** this is the documented agent gate, unexercised — and rebuilt by
Plans 59/60 *after* the last round that could have measured it.
**Sequencing:** run **after** [Plan 65](../draft/65-three-gate-scenario-mismatch.md)
lands. Today `scenario check`, `preflight --simulate` and `test` enforce three
different node sets; a round run now would spend its turns rediscovering that.

### S9 — Air-gapped day (offline ladder) · **host-only (Docker)**

**Seeds:** the S8 workflow + a hand-built `splitInBatches` loop workflow in the
`builtin` pack (the corpus has no loop graph worth reusing).
**Turn 1:** "I'm on a plane / the instance is down — can you still check my
edits?"
**Under test:** `preflight --offline`; `preflight --simulate --offline` and
`--n8n-version`; `--viewer` vs. the headless run; the **multi-batch loop**
viewer-only preview vs. the headless hard-error; `node run` with a fixture, and
the **instance-scoped globals** signposting (`$vars`/`$secrets`/
`$evaluateExpression` → "use `test`"); `preflight --offline --no-typecheck` and a
deliberate TS error.
**Sequencing:** the `node run` fidelity beats are **already known-broken** —
[Plan 63](63-field-feedback-bugfixes.md) Task 5 and
[Plan 66](../draft/66-multi-output-pins.md) have `all(1)`/`$items(name, 1)`
returning output 0's items. Land those first or drop the beat; do not spend a
round confirming a written-down bug.

### S10 — "Our n8n died" (disaster recovery)

**Seeds:** `252.json` / `233.json` (14 and 8 credential refs — real rebind
material) with `fill-backup-store` pre-run for the pruning case.
**Turns:** "make me a copy of this I can put back if the instance is lost" →
"the instance is rebuilt, put it back".
**Under test:** `backup create` and the deliberate **not-auto-committed** warning
(does the agent review and `git add`, or leave the recovery point uncommitted —
or worse, commit a full export without looking?); `backup list`; `backup restore`
producing a **new, unpublished** workflow with node ids preserved and the source
untouched; the credential-**rebind hints**; the `<backup>` ref shapes (bare date,
short `versionId`); `backupLimit` pruning ([`lib/config.mts:83`](../../lib/config.mts),
default 20). Log any `archive`-vs-`backup` confusion (Plan 35 already flags that
wording trap).
**Why it survives the re-scope unchanged:** it is the largest decanter-specific
surface that neither the harness nor the 2026-07-30 report has touched at all.

### S11 — Going live (publish lifecycle)

**Seeds:** a schedule-trigger workflow (`builtin`), published mid-scenario, then
`publish-then-drift` and `break-published-draft`.
**Turns:** "put this live on the hourly schedule" → "someone says it's broken,
roll it back" → a fix.
**Under test:** `push --publish` vs. `publish`; the *live version is older than
the draft* reporting (now `preflight`/`diff`, not `status`); `unpublish`;
`executions` of a **real** run; drift on a **published** workflow (draft moves,
live doesn't); whether the agent understands pushes never touch the live version;
and the **Plan 64 guard publish gate** (#200) — an agent's `publish_workflow`
refused because the draft would go live broken, a refusal message no blind agent
has ever seen. Complements S1, where the publish failure is correct n8n behavior
rather than a lifecycle test.

### S12 — The whole folder (bulk, data tables, hygiene)

**Seeds:** the full corpus pack (5–6 workflows) + a stage-created **data table**
with rows.
**Turns:** "sync everything and give me a picture of the whole folder" → "what's
in the Orders table?"
**Under test:** bare `pull`/`push`/`preflight`/`diff` with **no refs** across a
multi-workflow config; the **non-TTY contract** (a ref-taking verb with no ref
must error, never block on a picker) — the single most important property for
agent harnesses; `list --json`; `data-tables` with `--filter`/`--sort`/`--limit`/
`--all`; `executions clean` / `data-tables clean`; the `dataTables: false` config
gate ([`lib/config.mts:81`](../../lib/config.mts)); and **git hygiene** —
`executions/` and `data-tables/` are self-gitignored and must never appear in a
commit.
**Trim note:** data-table support is **read-only** today
([Plan 71](../draft/71-data-table-writes.md) is a feasibility draft), and the
2026-07-30 report already recorded the "user wanted rows changed, agent handed it
back" moment. Keep the reads thin; the scenario's weight is bulk + non-TTY +
hygiene.

### S13 — Broken environment (the troubleshooting FAQ as a rubric)

**Seeds:** any; the preHooks do the damage — `revoke-mcp-access`,
`rotate-mcp-token` (401), `disable-mcp` (404), `inject-layout-violation`,
`misroute-mcp` (`.mcp.json` pointed straight at the instance).
**Turns:** ordinary requests ("just push my change") against a broken setup.
**Under test:** does each error message get a blind agent to the fix documented
in [troubleshooting](../../docs/faq/troubleshooting.md) **without a nudge** —
"not available in MCP", "MCP token was rejected (401)", "no MCP endpoint (404)",
a compliance violation that `--force` deliberately does **not** bypass (and the
template `AGENTS.md` rule that refuses `push --force` anyway), and the
[`mcp-route-check`](../../template/.claude/hooks/mcp-route-check.mjs.example)
nudge firing on a directly-pointed MCP config. Every message that fails to route
the agent is a **product finding with an exact surface attached**.
**Overlap:** [Plan 58](58-guard-route-robustness.md) owns the guard *route*
itself, and #175's `mcpspawn` suite now proves the scaffolded command starts —
so S13 grades the **messages**, not whether the guard runs.
**Also worth staging here:** the sandboxed-credential failure mode
([Plan 70](../draft/70-sandboxed-agent-credentials.md)) — the 2026-07-30 report's
agent needed the sandbox off for *every* decanter call, and no round has ever run
a blind session under a restrictive sandbox.

## Acceptance / verification

1. **Wave 2a alone is shippable.** `run.mts <manifest> S8 S11 S13 --dry-run`
   prints every filled turn and spawns nothing; each new scenario file has a
   valid `## Orchestration` block **with `requires`**; the stage leaves an
   executed workflow's execution id in the manifest.
2. `node test/field-test/stage.mts --seeds corpus-v1` boots, vets, seeds, and
   prints a manifest whose `seeded[]` carries `origin: {repo, sha, file}` and the
   applied transforms; `--seeds builtin` (the default) reproduces today's stage
   exactly, and **S1–S6 still run unchanged**.
3. One fenced (`--container`) round of the wave-2a scenarios completes,
   `verify.mts` produces a verdict per scenario, and the round **auto-archives**
   to `test/field-test/runs/<iso>-<runId>/` (raw + report) — **committed**, per
   the Plan 35 archive rule. S9 runs host-only in a separate pass.
4. `verify.mts`'s new invariants demonstrably fail when violated (prove each with
   a hand-broken fixture — the machinery must not be first exercised by a real,
   expensive round; this mirrors the existing
   [`test/unit/field-report.test.mts`](../../test/unit/field-report.test.mts)
   discipline).
5. The D6 offline proofs exist as unit tests **before** the round that would
   otherwise discover them.
6. No corpus JSON in git; the fetch cache is gitignored and lives under
   `harnessRoot` (blinding: the agent can't see provenance).
7. `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:docs` stay green.
8. The README coverage matrix accounts for **every** verb — covered, or covered
   with a stated reason for the gap.

## Non-goals

- Not a CI suite (cost + nondeterminism — Plan 35's standing rule).
- **Not fixing what the round finds.** Findings are the deliverable; product
  fixes are separate plans.
- **Not re-finding Plans 63–71.** Anything already written down as a defect is
  out of scope for a blind round; land the fix, then measure the fixed surface.
- Not `watch` — that is [Plan 62](62-field-test-unrun-conditions.md)'s S5, along
  with the unassisted-PATH and cold-`init` conditions.
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
- **Cost:** ~9 Sonnet turns for wave 2a (3 scenarios), ~12 more for wave 2b.
  Scenarios are independently runnable, so the practical unit is 2–3 per round.
- **Hypotheses to confirm or refute** (write them down *before* the round so the
  grading isn't hindsight): the legacy `function`-node blind spot; slug behavior
  on `:`/`*` names; the `SummarizationChain:…` ambiguous-prefix recovery;
  `backup create`'s uncommitted recovery point; whether an agent reads
  `preflight`'s coverage block or just its score; whether the Plan 64 publish
  refusal routes an agent to a fix; whether the non-TTY no-ref contract holds
  everywhere.
- **Re-snapshot before executing.** This plan has now been invalidated once by a
  verb-surface rework it did not anticipate; the same check that caught it
  (`git log --oneline <snapshot-hash>..main` + `CHANGELOG.md`) is cheap and
  mandatory per `AGENTS.md`.
