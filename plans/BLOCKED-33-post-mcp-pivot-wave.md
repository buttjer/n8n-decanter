# Plan 33 — Post-MCP-pivot wave: Plan 32 review, `test` verb, guard-proxy stack, API-optional

**Priority:** P2 (review gate is P1 once Plan 32 lands)
**Status:** Blocked — hard gate: starts only after [Plan 32](OPEN-32-mcp-native-code-layer.md)
is **fully executed**. Do not start any task (including the review) before that,
and do not amend Plan 32 from here — it executes as written.
**Theme:** Everything queued *behind* the MCP pivot: verify Plan 32's execution
against the review checklist, apply the maintainer's standing decisions where the
execution left choices open, then ship the follow-up wave — the `test` verb, the
guard-proxy stack (proxy + slim hooks + proxy-first override), and the
API-optional end goal.
**Model:** Opus for the proxy/`test` design tasks; Sonnet for the mechanical
review + docs passes.

## Why

Reviewing Plan 32 (2026-07-22, maintainer + agent session) surfaced three kinds
of material that deliberately do **not** belong in Plan 32 itself:

1. **Verification gaps** — invariants Plan 32 implies but never spells out
   (validate-gate carryover, no-inline-source-in-git, node-verb re-design), to be
   checked against the finished execution rather than pre-legislated.
2. **Standing maintainer decisions** — answers to decision points Plan 32's
   tasks leave open (Task 4 triage: `delete`→`archive`, `create`/`duplicate`→MCP,
   API-optional). If the execution chose differently, these decisions drive
   follow-up changes here — they are not retroactive criticism of the executor.
3. **A follow-up wave** — new capabilities that only make sense on the MCP
   foundation: an instance-side `test` verb, technical enforcement of the
   Code-node boundary (today it is instructions-only), and demoting the public
   API key to an optional extra.

