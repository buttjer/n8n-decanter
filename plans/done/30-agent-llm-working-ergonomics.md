# Plan 30 — Agent/LLM working ergonomics in a sync dir

**Status:** Done (2026-08-18) — **reduced** the same day from four themes / ten
tasks to two small edits (everything else landed elsewhere, was superseded, or
did not survive a skeptical re-read — the table below says which, per item), and
both survivors shipped in the same PR: the orient passage in the template + both
`docs/agents/` pages, and the `*.remote.js` deny claim removed from
`CLAUDE.md.example` / `opencode.json.example`.
**Priority:** P2 — a docs sentence and a scaffold inconsistency, one PR.
*(Theme A's old **P1** claim does not survive the evidence: the drift it guards
against is reported by `preflight`, refused by `push`, and `push --force` is
denied in the scaffold. What is left is cheap and right, not urgent.)*
**Source:** maintainer brainstorm 2026-07-21 — session-start pull, deep
research, tooling beyond the MCP. The retired themes' outcomes are recorded in
"What survived" so nothing is orphaned.
**Snapshot:** 2026-08-18T11:56Z @ c3b05c1 *(full rework. The previous snapshot,
2026-07-25T21:30Z @ 83e61e9, predates [Plan 59](59-declutter-verify-verbs.md)
retiring the `status` verb the plan was written around,
[Plan 60](60-preflight-first-verb-surface.md) making `preflight` the
single read-only gate, [Plan 51](51-live-mirror-and-backups.md)/[68](68-live-mirror-visibility.md)'s
live mirror, and the wave-2 field-test rounds. The superseded task text — the
staged `init` flow, the F1–F5 grounding research, the dropped precedence-override
snippet — stays readable in git at 83e61e9; only its outcome is carried forward.)*
**Theme:** What is left of "make an agent effective the moment it lands in a
synced dir": tell it to orient **before** it edits, not only before it pushes —
and stop the scaffold from advertising a deny rule it no longer has.

The tool now says everything this plan set out to add, except *when* to look:
`preflight`'s sync tier is the orient report (`parity` / `drift` / `snapshot` /
`lifecycle`), but every surface frames it as the **pre-push** gate, so an agent
edits first and learns about a colleague's UI edit afterwards. That is one
sentence in three files. The second item is a factual error in the scaffold:
`CLAUDE.md.example` and `opencode.json.example` still describe a `*.remote.js`
deny rule that Plan 32 removed the need for.

## What survived, and what killed the rest

