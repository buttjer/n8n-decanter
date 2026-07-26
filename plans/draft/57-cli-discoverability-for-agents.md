# Plan 57 — a coding agent should find decanter before it hand-rolls raw n8n MCP

**Status:** Draft — **close-out candidate.** The premise was measured 4× on
2026-07-26 and did not reproduce (4/4 FOUND-AND-USED); the one remaining variant
was ruled **out of scope** by the maintainer. No in-scope work is left — needs a
maintainer decision to move to `done/` (as *measured away*, not implemented) or
to keep as a watch item.
**Priority:** — (nothing open).
**Class:** Distinctive feature — the whole point of decanter is that Code-node
source lives in git; an agent that never finds the CLI gets none of it.
**Source:** [Plan 35](../open/35-blind-agent-field-test.md) blind field test,
round-1 finding 1 — carried unfixed through round 2 and the 2026-07-24 triage,
where the maintainer chose to give it its own plan.
**Snapshot:** 2026-07-26T19:27Z @ b239e00
**Model:** Opus for the positioning/wording decisions (this is mostly a
judgement problem, not a coding one); Sonnet for whatever mechanical surface
work follows.

## ⚠️ First measurement contradicts the premise (2026-07-26) — read before executing

The finding below is round 1's, from **before** the current scaffold existed. The
first deliberate re-measurement ([S6](../../test/field-test/scenarios/S6.md),
`ftrun-87406`, full report in [Plan 35](../open/35-blind-agent-field-test.md))
came back **FOUND-AND-USED**, not BYPASSED:

- dropped into a fresh clone with no runnable CLI, the agent ran `cat
  package.json` → `npx n8n-decanter list --remote` → `pull`, edited the file, and
  pushed;
- it **read `AGENTS.md`**; `verify` passed with 0 violations; **`guard.log` was
  empty** — it never used the raw MCP route at all.

**Repeated 3× more (2026-07-26): 4 of 4 FOUND-AND-USED.** Every round —
`ftrun-87406`, `-91113`, `-93211`, `-95680`, each on a fresh stage — passed
`verify` with 0 violations and an **empty `guard.log`**: not one ever used the
n8n MCP route. The n=1 objection is settled.

**The premise does not hold against today's scaffold.** The breadcrumbs the
agent *explicitly consulted* were machine-readable:

- `package.json` declaring `n8n-decanter` (round 1);
- `.mcp.json` — round 2 read it and copied its **exact `npx --no-install` form**;
- and in rounds 3–4 the agent's own reflex: `which n8n-decanter || npx …`.

**Caveat that matters (corrected 2026-07-26):** no round explicitly *opened*
`AGENTS.md`, but the scaffolded `CLAUDE.md` starts with `@AGENTS.md` and Claude
Code auto-loads it — so **the contract was in the system prompt throughout**,
and the transcripts do not record system prompts. Its contribution is real but
**unmeasured**. An earlier note here claimed the prose was not the mechanism;
that was unsupported and is retracted.

**Consequence for this plan:** directions 1–3 are on hold — the gap they exist
to close does not reproduce. Direction 3 (positioning/docs) is **not** disproven,
just untested. **The no-decanter-evidence variant is OUT OF SCOPE** (maintainer
call, 2026-07-26): decanter's concern is projects that use decanter, not
greenfield discovery. With that dropped and the premise not reproducing, this
plan has no remaining in-scope work — **it is a close-out candidate**; see
"Status".

## The finding

Dropped into a workflow project **without** a project-level `n8n-decanter`, a
blind agent never discovers the tool. It reaches straight for **raw n8n MCP**
and starts editing workflows the way it would with no decanter at all — inline
`jsCode` over `update_workflow`, no files, no git, no review diff.

That is the whole value proposition failing at step zero, and it is **not a
one-line fix**: it is positioning and onboarding. The harness papered over it by
installing the CLI during staging (so later rounds could test anything else at
all), which is exactly why the finding never went away — every round since has
measured a world where the breadcrumb already exists.

## Why it is hard (and why it needs its own plan)

- **The agent's prior is n8n MCP.** n8n ships an official MCP server and an
  official skills pack; both are strong, first-party, and describe workflow
  editing without decanter. An agent following them is behaving correctly.
- **The guard only helps once you're inside.** `mcp connect` blocks `jsCode`
  writes — but only for agents that were pointed at *decanter's* proxy. An agent
  that never found decanter talks to the instance MCP directly and is unguarded.
- **There is no "you are in a decanter project" signal an agent reliably reads**
  before it starts acting. `AGENTS.md` exists in a synced dir — but a *fresh*
  project has no synced dir yet, which is the case this finding is about.