During the review the MCP tool surface was re-verified against current docs and
the [n8n-io/skills](https://github.com/n8n-io/skills) repo; several spike-era
facts drifted (see Notes → MCP tooling facts) — the AGENTS.md facts update
(Task 6) corrects the repo's record.

## Source

- Session 2026-07-22 (Plan 32 review with the maintainer); collected in the
  agent memory note `plan32-execution-review-checklist` — this plan is its repo
  mirror and supersedes it as the single source once merged.
- [Plan 32](OPEN-32-mcp-native-code-layer.md) — the gate and foundation.
- [Plan 30](OPEN-30-agent-llm-working-ergonomics.md) — the precedence-override
  lineage (Task 3 here rewrites it proxy-first) and the "override, not fork"
  skills decision this plan inherits.
- [Plan 0](BACKLOG.md) — the decanter-native code-node authoring skill
  (deferred out of this plan, distinctive-features group).

## Tasks

1. **Review gate — verify Plan 32's execution** (P1, first, blocking the rest):
   - **Validate-gate carryover (push side):** referenced-file-exists, no
     `@ts-n8n` marker in `.js`, no imports in `.js`, and
     TS-compile-failure-aborts-push all still gate the MCP push path
     (`lib/validate.mts` survivors were never enumerated in Plan 32).
     Placeholder leak itself is structurally impossible post-pivot — push builds
     payloads from files and MCP has no full-JSON write — confirm that held.
   - **No inline source in git-tracked JSON (pull side):** any git-tracked
     workflow/structure JSON (incl. Plan 32 Task 6's read-only snapshot, if
     built) contains `//@file:` placeholders or omits `jsCode` — never inline
     Code-node source. If no acceptance criterion enforces this, add one now.
   - **`node create` / `node rename`:** both were missing from Plan 32 Task 4's
     triage yet break under jsCode-only push (offline structure edits relied on
     the whole-object PUT). Verify how they were re-expressed (MCP
     `addNode`/`renameNode` half + local scaffold/mapping) — if stranded, fix
     here.
   - **Credentials:** `init` provisions OAuth (MCP) and treats the public API
     key per the standing decision below; `executions` re-base decision
     recorded (MCP `get_execution`/`search_executions` exist —
     `includeData: true` returns full per-node data with node filter + item
     truncation; was it used, or was the API kept deliberately for full run
     JSON?). `data-tables` rows must still be API-based (docs-confirmed: MCP
     has no row-read tool).
   - **Process:** PLAN.md was rewritten (not patched) with sign-off before
     Task 2; docs + changelog carry the **Breaking:** entries; the Task 9
     override landed in the template sync-dir `AGENTS.md`.
2. **Apply the standing Task 4 decisions** wherever the execution chose
   differently (maintainer, 2026-07-22):
   - `delete` → re-express as MCP `archive_workflow` and **rename the verb to
     `archive`** (semantics-honest: MCP has no hard delete). Docs trio follows.
   - `create` and `duplicate` → MCP (`create_workflow_from_code`).
     `validate_workflow` is the mandatory gate in this path (SDK-code input
     only — it cannot validate existing workflows, so its scope ends here);
     its `valid`/`warnings` (node name + parameter path)/`errors`/`hint` output
     is shaped for an iterate-on-errors loop. Duplicate pipeline:
     `get_workflow_details` → generate SDK code (lean on
     `get_sdk_reference`/`get_node_types`) → `validate_workflow` loop →
     `create_workflow_from_code`.
   - **API-optional end goal:** MCP/OAuth is the primary credential; the public
     API key degrades to an optional extra for the remaining API-only surfaces
     (data-table rows; `executions` if kept on the API). `init` treats the API
     key as optional; every verb either works API-less or fails with a clear
     "needs API key" message.
3. **Guard-proxy stack** — technical enforcement of the Code-node boundary
   (decided 2026-07-22; today the boundary is instructions-only). Three layers,
   shipped together, each catching what the layer above cannot see:
   - **(a) Local MCP guard-proxy** — decanter is the sole token holder; the
     agent's MCP config points at a localhost proxy that forwards JSON-RPC to
     `POST /mcp-server/http`. Design constraints (from the feasibility/safety
     assessment): parse **requests only** (`tools/call` → `update_workflow`
     ops); responses incl. SSE pipe through byte-for-byte untouched. Don't
     enumerate op types (n8n's op vocabulary churns — 33→41 tools in months):
     flag any `update_workflow` args containing a `jsCode` key, fail closed on
     parse failure. Bind `127.0.0.1` only; require a per-session random secret
     in the agent's MCP config; cap body size. Blast radius is availability,
     not integrity — decanter's own sync talks upstream directly and never
     routes through the proxy. Hosting: `watch` or a dedicated `mcp serve`
     mode. Precedent: `lib/proxy.mts` (Plan 5) already does harder transparent
     proxying. Token custody is a net security improvement (the agent never
     sees an n8n credential); honest caveat: a guardrail, not a jail, while
     decanter credentials live in workspace files — OS-keychain token storage
     would harden it (optional stretch).
   - **(b) Slim config-drift detector hooks** — NOT op-inspectors (redundant
     with the proxy): a ~10-line check that an n8n MCP server *other than the
     decanter proxy* is configured/used → "route through the proxy." One
     shared agent-agnostic script (model:
     `template/.claude/hooks/verify.mjs.example`) + thin per-harness wiring,
     shipped for the same agent variety as n8n-io/skills (plugin installs:
     Claude Code, Codex; opencode plugin; plain installs fall back to the
     override — same coverage boundary n8n's own pack has).
   - **(c) Template sync-dir `AGENTS.md` override rewritten proxy-first:**
     "wire n8n MCP access through the decanter proxy, never the instance
     directly; Code-node source is files + decanter push." Serves both as the
     hook-less-harness fallback and as the instruction that points agents at
     the proxy URL in the first place. (Supersedes the Plan 32 Task 9 wording,
     which assumed agents talk to the instance directly.)
4. **`test` verb** — instance-side pinned-data test run (decided 2026-07-22):
   `n8n-decanter test [workflow…]` wrapping MCP `test_workflow` (synchronous,
   draft, 5-min timeout; trigger/credentialed/HTTP nodes pinned from `pinData`,
   logic nodes run for real).
   - **Interface mirrors `simulate`:** pinData from captures
     (`--execution <id>`, default newest) or committed mocks (`--mock <slug>`);
     `--trigger <node>` maps to `triggerNodeName`. One shared fixture model,
     two engines (local Docker vs. instance). Keep decanter's value-add:
     client-side diff of node outputs vs. capture, exit 1 on divergence;
     surface the 5-min timeout in errors. Evaluate `prepare_test_pin_data` for
     scaffolding pinData gaps (à la `mock create`).
   - **Flow (decided, corrected for MCP semantics):**
     1. `status` — local vs. draft drift, publication state; capture
        `versionId` (+ `activeVersionId`) and a per-node jsCode snapshot
        (byte-exact via `get_workflow_details`) as the pre-test reference.
     2. If local is newer, prompt "What do you want to test?" — *your local
        code* (pushes to the draft first: same op as watch-on-save, draft-only,
        never activates, inherits the drift guard) or *what's on n8n now*.
        Wording is dynamic: draft==published → "test the live workflow (without
        your local changes)"; diverged → "test the current n8n draft (differs
        from both local and live)". (`test_workflow` always runs the draft
        tip — superseded published content is unreadable over MCP.)
        Unpublished workflow → skip the prompt, just push (TTY only).
     3. Run `test_workflow` with pinData → client-side diff → result.
     4. If pushed: offer **keep** (publish is the likely next step) or
        **restore the pre-test draft** via
        `restore_workflow_version(step-1 versionId)` — undocumented on the docs
        website but real (n8n-io/skills + the 2.30.7 spike enumeration;
        **n8n 2.29.0+**): "re-apply a past version as the current draft
        (records a new history entry)"; live version untouched. Fallback below
        the 2.29 floor / on failure: write the step-1 jsCode snapshot back via
        `updateNodeParameters` (persist it to a gitignored file, crash-safe;
        re-check the draft hash before reverting — a mid-test UI edit aborts
        with a warning). Optionally confirm restorability via
        `get_workflow_history` first. Output states explicitly that the live
        version was never affected.
   - **Non-TTY/agents — NO choice flags** (maintainer rejects mode flags):
     one flow, two renderings. TTY renders decision points as prompts; non-TTY
     is **read-only** — never pushes, never restores, tests the draft tip
     as-is, and on local≠draft prints "local differs from the draft — tested
     the draft, not your local code; run `n8n-decanter push` first to test
     local." Choices are verb composition (`push` then `test`; revert = git +
     `push`). Selector flags (`--execution`/`--mock`/`--trigger`) are
     unaffected — fixture selectors, not modes, mirroring `simulate`.
   - **Verb taxonomy** for the docs: `check` = static/offline, `test` =
     instance-side runtime, `simulate` = local/offline runtime — add a
     when-to-use-which table. Requirements: MCP-backed (OAuth,
     `availableInMCP` opt-in → picker red-state guidance, version floor).
     Docs trio + backlog distinctive-features entry (instance-side pinned test
     + diff is a differentiator).
