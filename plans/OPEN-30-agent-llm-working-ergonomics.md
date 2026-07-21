# Plan 30 — Agent/LLM working ergonomics in a sync dir

**Priority:** P2 overall, split per theme — **P1** for the pure-docs "orient
before you edit" + loop-clarity work (small, clearly-right, offline, high-value);
**P2** for the small tooling (orientation snapshot, research recipe, scaffold/allowlist
tuning), which carry design decisions.
**Status:** Not started
**Theme:** Make an LLM coding agent measurably more effective *and* safer the
moment it lands in a synced dir — codify session-start orientation ("check
`status` before you edit; pull-first when it drifted"), sharpen the offline loop,
and give the agent grounded knowledge tooling beyond the scaffolded n8n-mcp.
**Model:** Opus for the policy/flow wording in `template/AGENTS.md.example`
(agent-behavior, safety-critical); Sonnet for the mechanical doc-surface
propagation and any small verb/flag.

## Why

The scaffold already gives agents a strong **edit-time** contract — the
[template/AGENTS.md.example](../template/AGENTS.md.example) hard invariants, the
guard hooks, and the offline `check` / `node run` loop — plus one knowledge
source: the scaffolded **n8n-mcp** server ([.mcp.json.example](../template/.mcp.json.example),
node schemas / params / templates). What's thin is everything *around* the edit:

1. **Session start / orientation is uncodified.** An agent typically starts
   editing whatever is on disk. If the workflow drifted in the n8n UI since the
   last sync, it edits stale state and the eventual `push` either aborts
   (`pull first`) or — worse, if pushed `--force` — clobbers the UI edits. There
   is no "orient yourself first" step in the contract. *(Maintainer's prompt: "a
   pull before starting to work on a workflow is very recommended.")*
2. **Knowledge grounding is single-source.** n8n-mcp covers **static** node
   schemas, but not: the *instance's* n8n version and its behavior, the **real
   payload shapes** flowing through this specific workflow, or the decanter
   contract itself. Absent those, agents fall back to (often stale) training
   data. *(Maintainer's prompt: "Deep research? More tooling than the mcp?")*
3. **The best offline/grounding tools are under-surfaced in the loop.**
   `executions` (real payloads → `node run` fixtures), `data-tables`, and
   `simulate` (whole-workflow offline replay) all exist, but the agent docs
   frame the loop as just `node run` + `check`.

Agent-native tooling is a **stated differentiator** of this project (the
[README](../README.md) comparison table's "Agent-native tooling" row), so it
belongs in the **distinctive-features backlog group**, not parity — this plan
invests in it deliberately.

## Source

- New maintainer brainstorm (2026-07-21): optimize the LLM's dealings with
  n8n-decanter — session-start pull, deep research, tooling beyond the MCP. No
  prior `plans/` entry.
- Extends the agent surfaces: [template/AGENTS.md.example](../template/AGENTS.md.example),
  the per-agent scaffolds (`.claude/`, `.cursor/`, `opencode.json`),
  [docs/agents/overview.md](../docs/agents/overview.md) +
  [docs/agents/offline-loop.md](../docs/agents/offline-loop.md), and the
  `.mcp.json` / `settings.local.json` scaffold (PLAN.md §init).
- Builds on existing tools (no re-implementation): Plan 3 (`executions`;
  `run --from-execution` is deferred in [BACKLOG](BACKLOG.md)), Plan 7 / Plan 26
  (`simulate` + npx backend), Plan 25 (`data-tables`).
- **The docs half changes no PLAN.md flow.** The tooling half is gated on the
  decisions below.

## Design tension to resolve first — "pull before working" vs. "pull is user-gated"

The maintainer's instinct ("pull before starting is recommended") collides with
the settled policy that **`pull` is a live-instance op the agent runs only when
the user asks** (it writes local files and re-baselines drift). The resolution
this plan proposes — and the crux of Theme A — is:

> **The read-only `status` *is* the "pull-first" check.** `status` contacts the
> instance but writes nothing; it reports per-workflow drift / conflict /
> push-pending. So the recommended cold start is **`status` first**; only when it
> shows drift does the agent **recommend a `pull` and ask** — it never auto-pulls.

This keeps the existing safety gate intact while giving the agent the safety of
"knowing the remote state before editing." Keep the "pull only when the user
asks" policy unchanged.

## Tasks

Grouped by theme; each theme is independently shippable (split the PRs by theme).

### A. "Orient before you edit" — session-start hygiene (docs-first, P1)

1. **Add a "Before you start a workflow task" section to
   [template/AGENTS.md.example](../template/AGENTS.md.example)** (near the top,
   before "How this differs…"): the recommended cold-start sequence —
   - Run `n8n-decanter status <workflow>` (or bare `status` for all) **first** —
     read-only, contacts the instance, reports drift / conflict / push-pending.
   - **Drift or a pending `code/<node>.remote.js`?** Surface it and **recommend a
     `pull` before editing** (agent asks; does not auto-pull). Editing on top of
     known drift is the mistake this prevents.
   - **Clean?** Edit freely, verify offline, report ready-to-push.
   - State the framing explicitly: *the read-only `status` is the "pull-first"
     check.*
2. **Mirror it into the docs surfaces** — prepend the orient step to "The default
   loop" in [docs/agents/overview.md](../docs/agents/overview.md) and add a "Start
   of a task" subsection to [docs/agents/offline-loop.md](../docs/agents/offline-loop.md);
   keep the README agent bullet(s) in sync if they enumerate the loop.
3. **Decision (log in [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md)):** stop at a
   docs recommendation, or add a lightweight nudge? Options: **(a)** docs-only
   *(proposed default)*; **(b)** the Claude/opencode guard hook warns when it
   detects a stale `.decanter.json` hash on first edit of a workflow; **(c)** more
   invasive still. Lean **(a)**, optionally **(b)**.

### B. One-shot orientation snapshot (small tooling, P2)

4. **Evaluate a machine-readable situational snapshot** so the agent orients in
   *one* deterministic call instead of several: per configured workflow — display
   name, folder slug, drift/conflict/push-pending state, `.remote.js` presence,
   uncommitted-git state — plus the instance n8n version. **Decision:** a new
   `orient`/`brief` verb **vs.** extending existing surfaces (`list --status`,
   `status --json`). **Lean: extend `status`/`list` (`--json`)** over a new verb —
   fewer surfaces, reuses `lib/status.mts` + `lib/list.mts`. Whatever ships must
   be pre-allowed in the scaffolded allowlist (Theme D).

### C. Knowledge grounding beyond n8n-mcp — "deep research" (P2)

5. **Instance-version awareness.** n8n behavior is version-dependent, and
   `status`/publish already read the version (Plan 20). Document a recipe: read
   the instance version, and when node behavior is uncertain, consult
   **version-matched** `docs.n8n.io` rather than training data. Surface the
   version in the Theme-B snapshot.
6. **Promote the grounding tools to first-class in the agent loop.** Add a
   *"Ground yourself in real data before guessing shapes"* section to
   [docs/agents/offline-loop.md](../docs/agents/offline-loop.md) covering
   `executions` (real payloads → `node run` fixtures), `data-tables`, and
   `simulate` (whole-workflow offline replay). **These are the "more tooling than
   the MCP"** — they ground the agent in *this* instance's reality, which static
   schemas cannot.
   - **Prefer the *newest* executions, and lean on the staleness flag the verb
     already emits.** `executions` fetches **newest-first** (`--limit N`, default
     5) and, better, **warns when a captured execution ran a published workflow
     version different from the local draft** (it compares the execution's
     `workflowVersionId` against `workflow.json`'s `versionId`;
     [docs/cli/executions.md](../docs/cli/executions.md)). Document this as the
     rule of thumb: fresher data is closer to the code in front of you, and **that
     warning is the signal that captured shapes may be a step behind** — when it
     fires, re-fetch (or narrow with `--status=error`/`--limit`) rather than
     trusting stale files. Ties directly into version-awareness (Task 5).
7. **A tool-agnostic "Researching before you build" recipe.** Per the AGENTS.md
   agent-tooling rule, put the substance in
   [template/AGENTS.md.example](../template/AGENTS.md.example) as an **ordered
   source ladder** — (1) `n8n-globals.d.ts` + AGENTS.md for the decanter contract,
   (2) n8n-mcp for node schemas/params/templates, (3) `executions` / `data-tables`
   for real shapes, (4) version-matched `docs.n8n.io` for behavior, (5) `simulate`
   to confirm end-to-end — and keep any per-agent file (a `.claude/skills/`
   pointer, Cursor/opencode equivalents) a **thin pointer** to it.
8. **Consider expanding the scaffolded tool access.** e.g. a `WebFetch`
   allowlist for `docs.n8n.io` in
   [settings.local.json.example](../template/.claude/settings.local.json.example),
   and documenting that an extra docs/search MCP can be added. **Decision:** which
   tools ship **by default** vs. are documented as **opt-in** — avoid bloating
   every scaffold. Lean: allowlist `docs.n8n.io` reads by default; document extra
   MCPs as opt-in.

### D. Loop clarity & guardrail polish (P2)

9. **A canonical "recommended agent loop" picture** in
   [docs/agents/overview.md](../docs/agents/overview.md): *orient (`status`) →
   research (mcp / executions / data-tables / version-matched docs) → edit →
   verify (`node run` / `check` / `simulate`) → report ready-to-push.* One diagram
   agents and humans share (plain Markdown / a mermaid fence — no bespoke MDX).
10. **Audit the scaffolded permission allowlist** against the full loop
    ([settings.local.json.example](../template/.claude/settings.local.json.example)
    + `opencode.json`): confirm the offline/read-only tools the loop leans on —
    `simulate` (offline path), `executions` / `data-tables` (incl. `clean`),
    `status --json`, any Theme-B snapshot — are pre-allowed so the agent isn't
    prompted on safe reads. Add gaps; leave `push`/`--force`/`delete` denied.

## Acceptance / verification

- **Docs half:** every surface in sync — grep the new terms across `README.md`,
  `docs/`, and `CHANGELOG.md` per the AGENTS.md pre-PR checklist; a `[Unreleased]`
  entry for any user-facing change (a new verb/flag or a scaffold change);
  PLAN.md updated **only** if a flow or the init scaffold changes (Theme A alone
  changes neither).
- **Any new verb/flag (Tasks 4, 8):** verified at the CLI surface via the
  `/verify` mock recipe (drive the real CLI as a subprocess against a `node:http`
  mock), plus unit + e2e coverage; scaffold changes materialize correctly through
  `init` (`.example` → real name). `npm test` + `npm run typecheck` green.
- **Decisions (Tasks 3, 4, 8)** are logged in
  [DECISIONS-NEEDED.md](DECISIONS-NEEDED.md) and resolved before the dependent
  tasks land.

## Notes

- **Keep the "pull only when the user asks" policy.** The session-start
  recommendation is *read-only `status` first + ask before pulling* — it does
  **not** loosen the live-instance gate (see "Design tension" above).
- **CHANGELOG/PLAN implications:** Theme A → docs only, no PLAN flow change; a new
  verb/flag or scaffold change → `[Unreleased]` + PLAN.md (§init scaffold /
  command surface) in the same PR.
- **Non-goals:** auto-pulling on the agent's behalf; bundling heavyweight research
  MCPs by default; touching the settled **edit-time** hard invariants (this plan
  is about the work *around* the edit, not the edit contract).
- **Backlog placement:** distinctive-features group (agent-native tooling), not
  the parity/hardening buckets.
