# Plan 34 — Post-pivot identity & messaging: keep the name, retell the story

**Priority:** P1 (website landing — live factual drift since the pivot merged) /
P2 (the positioning layer)
**Status:** Open — the former hard gate cleared 2026-07-22:
[Plan 32](DONE-32-mcp-native-code-layer.md) executed and merged (PR #97).
Coordinate command-facing copy with [Plan 33](BLOCKED-33-post-mcp-pivot-wave.md)'s
lifecycle work (`delete`→`archive`, the `test` verb) so it's written once.
**Theme:** The outward identity — name verdict, taglines, README, website
landing, docs framing, npm/GitHub metadata, comparison positioning — retold for
the Code-node-layer scope. **The name `n8n-decanter` stays** (decision recorded
below).
**Model:** Opus for the positioning copy (tagline/hero/comparison); Sonnet for
the mechanical surface sweep.

## Why

[Plan 32](DONE-32-mcp-native-code-layer.md) changed what the project *is* —
decanter stopped owning canonical workflow sync and became the **Code-node
craftsmanship layer**, with structure + lifecycle delegated to n8n's MCP +
skills. Its execution (PR #97, merged 2026-07-22) already landed the
**accuracy** layer in `README.md` + `/docs`: a new canonical paragraph (MCP,
draft-first, structure-stays-n8n's-job), rewritten caveats, a "Draft-first by
construction" bullet. What remains — this plan's scope:

- **Website landing untouched by #97 — live factual drift (P1).** The hero
  (`website/src/pages/index.astro`) still says *"… pushed back through the n8n
  API"* and the features array still sells the old whole-workflow drift-guard
  framing ("keep you from clobbering remote edits"). The site now contradicts
  the shipped tool.
- **The positioning layer was deliberately left open** — tagline unchanged;
  the whole "How it compares" section is pre-pivot (including a stale
  *"first-party repo-authored creation planned (`node create` +
  `push --create`)"* cell — `push --create` was dropped in Plan 21); the
  pivot's wins (draft-first, OAuth, upcoming guard-proxy/`test`) aren't
  *positioned*, only documented; npm/GitHub metadata and demo GIFs untouched.

Separately, the maintainer challenged **the name itself** (2026-07-22): does
"decanter" still fit a tool that no longer pours the whole workflow into git?
The verdict is recorded here so it isn't relitigated.

## Design decision — the name stays (challenged 2026-07-22)

Challenge and verdict, so the reasoning survives:

- **The pivot narrows the pour, not the metaphor.** Decanting is *separation*:
  you pour out the part that benefits from breathing and deliberately leave the
  rest in the bottle. The old story (decant the whole workflow) actually fit
  the metaphor *loosely* — a decanter never holds the bottle. Post-pivot it
  fits *tightly*: the **code** — the part that benefits from git, types, tests,
  review — is decanted into files; structure and lifecycle stay in n8n where
  its native tooling (editor, MCP, skills) is the right vessel. The name gets
  sharper, not stale.
- **What actually drifted is the copy layer, not the brand** — "syncs your
  instance", "through the n8n API", the drift-guard/clobber framing. That's
  fixable without a rename.
- **Rename cost is real and user-facing:** the published npm package
  ([DONE-13](DONE-13-open-source-release.md)), binary name, repo + docs URL,
  and the data-model identifiers (`decanter.config.json`, `.decanter.json`,
  `.decanter-template.json`, `decanter-ts-plugin/`). Stacking that onto the
  pivot's already-breaking migration doubles user pain for zero capability.
- **No candidate beats it.** Literal alternatives (`n8n-code-layer`,
  `n8n-codecraft`, …) are generic; the `n8n-` prefix already carries
  discoverability, and "decanter" is distinctive with an established presence
  in the comparison narrative.
- **Verdict: keep the name; rewrite the story** around *"decanter holds the
  pour, not the bottle."* Pre-1.0 was the rename window — this decision
  deliberately closes it.

## Source

- This session (2026-07-22): maintainer's name challenge + "README and website
  communication need to adapt".
- [Plan 32](DONE-32-mcp-native-code-layer.md) Task 7 — the docs/changelog/
  PLAN.md **accuracy** overhaul (landed with PR #97). This plan is the
  **positioning** layer on top; the boundary is drawn in Non-goals.
- [Plan 33](BLOCKED-33-post-mcp-pivot-wave.md) — verb renames, `test` verb,
  verb-taxonomy docs; command-facing copy here follows its outcomes.

## Tasks

1. **Positioning kit — decide the canonical strings once, then propagate**
   (maintainer sign-off required; may be drafted before the gate clears):
   - **Tagline:** iterated with the maintainer (2026-07-22) from their draft
     *"agentic driven mcp-first n8n code toolkit – create code heavy workflows
     like real software"*. Distilled rules: **"toolkit"** and **"code-heavy
     workflows"** are keepers (the right post-pivot noun; names the target
     user); protocol plumbing (**"MCP"**) stays out of the headline —
     translate it to its user-visible win (**draft-first**) and keep
     "MCP-native" for the paragraph, npm keywords, and badges where it does
     discovery work; *"built for AI coding agents"* beats "agentic[-driven]"
     (concrete, names who it's for); abstractions ("like real software")
     become the concrete goods (*typed, tested, in git*) — also "real
     software" subtly disses n8n just as the positioning starts leaning on
     n8n's own MCP. Second maintainer round: *"typed, tested, shipped
     draft-first"* alone drops **shared code/imports** and the **local/offline
     benefits** (simulate, `node run`, executions) — a one-liner can't hold
     six features, so the kit is **two-tier**: a tight headline plus a
     standing subline that always enumerates the **four pillars** — **typed**
     (TS + typed globals), **shared** (imports/npm bundling, Cloud-safe),
     **tested locally** (offline `check`/`node run`/`simulate` on real
     executions), **draft-first** (the MCP ship path). Candidates for
     sign-off:
     1. Headline *"The agent-first n8n code toolkit"* + subline *"Code-heavy
        workflows: typed TypeScript with shared libraries, tested offline
        against real executions, shipped draft-first over n8n's MCP."*
        (recommended — README bold line + paragraph, website h1 + p)
     2. One-line variant where only one line fits (npm `description`):
        *"The agent-first n8n code toolkit — typed nodes, shared libraries,
        offline tests, draft-first shipping."*
     3. *"n8n runs the workflow; decanter owns the code — a toolkit for
        code-heavy workflows, built for AI coding agents."* (boundary-led
        alternative headline)
   - **Canonical paragraph** replacing the "syncs your instance … n8n API"
     sentence: decanter extracts every Code node's source into its own
     `.js`/`.ts` file — typed, testable, reviewable, in git — and syncs it
     draft-first over n8n's MCP.
   - **Boundary sentence** (used everywhere the scope is explained):
     *"Structure and lifecycle belong to n8n — editor, MCP, skills. The code
     inside belongs to decanter."*
2. **README positioning pass** (`README.md` — #97 already landed the accuracy
   baseline: intro paragraph, caveats, draft-first bullet):
   - Hero tagline + intro re-cast from the kit (Task 1's headline + subline).
   - **Feature bullets:** order/frame around the four pillars; make **shared
     code** and the **local/offline loop** as prominent as draft-first.
   - **"How it compares" reframe (fully open — untouched by #97):** decanter
     no longer competes on canonical sync — n8n's MCP + skills become the
     *complement it builds on*, not a rival (say so explicitly). Re-examine
     every row ("Versioning" becomes code-first + read-only snapshot; fix the
     stale *"planned (`node create` + `push --create`)"* cell); add rows for
     the new differentiators — **draft-first edits/deliberate publish** (the
     API-based tools can't do it) and **instance-side pinned tests with
     diff** (`test`, once Plan 33 ships it). Update the "Choose X if you…"
     cards and the bottom line.
3. **Website landing** (`website/src/pages/index.astro`) — **P1: carries the
   live drift** (hero still says "pushed back through the n8n API"; features
   still sell the whole-workflow drift-guard framing). Hero h1/p, the
   `features` array, choose-cards and the condensed compare table — the site
   mirrors the README; change both in lockstep. Check `BaseLayout` /
   head metadata (title, description, OG) for the old sentence. If the
   positioning kit isn't signed off yet, an accuracy-only hotfix of the hero
   paragraph (mirroring #97's README intro) may ship first — don't let the
   factual drift wait for copy polish.
4. **Docs framing sweep** (positioning only — verb-page mechanics belong to
   Plan 32 Task 7 / Plan 33): `docs/getting-started/*` (OAuth-first init, API
   key optional), `docs/concepts/sync-layout.md` (snapshot semantics) and
   `docs/concepts/push-gates.md` (post-pivot guard set), `docs/agents/*`
   (proxy-first wiring per Plan 33 Task 3), `docs/cli/overview.md` intro.
   `llms.txt`/`llms-full.txt` regenerate from docs — no manual pass.
5. **Metadata:** `package.json` `description` + `keywords` (drop/adjust
   `"sync"`, add `"mcp"`); GitHub repo About text + topics; verify the npm page
   (README-driven) reads right after Task 2.
6. **Demo media currency:** `docs/terminal-demo.gif` + `docs/agent-demo.gif`
   (used by README *and* landing page) — re-record if they show a
   removed/renamed flow (e.g. `delete` in the picker, API-key init); keep if
   still representative.

## Acceptance / verification

- Grep the retired claims across `README.md`, `docs/`, `website/src/`:
  "syncs your n8n instance", "through the n8n API", "clobbering remote edits" —
  zero pre-pivot identity claims remain.
- README hero, landing hero, docs overview, npm `description`, and the GitHub
  About all tell the same one-sentence story (the kit's canonical paragraph).
- No comparison row or feature bullet contradicts the post-pivot scope; the two
  old flagship caveats appear as wins, not caveats.
- The name decision above is referenced by the rewritten PLAN.md (Plan 32
  Task 7 owns that rewrite).

## Non-goals

- **Renaming** the tool, binary, npm package, repo, or data-model files —
  decided above.
- Verb-page mechanics and command-reference accuracy — Plan 32 Task 7 and
  Plan 33 own those; this plan owns framing/positioning.
- PLAN.md rewrite (Plan 32 Task 7) and the changelog's **Breaking:** entries
  (they ride the code changes, not this copy pass).

## Notes

- **Gate history:** originally hard-gated on Plan 32's execution (advertising
  an unshipped pivot); the gate cleared 2026-07-22 when PR #97 merged. npm's
  *published* package still predates the pivot until the next release — that's
  the normal `[Unreleased]` steady state, not a reason to hold messaging
  (GitHub + site follow main). Command-facing copy (`archive`, `test`) still
  follows Plan 33's outcomes so it's written once.
- **Changelog:** pure messaging/docs copy is not a CLI behavior change → no
  `[Unreleased]` entry of its own (the pivot's entries land with Plans 32/33).
- The README/website duplication (feature bullets + compare table exist in
  both) is a known drift risk this plan touches twice — keep the edits in one
  PR so they can't diverge.