5. **`simulate`/Docker long-term** — open maintainer decision. The 3-bullet
   functional case for keeping it (legacy explicitly ruled out as a reason):
   pre-push verification of uncommitted local state (`test` can only run what's
   on the draft); CI without an instance/credentials/opt-in/5-min cap;
   `--network-none` isolation + engine-version rehearsal (pin the *next* n8n
   version locally before upgrading the instance). `test`'s unique edges: no
   Docker, instance's exact env (community/custom nodes, real env vars).
   Verdict candidate: complementary — `test` as lightweight default, `simulate`
   for pre-push/CI/isolation. **Decide here, then document the split.**
6. **AGENTS.md MCP-facts update pass** — correct the "Driving a real n8n"
   section's spike-era record with the re-verified facts (Notes below): the
   docs tool reference is not exhaustive; version-history tools
   (2.29.0+), execution reads, `prepare_test_pin_data`,
   `publish_workflow(versionId)`; tool count.

## Acceptance / verification

- Review gate (Task 1) fully worked through, each finding either confirmed fine
  or turned into a fix in this plan.
- Verb surface matches the standing decisions: `archive` (renamed), `create`/
  `duplicate` MCP-based behind `validate_workflow`, API key optional everywhere
  with clear errors.
- Proxy: an agent wired to the proxy cannot land a `jsCode` write on the
  instance (blocked with an instructive error), while structure ops pass;
  decanter's own sync is fully independent of proxy availability; smoke
  coverage on the pinned container.
