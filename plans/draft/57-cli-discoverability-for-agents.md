# Plan 57 — a coding agent should find decanter before it hand-rolls raw n8n MCP

**Status:** Draft
**Priority:** P1 (the blind field test's oldest unfixed finding)
**Class:** Distinctive feature — the whole point of decanter is that Code-node
source lives in git; an agent that never finds the CLI gets none of it.
**Source:** [Plan 35](../open/35-blind-agent-field-test.md) blind field test,
round-1 finding 1 — carried unfixed through round 2 and the 2026-07-24 triage,
where the maintainer chose to give it its own plan.
**Snapshot:** 2026-07-24T11:45Z @ f0692e1
**Model:** Opus for the positioning/wording decisions (this is mostly a
judgement problem, not a coding one); Sonnet for whatever mechanical surface
work follows.

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

## Non-goals

- Auto-installing anything, or any behaviour that runs without the user asking.
- Weakening the `jsCode` guard to accommodate agents that bypassed decanter —
  the guard is not the problem here.

## Acceptance (draft)

A blind agent, dropped into a project that uses decanter but with no prior
knowledge of it, reaches for the CLI rather than raw MCP — demonstrated by a
field-test scenario built for exactly that question, not by inspection.