| Original item | Outcome |
| --- | --- |
| **A1/A2** — "orient before you edit" in `template/AGENTS.md.example` + the two `docs/agents/` pages | **Survives, reduced → Task 1.** The *report* exists (`preflight`); only the **timing** is undocumented. The verb it named (`status`) is gone — Plan 59. |
| **A3** — enforcement decision | Resolved as docs-only 2026-07-22; nothing to build. |
| **A4** — "finish the loop" | **Landed** (#154, then subsumed by Plan 59/60 — the loop now reads `preflight → push → test → publish` in template, docs and README). |
| **B / Task 4** — n8n instance version in `status` | **Dropped.** `status` is retired, and both consumers died: Task 8's staged `init` flow is superseded (Plan 32 — decanter authenticates the instance MCP itself), and the MCP version-floor messaging landed as [Plan 74](74-mcp-disabled-403.md)'s 401/403/404 mapping instead. No caller is left to justify a new instance read. |
| **Task 5** — version-aware docs recipe | **Dropped with B.** Its premise was a version to read; without it the recipe is "read docs.n8n.io and heed *Available from vX*" — which is what the default-scaffolded `n8n-docs` MCP already serves off the live docs. |
| **Task 6** — "ground yourself in real data" section | **Covered.** `template/AGENTS.md.example` has *Real execution data*, *Scenarios* and *Data tables*; [docs/cli/preflight.md](../../docs/cli/preflight.md) has *Executions are the ground truth* and the `capture` check. A fourth restatement would be drift bait. |
| **Task 7** — grounding ladder + precedence override | **Dropped.** The override landed as *"This AGENTS.md wins…"* (#107). Every ladder rung now has an owner (`n8n-globals.d.ts`; the guarded `n8n-instance` MCP + the template's boundary section; `executions`/`data-tables`; the `n8n-docs` MCP; `preflight`), so the ladder would only re-order text that already exists. |
| **Task 8 + 8a/8c** — staged `init` MCP wiring, skills docs, docs-MCP scaffold | **Superseded / landed** (Plan 32; #107; skills offer = [Plan 55](55-init-skills-offer.md)). |
| **8b** — trim generic Code-node prose to a pointer | **No object left.** "Writing Code node code" is now entirely decanter-specific (top-level `return` + the tsserver false positive, `n8n-globals.d.ts`, bundling rules, `$('Node')` rename refs). Nothing generic to trim. |
| **D / Task 9** — canonical loop diagram, and the `mcp serve` → `mcp connect` fix | **Fix landed** ([docs/agents/overview.md](../../docs/agents/overview.md) names `mcp connect`, with `mcp serve` as the URL-only fallback). **Diagram dropped** — the loop is already stated in the template, both `docs/agents/` pages and the README; a fifth copy is one more thing to keep in sync. The orient clause folds into Task 1. |
| **Task 10** — allowlist trim | **Mostly landed** — `template/.claude/settings.json.example` carries no retired verbs and no `.remote.js` deny. **Residue → Task 2.** |

**Why Theme A is no longer P1.** The plan justified it as damage prevention
("the eventual `push` clobbers the UI edits"). Post-Plan-32/59/60 that path is
closed from three sides: the per-node **drift guard aborts** the push,
`push --force` is **denied** in the scaffolded permissions, and `preflight`'s
`drift` row reports a two-sided edit as a `CONFLICT` **fail** routing to `diff`.
The live mirror re-pulls after the agent's own guarded structure acts
(Plan 51/68), so the same-session case is handled outright. The cost of not
orienting is therefore **wasted work, not lost work** — and the field rounds
bear that out: the n=3 sweep (#238) ran S3 (*remote drift + edit request*) three
times for two clean passes and one round where the agent diagnosed the state
correctly but never pulled, so the scenario measured nothing. Worth documenting.
Not worth a theme.

## Tasks

1. **Say when to orient, in the three places that describe the loop.** One
   short passage, same content:
   - [template/AGENTS.md.example](../../template/AGENTS.md.example) — in "The
     short version", next to the existing loop line: **run `preflight` (or
     `diff`) before you start editing, not only before you push.** It is
     read-only. `drift` warns when someone edited that code on the instance →
     **`pull` and continue** (a pull is part of the work); a `CONFLICT` (both
     sides moved) is the one case to surface to the user before overwriting
     either side; `parity` tells you a push is already pending from an earlier
     session.
   - [docs/agents/overview.md](../../docs/agents/overview.md) — prepend the
     orient step to "The default loop for an agent" sentence.
   - [docs/agents/offline-loop.md](../../docs/agents/offline-loop.md) — one
     line at the head of "A typical agent iteration": the first `preflight` of
     a task is worth running **before** the edit (it needs the instance, so
     `--offline` is not that check).
   - No new verb, no flag, no hook. A guard hook that warned on stale state was
     rejected 2026-07-22: detecting staleness means a network call per edit.
2. **Stop the scaffold from advertising a deny rule it does not have.**
   `template/.claude/settings.json.example` denies `.decanter.json`, `.env` and
   `push --force` — **not** `*.remote.js` (Plan 32 removed the conflict
   artifacts). Two files still say otherwise:
   - [template/CLAUDE.md.example](../../template/CLAUDE.md.example) — "blocks
     edits to `.decanter.json` and `*.remote.js`" → drop the second half.
   - [template/opencode.json.example](../../template/opencode.json.example) —
     the `"**/*.remote.js": "deny"` entry and the `"//_enforcement"` comment's
     "two file-level invariants". Drop both halves so the two harnesses'
     scaffolds state the same policy. *(Legacy `.remote.js` handling elsewhere —
     the tsconfig exclude, the ts-plugin filter, the guard's leftover warning —
     is deliberate and stays.)*

## Acceptance / verification

- Docs-only: no CLI change, so no `/verify` mock run and no PLAN.md flow change.
  `npm run check:docs` stays green (it does not read these files, but the PR
  touches the doc surfaces it guards).
- `CHANGELOG.md` `[Unreleased]` gets one **Changed** entry for Task 2 (a
  scaffolded file's contents are user-facing); Task 1 rides along in the same
  entry or its own, per the Changelog rules.
- **README:** its feature bullet states the *ship* flow
  (`preflight → push → test → publish`, [README.md](../../README.md) "One gate
  before you push" / "Flow:"). Orienting is agent guidance, not a fourth stage
  of that flow — the recommendation is to leave the bullet alone. Re-grep the
  three surfaces before opening the PR anyway (root `AGENTS.md` pre-PR rule).
- Both tasks are independently shippable; one PR is fine.

## Notes

- **Old task numbers referenced elsewhere:** [plans/draft/70](../draft/70-sandboxed-agent-credentials.md)
  points at "Plan 30's Task 10" — that is now **Task 2** (and reduced to the
  scaffold-consistency fix; the allow-list trim itself already landed).
- **Backlog placement:** distinctive-features group (agent-native tooling), the
  README comparison table's row. That is why the residue is worth keeping at all
  rather than deleting the plan.
- **Non-goals (unchanged):** auto-pulling on the agent's behalf; a direct
  agent-facing instance-MCP block (the guard is the route); forking
  n8n-io/skills (override instead — the override landed); touching the
  edit-time hard invariants. **Added here:** no new verb, flag, hook or diagram
  — every item this plan still owns is a sentence in a file that already exists.
