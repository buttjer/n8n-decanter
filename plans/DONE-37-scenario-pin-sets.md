# Plan 37 — `scenario` verb: committed full-workflow pin-data sets (fold mock + fixtures, schema scaffolding)

**Priority:** P2 (data-model consolidation + a differentiator: the durable,
reviewed counterpart to the official skills' ephemeral pin flow)
**Status:** Done (2026-07-22) — `mock`→`scenario` rename, `fixtures/`/`--pin`
fold, per-node provenance + synthetic-pins labeling, and `--scaffold` schema
oracle all shipped; docs/changelog/PLAN updated; unit + e2e + smoke coverage added.
**Model:** Opus for the fold/migration design and provenance semantics; Sonnet
for the mechanical rename sweep and docs.
**Theme:** One word and one committed artifact for "a named, full-workflow
pin-data set": rename `mock` → **`scenario`**, fold the shipped per-node
`fixtures/` mechanism into it, and adopt MCP `prepare_test_pin_data` as a
**schema oracle** for scaffolding gap fills — real captured data stays primary.

## Why

- **Two committed pin artifacts today, three total — concept sprawl.**
  Captures (`executions/`, gitignored temp data), mock scenarios
  (`mocks/<slug>.json`, committed, whole-workflow, gap-fillable), and fixtures
  (`fixtures/<node>.json`, committed, per-node, written by `simulate --pin`,
  precedence over captures — and **not consulted by `test`**, a deviation
  recorded in [Plan 33](DONE-33-post-mcp-pivot-wave.md) Task 5). Two committed
  mechanisms with different formats, precedence rules, and consumer coverage
  is one too many; users must learn when to `--pin` vs. when to `mock`.
- **"mock" is the wrong word for what these are.** They are full-workflow
  pin-data sets for *named input scenarios* (`happy-path`, `empty-cart`),
  long-lived and rooted in real captured data. "Mock" reads as unit-test fake
  objects and is decanter-invented vocabulary; **`scenario`** is understood
  before reading any docs (maintainer decision 2026-07-22 — naming runner-ups
  recorded in Notes).
- **`prepare_test_pin_data` is better-designed than the recorded rationale
  assumed.** Verified from n8n source 2026-07-22
  (`packages/cli/src/modules/mcp/tools/prepare-workflow-pin-data.tool.ts`):
  it returns **JSON Schemas + coverage counts, no data** — `readOnlyHint:
  true`, idempotent; the *caller* authors values. The Plan 33 / PLAN.md
  rejection premise ("server-generated synthetic data is neither reproducible
  nor reviewable") doesn't apply: the server generates no data. As a **schema
  oracle for gap fills** it slots exactly into the existing
  `_decanterMock.fill` design (this PR corrects the stale recorded fact in
  PLAN.md + AGENTS.md alongside).
- **The official n8n skills do this ephemerally; decanter's edge is
  durability.** `n8n-workflow-lifecycle-official` teaches agents the
  `prepare_test_pin_data` → generate values in-session → `test_workflow` flow;
  pins are per-execution and lost. Decanter turns the same tool pair into a
  **committed, human-reviewed, reusable artifact** with a real-data diff
  baseline — composing with the official flow, not competing.

## Source

- [Plan 33](DONE-33-post-mcp-pivot-wave.md) Task 5 deferrals: "Evaluate
  `prepare_test_pin_data` for gap scaffolding (à la `mock create`)" and
  "`fixtures/` overrides not consulted (captures and mocks only)".
- Maintainer decisions in the 2026-07-22 design session: name is `scenario`
  (user understandability as the deciding criterion); **fold `fixtures/` into
  it**; captures/real data stay primary; scaffolding is a secondary source.
- Coordination: [Plan 36](DONE-36-preflight-verb.md)'s `capture` check unlock
  wording (see its "Relation to Plan 37" note).

## Design decisions

- **Name: `scenario`.** The docs one-liner: *"A scenario is a named, committed
  input set for your workflow — captured from a real run or scaffolded from
  its schemas — that `test`/`simulate` replay and diff against."* The slug
  carries the scenario meaning (`happy-path`, `missing-email`); the noun
  doesn't have to encode "pin"/"set" — mechanism vocabulary lives one layer
  down in the docs.
- **One committed artifact.** `workflows/<wf>/scenarios/<slug>.json` is the
  only committed pin artifact. `fixtures/` is retired as a concept: the
  per-node-override role is absorbed — a scenario file *is* the full pin set,
  self-contained (no hybrid "fixture overrides newest capture" precedence to
  reason about). `simulate --pin`'s job ("make a clean capture reproducible")
  is exactly `scenario create --execution <id>`; the flag is removed.
- **Fold decisions (maintainer, 2026-07-22).**
  1. *Legacy `fixtures/` files:* **hard drop** — no deprecation read-path.
     A `fixtures/` dir encountered by `simulate`/`check` is a hard error
     naming the replacement (`scenario create --execution`, then delete the
     dir). Roads not taken: one-release deprecation read-path (prolongs the
     two-artifact state); auto-folding fixtures into a scenario (per-node
     fragments would have to merge onto a gitignored capture — commits data
     the user never reviewed).
  2. *Hybrid precedence:* scenarios are **always self-contained** — a run pins
     from a named scenario *or* a capture, never a mix. The layering variant
     (`--scenario` overlaid on a fresh capture, the old flaky-node `--pin`
     use case) is deferred to [Plan 0](BACKLOG.md) ("Scenario layering over a
     fresh capture").
  3. *Old spelling:* **hard error** — `mock`/`--mock` fail naming
     `scenario`/`--scenario`; no alias release (the template
     allowlist/AGENTS.md teach the new word immediately, an alias would just
     prolong mixed vocabulary). The `mocks/` → `scenarios/` dir migration
     stays automatic and separate from the spelling.
- **Per-node provenance.** The metadata block records where each node's items
  came from: `capture` (real data — can serve as diff baseline), `authored`
  (human/agent-filled), `scaffolded` (schema-guided fill). Consumers label
  results accordingly: a run on a scenario with any non-`capture` nodes is
  reported as **"synthetic pins — proves executability, not output
  correctness"**; per-node diffs only assert against `capture`-provenance
  outputs.
- **Scaffolding never fabricates silently.** `--scaffold` writes
  schema-annotated *fill entries* (the existing gap mechanism, now with an
  `expectedSchema` per node) — it does not invent values. Filling stays an
  explicit authoring step (`scenario check` validates), so every committed
  value was written by a person or their agent and reviewed in the diff.

## Tasks

1. **Rename sweep (mechanical).** `mock` namespace → `scenario`
   (`scenario create` / `scenario check`), `--mock` → `--scenario` on
   `simulate`/`test`, `MOCKS_DIR` `mocks/` → `scenarios/`. Touches
   [lib/executions.mts](../lib/executions.mts) (dir const + writeMock),
   [lib/simulate.mts](../lib/simulate.mts) (source resolution, error guidance
   strings), [lib/validate.mts](../lib/validate.mts) (the inline-code snapshot
   warning + reserved-subdir comment), [n8n-decanter.mts](../n8n-decanter.mts)
   (dispatch, help), picker menu labels. Metadata block `_decanterMock` →
   `_decanterScenario` (reader accepts both). Post-#107 template surfaces:
   the scaffolded Claude Code allowlist's `Bash(n8n-decanter mock)` /
   `mock:*` entries
   ([template/.claude/settings.local.json.example](../template/.claude/settings.local.json.example))
   and the "Filling simulation gaps (`mocks/` — committed scenarios)" section
   in [template/AGENTS.md.example](../template/AGENTS.md.example).
2. **Migration + compat.** On any verb touching the dir: auto-migrate
   `mocks/<slug>.json` → `scenarios/<slug>.json` (git-aware move semantics like
   pull's rename machinery; refuse on collision). Legacy `fixtures/` files:
   **hard error** (fold decision 1) from `simulate` and `check` naming the
   replacement (`scenario create --execution`, then delete `fixtures/`) — no
   read path, no silent ignore. `mock`/`--mock` hard-error with the new
   spelling (fold decision 3; breaking, 0.x).
3. **Fold fixtures.** Remove `simulate --pin`, `readFixtures`, and the
   fixture-precedence merge in `buildSimulation` (`itemsFor` reads one
   source); `warnStaleFixtures` generalizes to scenario staleness (scenario
   records `workflowVersionId`, warn when older than the draft — machinery
   exists). `Fixture`'s `source: "capture" | "llm-guess"` semantics migrate
   into the per-node provenance model.
4. **Scaffold source.** `scenario create <slug> --scaffold`: calls MCP
   `prepare_test_pin_data` (input `{workflowId}`; output
   `nodeSchemasToGenerate` / `nodesWithoutSchema` / `nodesSkipped` /
   `coverage` — shape source-verified 2026-07-22, **smoke-assert it live**),
   writes fill entries with `expectedSchema` per node (`nodesWithoutSchema` →
   fill entry with the documented empty-json guidance), provenance
   `scaffolded`, prints the coverage summary. Composable with `--execution`:
   capture seeds what it covers, scaffold annotates the remaining gaps.
   Read-only wire footprint (workflow read + the prepare tool). Offline /
   no-MCP → clear error naming the capture-based alternative.
5. **Consumers + labeling.** `test`/`simulate` take `--scenario <slug>`;
   provenance drives the report label and `--json` fields
   (`pinnedProvenance`, `syntheticPins: true/false`); diff exit semantics
   unchanged for capture-provenance scenarios, "executability only" wording
   (no per-node diff asserted) for synthetic ones.
6. **Preflight tie-in ([Plan 36](DONE-36-preflight-verb.md)).** The `capture`
   check's unlock names both paths (`executions` capture or
   `scenario create --scaffold`); scaffolded-only runtime coverage is scored
   as partial and labeled. (Wording coordinated via Plan 36's relation note;
   the scoring itself lands with whichever plan executes second.)
7. **Docs + bookkeeping (all surfaces, one PR).**
   [docs/cli/mock.md](../docs/cli/mock.md) → `docs/cli/scenario.md` (rewrite
   around the one-artifact story; "Not `--pin`" section retired);
   [simulate.md](../docs/cli/simulate.md)/[test.md](../docs/cli/test.md)
   flag + loop updates; [overview](../docs/cli/overview.md) command surface;
   README commands + feature bullet; CHANGELOG `[Unreleased]` **Breaking:**
   entries (verb rename, flag rename, dir rename + auto-migration, `--pin`
   removal) and Added (schema scaffolding); **PLAN.md** design section rewrite
   (one pin-artifact model, provenance, scaffold flow); template `AGENTS.md`
   loop mentions; [Plan 0](BACKLOG.md) distinctive-features entry (committed
   scenario library + schema-scaffolded gap fills).

## Acceptance / verification

- One committed artifact: `scenario create/check` + `--scenario` everywhere;
  a legacy `mocks/` dir migrates automatically; a legacy `fixtures/` dir is a
  hard error naming the replacement; `--pin` and `--mock` are gone from help
  and docs.
- `--scaffold` writes a reviewable, schema-annotated scenario **without
  inventing values**; wire-log shows read-only calls only; the smoke suite
  asserts the live `prepare_test_pin_data` response shape against the
  recorded one.
- A run on a scaffolded/authored scenario is labeled "synthetic pins —
  executability only" in text and `--json`; capture-provenance scenarios keep
  full per-node diff semantics byte-identically to today.
- E2e: create (capture seed + scaffold + combined), check, migration,
  `--scenario` passthrough on test/simulate, provenance labels. Unit:
  provenance resolution, migration edge cases, dual-format metadata reader.
- Grep `mock`/`fixtures` across README, `/docs`, help output finds only
  historical/changelog references.

## Notes

- **Breaking (0.x → minor at next release):** `mock` → `scenario` verbs,
  `--mock` → `--scenario`, `mocks/` → `scenarios/` (auto-migrated),
  `simulate --pin` + `fixtures/` removed outright (a leftover `fixtures/` dir
  hard-errors with the replacement). Each gets its own **Breaking:**
  changelog line.
- **Recorded-fact correction shipped with this plan PR** (not deferred to
  execution): PLAN.md's and AGENTS.md's `prepare_test_pin_data` notes said
  "server-generated synthetic data"; the tool returns schemas only. Corrected
  so the design record doesn't mislead the next reader.
- **Naming runner-ups** (2026-07-22, for the record): `pinset`
  (mechanism-true, n8n vocabulary), `fixture` (conventional but collided with
  the shipped `fixtures/` it replaces), `pindata`, `baseline`, `seed`.
  `scenario` won on "the user understands it before reading docs".
- **Relation to the official skills + the #107 guard (skills-first surface):**
  `n8n-workflow-lifecycle-official` documents the in-session pin protocol
  (schemas → agent-generated values → `test_workflow`, per-execution,
  unpersisted). The #107 guard (`mcp serve`/`mcp connect`) blocks **only**
  jsCode-writing `update_workflow` — `prepare_test_pin_data` and
  `test_workflow` pass through — so guard-wired agents can already run that
  ephemeral flow today. decanter persists, reviews, and versions the same
  data; an agent fills a scenario once and commits instead of re-improvising
  pins every session. The now-shipped
  [docs/agents/n8n-skills.md](../docs/agents/n8n-skills.md) chapter (which
  recommends exactly that lifecycle skill) gets the one-line pointer to
  scenarios as the durable counterpart. decanter's own `--scaffold` uses its
  own MCP client (`.decanter-auth.json`), not the guard — no coupling.
- **Relation to [Plan 36](DONE-36-preflight-verb.md):** independent — either
  can land first; the losing side sweeps the other's wording (tracked in both
  plans' relation notes).
