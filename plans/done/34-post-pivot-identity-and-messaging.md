# Plan 34 — Post-pivot identity & messaging: keep the name, retell the story

**Priority:** P1 (website landing — live factual drift since the pivot merged) /
P2 (the positioning layer)
**Status:** Done 2026-07-22 — executed across PR #104 (README hero + compare
reframe, website landing, docs framing, package.json + GitHub metadata) and
PR #108 (vendored demo-GIF recorder in `website/public/gifgen/` + re-recorded
GIFs for the post-pivot flow). Both gates had cleared: [Plan 32](../done/32-mcp-native-code-layer.md)
(PR #97) and [Plan 33](../done/33-post-mcp-pivot-wave.md) (PR #101 — `archive`,
`test`, `mcp serve`; `duplicate` dropped). The name verdict stands:
`n8n-decanter` stays.
**Theme:** The outward identity — name verdict, taglines, README, website
landing, docs framing, npm/GitHub metadata, comparison positioning — retold for
the Code-node-layer scope. **The name `n8n-decanter` stays** (decision recorded
below).
**Model:** Opus for the positioning copy (tagline/hero/comparison); Sonnet for
the mechanical surface sweep.

## Why

[Plan 32](../done/32-mcp-native-code-layer.md) changed what the project *is* —
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
  ([DONE-13](../done/13-open-source-release.md)), binary name, repo + docs URL,
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

## Design decision — positioning kit (signed off 2026-07-22)

Iterated to final form in the 2026-07-22 maintainer session:

> **The toolkit for building code-heavy n8n workflows — agent-first,
> MCP-native.**
> *Code nodes as files* — TypeScript, shared types & helpers, code-level git
> versioning, preflights.

Plus the cash-in feature card (the hero *coins* "preflights"; the grid defines
it):

> **Preflights** — `check`, `simulate`, `test`: verify offline or on your
> instance.

The decisions behind the strings:

- **"Preflight(s)" is the umbrella term** for the whole verification surface
  (testing, checking, validating, simulating): the category frame in docs and
  feature cards, with **"verify"** as the verb in running copy. It's coined as
  a plural noun in the hero, so a nearby definition is **mandatory** wherever
  the hero appears. The Plan 33 `test`-verb taxonomy table
  (`check` = static/offline, `simulate` = local runtime, `test` = instance
  runtime) should adopt "Preflights" as its heading — coordination note, not
  an edit to Plan 33. **Scope (decided 2026-07-22): marketing/docs vocabulary
  only** — no CLI surface; a possible `preflight` verb grouping the gate is
  parked in [DECISIONS-NEEDED](../DECISIONS-NEEDED.md). *(Since unparked, same
  day: [Plan 36](../done/36-preflight-verb.md) builds the verb — once it lands,
  the preflight card points at one command.)*
- **Draft-first is deliberately NOT in the hero** (maintainer): expected
  behavior isn't a feature — a sane tool doesn't celebrate
  not-going-live-on-save; the public API's instant republish is the anomaly.
  Draft-first lives in the compare table (against API-based tools it *is* a
  differentiator) and a quiet docs line, never the tagline.
- **"MCP-native" is a headline tag on purpose** (maintainer overruled the
  no-plumbing-in-headlines rule): for this audience MCP is a
  discovery/credibility signal, not plumbing. "-native" over "-first" — the
  established idiom, and a structural claim (built on n8n's first-party
  surface).
- **Extension slots, by design:** "TypeScript" → "TypeScript & Python" when
  [Plan 28](../open/28-python-code-nodes.md) lands; "preflights" was designed to
  absorb the `test` verb — Plan 33 shipped it 2026-07-22, so the card carries
  its full `check`/`simulate`/`test` form from day one; "code-level git
  versioning" is scope-honest (code, not whole-workflow — exactly the
  post-pivot promise) and never expires.
- **Slot mapping:** headline alone = npm `description` + GitHub About;
  headline + subline = README hero + website h1/p; the preflight card = both
  feature grids. This one decision fills every Task 5 metadata slot.
- **Boundary sentence** (unchanged): *"Structure and lifecycle belong to n8n —
  editor, MCP, skills. The code inside belongs to decanter."*

## Source

- This session (2026-07-22): maintainer's name challenge + "README and website
  communication need to adapt".