- `test`: full flow verified at the CLI surface (mock MCP server per the
  AGENTS.md recipe + smoke on the pinned container); non-TTY runs are
  provably read-only; restore path verified incl. the < 2.29 snapshot
  fallback.
- Docs trio (README + `/docs` + CHANGELOG) updated for every user-facing change;
  new verbs get pages; **Breaking:** entries where applicable; PLAN.md reflects
  the final data model.

## Non-goals

- Amending [Plan 32](OPEN-32-mcp-native-code-layer.md) — it executes as
  written; this plan reviews the result.
- Forking n8n-io/skills (Plan 30's "override, not fork" stands).
- The decanter-native code-node authoring skill — deferred to
  [Plan 0](BACKLOG.md) (distinctive-features group); pick up only if proxy logs
  show the n8n skills' routing nudge biting in practice.
- Full op-inspecting harness hooks — superseded by the proxy + slim-detector
  layering (they return only if the proxy is ever dropped).

## Notes

- **MCP tooling facts (re-verified 2026-07-22 against docs.n8n.io + the
  n8n-io/skills repo; the docs tool reference is NOT exhaustive — SKILL.md files
  and a live `tools/list` are better inventories):**
  - Version-history tools are undocumented-but-real, **n8n 2.29.0+**:
    `get_workflow_history` (saved versions, newest first),
    `get_workflow_version` (skills say it fetches a version; the 2.30.7 spike
    saw metadata-only — recheck), `restore_workflow_version` (re-applies as
    draft, new history entry).
  - Execution reads exist: `get_execution` (metadata by default;
    `includeData: true` → full per-node result data, node filter + item
    truncation) and `search_executions`.
  - `test_workflow` (synchronous, draft, required `pinData`, 5-min timeout) and
    `prepare_test_pin_data` exist; `execute_workflow` is async/production
    (returns an executionId for `get_execution`).
  - `publish_workflow` accepts an optional `versionId` — "go straight live"
    from a past version (production-rollback capability; future
    `publish --version`?).
  - `validate_workflow` takes **SDK code only** (not id/JSON) — creation-path
    gate, not a general validator. Data tables remain add-only (no row reads).
  - Docs tool count 41 (excl. the undocumented version tools); the Plan 32
    spike recorded 33 on n8n 2.30.7 — the "young/evolving surface" cost is
    real, hence the schema-drift-robust guard design in Task 3.
- **Enforcement layering rationale (Task 3):** with a proxy, op-inspecting
  hooks are redundant for proxied traffic; the residual gap is *direct wiring*
  (n8n's docs/skills actively guide users to add the instance MCP straight into
  agent config) — hence the slim detector. The override covers harnesses with
  no hook support. Each layer catches exactly what the one above cannot see;
  nothing is implemented twice.
- **CHANGELOG/PLAN.md:** Tasks 2–4 are user-facing (verb rename = Breaking;
  new verbs; auth changes) → full docs trio + PLAN.md updates land with each.
  Task 6 is repo-internal (AGENTS.md) — no changelog entry.
- The agent memory note `plan32-execution-review-checklist` (2026-07-22) is the
  raw session record behind this plan; this file supersedes it on merge.
