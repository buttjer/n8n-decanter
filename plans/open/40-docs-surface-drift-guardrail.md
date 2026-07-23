# Plan 40 — Docs-surface drift guardrail (CI check)

**Priority:** P2 (the backlog logged it "low", but the drift it prevents has
now recurred across #107/#114/#115 — cleaned up by hand in [Plan 39](../done/39-docs-drift-refresh.md)
— and again in #118; a cheap mechanical gate is overdue). Mechanical, offline,
no new deps.
**Status:** Not started
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1
**Theme:** A CI-run script that mechanically verifies the CLI's **command
surface** is reflected across the three doc surfaces (README verb table, `docs/cli/*`,
`docs/cli/overview.md`) and that no doc/template ships a **copy-paste-broken
verb-last command** — catching the *cross-PR* drift the in-PR AGENTS.md rule
can't.
**Model:** Sonnet (well-specified script + CI wiring; the one care point is
keeping the verb-last regex false-positive-free).

## Why

The three-surface rule (README / `/docs` / CHANGELOG) is enforced today only by
**author discipline within a single PR** (the AGENTS.md "Documentation site"
rule + the pre-PR grep). It cannot catch drift that spans PRs: a behavior lands
in one PR and its docs lag in another, and because they touch *different files*
git merges both cleanly and flags nothing. The backlog item that graduates into
this plan first named the pattern with v0.3.0 (#29); it has since recurred at
scale — the entire reason [Plan 39](../done/39-docs-drift-refresh.md) exists is to
hand-clean drift left by #107/#114/#115, and #118 re-touched the same surfaces
again. Manual cleanup is the tax; a fast, deterministic CI check is the fix.

The check is **structural, not semantic**: it proves every verb has a home on
each surface and that documented commands are runnable as written. It does *not*
judge whether a flag's *prose* is up to date — that stays human/agent review.
That boundary is the same one the backlog item drew ("diff the CLI verb/flag
**surface** against the matching `/docs` pages").

## Source

- [Plan 0 backlog](../draft/) "**Cross-PR docs-drift guardrail in CI**"
  (2026-07-20) — graduated here 2026-07-23. Real enforcement rides the live
  public-repo CI ruleset ([Plan 13](../done/13-open-source-release.md)).
- Directly motivated by [Plan 39](../done/39-docs-drift-refresh.md)'s findings: 12
  of its 26 were verb-last commands or verb↔surface mismatches — exactly the
  class this check makes impossible to reintroduce.

## Design — one script, four parity checks + a grammar scan

`scripts/check-docs-surface.mts` (Node, type-stripped like the rest; no deps),
run via `npm run check:docs`, wired into `ci.yml` after `typecheck`. Exits 1
with a per-violation report naming the exact file/verb and the fix.

**Source of truth for verbs:** parse the verb sets straight from
`n8n-decanter.mts` — `VERBS` plus the namespace sub-verb sets `NODE_VERBS`
(`run`), `SCENARIO_VERBS` (`create`/`check`), `MCP_VERBS` (`serve`/`connect`).
So the check self-updates when a verb is added/removed; the surfaces then have to
follow or CI stays red (which is the point).

**A small maintained map handles the non-1:1 cases** (kept as a commented
constant in the script — the only thing a verb change must touch besides the
verb set itself):
- **Internal, no page:** `help`, `__complete` (skip).
- **Namespaced → page:** `node run`→`node-run.md`, `mcp connect`→`mcp-connect.md`,
  `mcp serve`→`mcp-serve.md`, `scenario create`/`scenario check`→`scenario.md`.
- **Shared page:** `unpublish`→`publish.md` (README documents "publish /
  unpublish" as one row; there is no `unpublish.md`).

### The checks

1. **Verb → docs/cli page** (via the map): every user-facing verb has a page.
   Catches a new verb shipped without its `/docs` page.
2. **Page → verb** (reverse): every `docs/cli/*.md` except `overview.md` maps
   back to a live verb. **This is the one that catches the leftover-page bug** —
   `mock.md` after #114, a `node-create.md` after #107 — a retired verb's orphan
   page.
3. **Verb → README `## Commands` table:** every user-facing verb appears as a
   row. (The README table is the surface AGENTS.md calls "the one most easily
   forgotten".)
4. **Verb → `docs/cli/overview.md`** command surface: every verb is listed.
5. **Verb-last command scan (the Plan 39 bug class).** Scan `docs/**`,
   `template/**`, and the CLI's own usage/error strings for
   `n8n-decanter <tok1> <tok2>` where **`tok2` is a known verb and `tok1` is
   not** a verb / namespace / global flag → flag as verb-last (the CLI is
   verb-first and rejects it). This precisely separates the broken form
   (`n8n-decanter <workflow> simulate`, `n8n-decanter wf push`,
   `n8n-decanter order-sync scenario create`) from the correct
   `n8n-decanter <verb> <ref>` (`n8n-decanter push wf`), which passes because
   `tok1` is a verb. Placeholders (`<workflow>`, `"<name>"`, `$VAR`, real slugs)
   in `tok1` are exactly what the rule flags — that is the bug.

## Tasks

1. **`scripts/check-docs-surface.mts`** — parse the verb sets from
   `n8n-decanter.mts` (regex over the `new Set([...])` literals is enough — no
   import/execution), build the verb→page map, run checks 1–5, and print a
   grouped, actionable report; exit 1 on any violation, 0 clean.
2. **The maintained map + optional retired-verb denylist.** The verb→page/README/
   overview map (above). *Optional, low-priority:* a commented denylist of
   removed verbs/flags (`mock`, `create`, `rename`, `archive`, `delete`,
   `duplicate`, `node create`, `node rename`, `uuid`, `--mock`, `--pin`) so a
   retired verb *mentioned as a live command* (not just its page) is flagged too
   — checks 2 + 5 already cover orphan pages and broken grammar, so this is
   belt-and-suspenders; include it only if it stays cheap.
3. **Wire it in:** `"check:docs": "node scripts/check-docs-surface.mts"` in
   `package.json`; a `- run: npm run check:docs` step in `.github/workflows/ci.yml`
   after `typecheck` (fast, offline, no `npm ci` cost beyond what's there).
4. **Unit test** (`test/unit/check-docs-surface.test.mts`): drive the checker's
   pure functions over synthetic fixtures — a verb with no page, an orphan page,
   a missing README/overview row, a verb-last command line — asserting each is
   caught, and that a clean surface passes. (Keeps the check itself honest.)
5. **Seed it green — sequencing with Plan 39.** Run against current `main` and
   the check **will fail** on the exact verb-last commands
   [Plan 39](../done/39-docs-drift-refresh.md) already catalogs (`docs/cli/scenario|simulate|publish.md`,
   `template/AGENTS.md.example`, the three CLI error hints). So **land this after
   (or fold in) Plan 39's grammar fixes** — the check can't go green until those
   commands are verb-first. Cleanest order: Plan 39's Task-A grammar fixes first
   (or in this PR), then this check locks the door behind them.
6. **Docs (dev-facing only).** Add a one-line note to AGENTS.md — under
   "Documentation site — keep ALL surfaces in sync" and the Housekeeping routine
   — that `npm run check:docs` mechanically enforces the verb-surface + grammar
   half of the rule (the semantic half stays manual). **No CHANGELOG entry** and
   **no `/docs` change** — internal tooling, no user-facing surface (same bar as
   `test:smoke`).

## Acceptance / verification

- `npm run check:docs` catches, on purpose-built fixtures: a verb missing a
  `/docs` page, an orphan page for a nonexistent verb, a verb missing its README/
  overview row, and a verb-last command — each with a clear message; a clean
  surface exits 0.
- The step runs in CI after `typecheck` and is green on `main` once Plan 39's
  grammar fixes have landed.
- `npm test` + `npm run typecheck` + `npm run lint` green.
- The structural-vs-semantic boundary is stated in the script's header and
  AGENTS.md, so nobody mistakes a green check for "docs are fully current".

## Non-goals

- **Flag-level parity** (every `--flag` ↔ its docs) — flags are parsed ad hoc,
  not declared in a table, so matching them is false-positive-prone; v1 does
  verbs + grammar. Log flag parity as a stretch follow-up if verb parity proves
  its worth.
- **Semantic content review** — a flag whose behavior changed but whose prose
  didn't still needs a human/agent (or a periodic audit like the one that
  produced Plan 39). This check makes *structural* drift impossible, not staleness.
- **CHANGELOG-entry parity** — the backlog floated "diff the CHANGELOG's
  user-facing entries against the docs" as an alternative; rejected for v1 as
  prose-parsing-brittle. The verb surface is the robust source of truth.
- **PLAN.md / template semantic sync** — out of scope; this is the user-facing
  command surface only.

## Notes

- **Why a script over a grep in CI:** the parity checks need the *set* of verbs
  and pages, and the verb-last scan needs to know which tokens are verbs — that's
  logic, not a one-line grep. Keeping it in `scripts/` (type-stripped, no deps)
  matches the repo's `scripts/typecheck.mts` precedent and makes it unit-testable.
- **Self-maintaining by construction:** the map in Task 2 is the *only* place a
  verb rename/retire needs a manual touch beyond the verb set; forget it and the
  check fails loudly, which is the guardrail working.
- **Relation to [Plan 39](../done/39-docs-drift-refresh.md):** Plan 39 is the
  one-time cleanup; Plan 40 is the ratchet that stops the mess recurring. Ship
  Plan 39's grammar fixes first (or together) so this lands green.