- [Plan 32](../done/32-mcp-native-code-layer.md) Task 7 — the docs/changelog/
  PLAN.md **accuracy** overhaul (landed with PR #97). This plan is the
  **positioning** layer on top; the boundary is drawn in Non-goals.
- [Plan 33](../done/33-post-mcp-pivot-wave.md) — verb renames, `test` verb,
  guard-proxy; executed and merged 2026-07-22 (PR #101), so command-facing
  copy here builds on its shipped outcomes (incl. the unplanned **Breaking:
  `duplicate` dropped**).

## Tasks

1. **Positioning kit — DONE 2026-07-22.** Signed off in the maintainer
   session; final strings and the decisions behind them are recorded in
   "Design decision — positioning kit" above. The iteration trail, kept
   short: started from the maintainer's *"agentic driven mcp-first n8n code
   toolkit – create code heavy workflows like real software"*; "toolkit" and
   "code-heavy" survived every round; "building" absorbed
   workflow-creation; "like real software" became concrete goods; a round of
   verb-led pillar sublines was replaced by the maintainer's fragment + noun
   list; "preflights" was coined to compress the verification surface; and
   two early agent rules were maintainer-overruled (MCP *does* go in the
   headline as a tag; draft-first does *not* — expected behavior isn't a
   feature). Propagation happens in Tasks 2–5.
2. **README positioning pass** (`README.md` — #97 already landed the accuracy
   baseline: intro paragraph, caveats, draft-first bullet):
   - Hero tagline + intro re-cast from the kit (Task 1's headline + subline).
   - **Feature bullets:** order/frame around the four pillars; make **shared
     code** and the **local/offline loop** as prominent as draft-first.
   - **"How it compares" reframe (untouched by #97; stance decided
     2026-07-22):** the table stays **three columns** — n8n's MCP + skills get
     **no column of their own** (you don't benchmark against what you build
     on); the complement framing is one explicit sentence above the table
     instead. Re-examine every row ("Versioning" becomes code-first +
     read-only snapshot); the **"Agentic workflow creation" row upgrades to
     ✅** ("your agent builds structure over n8n's MCP, guard-proxied;
     decanter owns the code") — **verified 2026-07-22 against merged main:**
     `create` gates SDK code through `validate_workflow` before
     `create_workflow_from_code`, `mcp serve` (guard-proxy) and `test`
     shipped (PR #101). One correction the table must carry: **`duplicate`
     was dropped entirely** (Breaking, not re-expressed over MCP) — no row or
     cell may reference it. Fix the stale *"planned (`node create` +
     `push --create`)"* cell. Add rows for the new differentiators — **draft-first
     edits/deliberate publish** (API-based tools can't) and **instance-side
     pinned tests with diff** (`test`). The **"Choose X if you…" cards stay**
     (decided), refreshed to the kit; update the bottom line.
3. **Website landing** (`website/src/pages/index.astro`) — **P1: carries the
   live drift** (hero still says "pushed back through the n8n API"; features
   still sell the whole-workflow drift-guard framing). Hero h1/p, the
   `features` array, choose-cards and the condensed compare table — the site
   mirrors the README; change both in lockstep. Check `BaseLayout` /
   head metadata (title, description, OG) for the old sentence. The kit is
   signed off, so this ships the final hero copy directly (see Rollout) —
   including the preflight feature card that defines the coined term.
4. **Docs framing sweep** (positioning only — verb-page mechanics belong to
   Plan 32 Task 7 / Plan 33): `docs/getting-started/*` (OAuth-first init, API
   key optional), `docs/concepts/sync-layout.md` (snapshot semantics) and
   `docs/concepts/push-gates.md` (post-pivot guard set), `docs/agents/*`
   (proxy-first wiring per Plan 33 Task 3), `docs/cli/overview.md` intro.
   `llms.txt`/`llms-full.txt` regenerate from docs — no manual pass.
5. **Metadata:** `package.json` `description` (= the kit headline) +
   `keywords` — decided 2026-07-22: **keep `sync`**; add **`mcp`**,
   **`ai-agents`**, **`toolkit`** (`cli` is already present); `python` joins
   when Plan 28 ships. GitHub repo About (= headline) + matching topics;
   verify the npm page (README-driven) reads right after Task 2.
6. **Demo media currency:** `docs/terminal-demo.gif` + `docs/agent-demo.gif`
   (used by README *and* landing page) — re-record if they show a
   removed/renamed flow (e.g. `delete` in the picker, API-key init); keep if
   still representative.

## Rollout

Originally split into two waves because Plan 33 was mid-execution; **Plan 33
merged 2026-07-22 (PR #101), so the split is moot** — every task is
executable now, in one pass or as small PRs. Residual ordering only:

- **First:** Task 3 (website landing — it carries the live factual drift, now
  even staler since #101 also renamed verbs) together with Task 5's instant
  slots (GitHub About; npm `description` + keywords).
- **Then:** Task 2 (compare reframe — cites the shipped `archive`, `test`,
  `mcp serve`; no `duplicate`), Task 4 (docs framing sweep), Task 6 (GIFs —
  the picker's verb menu changed with #101, so record once, now).

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