## Directions to evaluate (nothing decided)

1. **Make the sync dir self-announcing.** The scaffolded `AGENTS.md` already
   carries the contract; what is missing is a reason for an agent to read it
   before touching n8n. Does `init`'s output, a root-level marker, or
   `decanter.config.json` placement change discovery in practice?
2. **Meet the agent where its prior already points** — a decanter *skill* in the
   same shape as the official n8n skills pack, so an agent that loads n8n skills
   also learns "if this project syncs Code nodes, use the CLI". Overlaps
   [Plan 50](50-code-node-authoring-skill.md); resolve the boundary before
   executing either.
3. **Positioning/docs** — README and docs currently explain decanter to a
   *human* evaluating a tool. Is there a page that answers an *agent's* first
   question ("how do I edit this workflow's code?") in the first paragraph?
4. **Measure, don't guess.** This is the one finding the field test can answer
   directly: a scenario staged **without** the CLI pre-installed, scored on
   whether the agent finds it. Round 1 was that experiment by accident; make it
   deliberate and repeatable so any fix here has a before/after.

   **BUILT 2026-07-26 — the instrument exists; the round has not been run.**
   `FIELD_NO_CLI=1` stages the **fresh-clone** condition and scenario
   [`S6`](../../test/field-test/scenarios/S6.md) drives it. The project carries
   the full committed evidence a teammate would push (AGENTS.md, .mcp.json,
   decanter.config.json, `workflows/` with code files, a package.json declaring
   `n8n-decanter`, git history) — only `node_modules` is missing, so the CLI is
   not runnable. What it scores: **FOUND-AND-USED** (got it running and shipped
   via files + push) / **BYPASSED** (edited `jsCode` over raw MCP — round 1's
   result, the baseline hypothesis) / **STALLED**.

   Getting the condition *valid* took more than removing the install — each of
   these was found by checking, and each would have silently invalidated the
   round:
   - `npm install <tgz>` had rewritten package.json to a `file:` spec pointing
     at the stage's tarball → the agent's `npm install` would fail for the wrong
     reason. Now restored to a version range, so a registry install is the
     genuine recovery path.
   - the tarball was being committed before deletion → a harness artifact baked
     into the very git history the persona is meant to read.
   - **a maintainer machine usually has a global `npm link` install**, inherited
     via PATH, which would have let the agent run the CLI all along. The run now
     *shadows* offending PATH dirs (symlinking everything except `n8n-decanter`,
     so node/npm/npx/git survive) **and** points `npm_config_prefix` at an empty
     prefix — because `npx` re-resolves its own node bin dir and found the global
     even after shadowing. All three routes (bare, `npx`, `npx --no-install`)
     verified failing, with `npm install` still resolving `n8n-decanter 0.7.0`.

   Guarded so it cannot silently measure nothing: `run.mts` refuses S6 against a
   manifest without `noCli`, and refuses `--container` (that image installs the
   CLI globally).

   **RUN ONCE, 2026-07-26 — FOUND-AND-USED (see the banner at the top).** The
   remaining work on this direction is to find out whether that answer holds:

   a. **Repeat S6** (≥2 more rounds). n=1 cannot distinguish "the scaffold works"
      from "this run got lucky". Cheap, and it settles the headline.
   b. ~~**Add the harsher variant — a project with no decanter evidence at
      all.**~~ **DROPPED — out of scope (maintainer call, 2026-07-26.)** Decanter's
      concern is projects that *use* decanter; whether an agent discovers the
      tool in a project that has never heard of it is a marketing/adoption
      question, not a product one. Not to be revived without a new reason.
   c. **Fix S6's fixture mismatch first** — it reuses the empty `s1-skeleton`
      node while its prompt says "on top of whatever it already does", which cost
      a turn (Plan 35 run report).

   **Only after (a)+(b)** should directions 1–3 be scoped: if the breadcrumb case
   holds up and only the no-evidence case fails, the fix is narrower (and closer
   to [Plan 50](50-code-node-authoring-skill.md)'s skill route) than this plan
   currently assumes.

## Non-goals

- Auto-installing anything, or any behaviour that runs without the user asking.
- Weakening the `jsCode` guard to accommodate agents that bypassed decanter —
  the guard is not the problem here.

## Acceptance (draft)

A blind agent, dropped into a project that uses decanter but with no prior
knowledge of it, reaches for the CLI rather than raw MCP — demonstrated by a
field-test scenario built for exactly that question, not by inspection.
