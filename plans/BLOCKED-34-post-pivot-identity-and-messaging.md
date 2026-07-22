# Plan 34 — Post-pivot identity & messaging: keep the name, retell the story

**Priority:** P2 (must land with / immediately after the pivot ships — outdated
messaging on a shipped pivot is P1)
**Status:** Blocked — hard gate: starts only after [Plan 32](OPEN-32-mcp-native-code-layer.md)
is **fully executed**; coordinate with [Plan 33](BLOCKED-33-post-mcp-pivot-wave.md)
Task 2 (verb renames, e.g. `delete`→`archive`) so command-facing copy is written
once. Task 1 (the positioning kit) may be drafted earlier for sign-off.
**Theme:** The outward identity — name verdict, taglines, README, website
landing, docs framing, npm/GitHub metadata, comparison positioning — retold for
the Code-node-layer scope. **The name `n8n-decanter` stays** (decision recorded
below).
**Model:** Opus for the positioning copy (tagline/hero/comparison); Sonnet for
the mechanical surface sweep.

## Why

[Plan 32](OPEN-32-mcp-native-code-layer.md) changes what the project *is* —
decanter stops owning canonical workflow sync and becomes the **Code-node
craftsmanship layer**, with structure + lifecycle delegated to n8n's MCP +
skills. Every outward surface still tells the pre-pivot story. The current
canonical sentence — *"n8n-decanter syncs your n8n instance into a git-friendly,
folder-per-workflow layout … pushed back through the n8n API"* — becomes wrong
on three axes at once:

- **Overclaims** — canonical whole-workflow sync is deliberately ceded;
  `workflow.json` demotes to a read-only snapshot (Plan 32 Task 6).
- **Factually wrong** — the code path is MCP, not the public API; the API key
  degrades to an optional extra (Plan 33 Task 2).
- **Undersells** — the pivot's headline wins aren't told anywhere: draft-first
  pushes (today's #1 README *caveat* — "pushing to a published workflow
  republishes it immediately" — becomes a flagship *feature*), OAuth instead of
  a long-lived key, the guard-proxy token custody story, the instance-side
  `test` verb.

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
- [Plan 32](OPEN-32-mcp-native-code-layer.md) Task 7 — the docs/changelog/
  PLAN.md **accuracy** overhaul. This plan is the **positioning** layer on top;
  the boundary is drawn in Non-goals.
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
     n8n's own MCP. Candidates for sign-off:
     1. *"The agent-first n8n code toolkit — code-heavy workflows, typed,
        tested, shipped draft-first."* (recommended)
     2. *"Work on the code inside n8n like a real codebase — built for AI
        coding agents."* (minimal evolution, keeps current equity)
     3. *"n8n runs the workflow; decanter owns the code — a toolkit for
        code-heavy workflows, built for AI coding agents."* (boundary-led)
   - **Canonical paragraph** replacing the "syncs your instance … n8n API"
     sentence: decanter extracts every Code node's source into its own
     `.js`/`.ts` file — typed, testable, reviewable, in git — and syncs it
     draft-first over n8n's MCP.
   - **Boundary sentence** (used everywhere the scope is explained):
     *"Structure and lifecycle belong to n8n — editor, MCP, skills. The code
     inside belongs to decanter."*
2. **README rewrite** (`README.md`):
   - Hero + intro paragraph from the kit.
   - **Feature bullets:** rewrite the sync/guard bullets (drift-guard "keeps
     you from clobbering remote edits" framing changes with the sync model);
     add draft-first push, OAuth-first `init`, `test`; the API-key-scopes
     Setup block shrinks to the optional-API-key surfaces (data-table rows,
     `executions` if kept — per Plan 33).
   - **Caveats:** today's two flagship caveats (immediate republish on push; no
     optimistic locking through the API) are **solved by the pivot** — flip
     them into the story of *why* MCP, don't just delete them. New caveats in:
     version floor (~2.13/2.20), per-workflow `availableInMCP` opt-in, MCP
     surface churn.
   - **"How it compares" reframe:** decanter no longer competes on canonical
     sync — n8n's MCP + skills become the *complement it builds on*, not a
     rival (say so explicitly). Re-examine every row: "Versioning" becomes
     code-first (+ read-only structure snapshot); add rows for the new
     differentiators — **draft-first edits/deliberate publish** (the
     API-based tools can't do it) and **instance-side pinned tests with
     diff** (`test`). Update the "Choose X if you…" cards.
3. **Website landing** (`website/src/pages/index.astro`): hero h1/p, the
   `features` array, choose-cards and the condensed compare table — the site
   mirrors the README; change both in lockstep. Check `BaseLayout` /
   head metadata (title, description, OG) for the old sentence.
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

- **Gate rationale:** shipping this copy before Plan 32 executes would
  advertise a tool that doesn't exist — npm still serves the API-based CLI.
  Execution order: after Plan 32; after (or with) Plan 33 Task 2's verb
  renames so command copy is written once.
- **Changelog:** pure messaging/docs copy is not a CLI behavior change → no
  `[Unreleased]` entry of its own (the pivot's entries land with Plans 32/33).
- The README/website duplication (feature bullets + compare table exist in
  both) is a known drift risk this plan touches twice — keep the edits in one
  PR so they can't diverge.
