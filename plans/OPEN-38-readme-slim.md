# Plan 38 — README overhaul: from 473-line manual to shop window

**Priority:** P1 (small, offline, clearly right — and it shrinks every future
PR's docs burden)
**Status:** Not started — **sizing decisions pending** (see the menu below)
**Model:** Sonnet (editorial work against an existing docs corpus; Opus not
needed once the decisions are made).
**Theme:** The README has grown into a second manual (473 lines) that
duplicates the docs site and makes itself the most drift-prone of the three
command surfaces. Cut it to the document a first-time visitor (GitHub / npm)
actually reads — what it is, why, quickstart, where the docs are — with a
strict **no-information-loss audit**: every cut line either already lives in
`/docs` or moves there in the same PR.

## Why

- **473 lines, and the deep half duplicates `/docs`.** "How node files work"
  (54 lines), "Browser live-reload" (21), "Type checking" (19), and ~60 lines
  of post-Commands prose largely restate
  [sync-layout](../docs/concepts/sync-layout.md), per-verb pages, and
  [configuration](../docs/concepts/configuration.md) — two places to update,
  drift between them (the `simulate`-verb omission that created the AGENTS.md
  grep-checklist rule happened exactly here).
- **The Commands block is the drift hotspot.** 69 lines with full flag
  signatures — a fourth copy of what `--help`, `/docs`, and the overview page
  already carry. Every verb/flag change must hit it (AGENTS.md three-surfaces
  rule), and Plans 36 (`preflight`) + 37 (`scenario` rename) are about to
  churn it again.
- **The audiences have separated.** Agents get AGENTS.md + the template
  scaffold + `/docs`; humans get the docs site. The README's remaining job is
  the first impression — GitHub visitors and the npm page — which the current
  wall of detail serves worse than a tight pitch would.

## Sizing decisions (menu — maintainer to pick)

1. **Target depth.** **(a) Shop window, ~150 lines** *(recommended)*: hero +
   feature bullets (tightened) + GIFs + quickstart + skills pairing (short) +
   compare + caveats (short) + docs pointer; the deep sections (node files,
   live-reload, type checking, setup gotchas, post-Commands prose) move to
   `/docs` after a delta audit. **(b) Moderate, ~250–300 lines**: keep every
   section, compress prose in place.
2. **Commands section.** **(a) Verb index** *(recommended)*: one line per
   verb (name + what it does), no flag signatures — flags live in `--help`
   and `/docs`; loosens the AGENTS.md three-surfaces rule to "README lists
   the verb + one-liner" (rule text updated in the same PR). **(b) Keep the
   full flag reference** as today.
3. **Compare table.** **(a) Keep it whole** *(recommended)*: it's the Plan 34
   positioning asset and earns its ~45 lines on the npm page. **(b) Replace
   with the bottom-line paragraph + a docs link.**

## Tasks

1. **Delta audit.** Diff every candidate-cut section against its `/docs`
   home; port the facts that exist only in the README (known: the old-Node
   `SyntaxError` gotcha, the `npm link`/build note, `engine-strict`,
   live-reload https caveat, `$env` isolation prose) into the right docs
   page(s) first.
2. **Rewrite the README** per the picked options; feature bullets tightened
   (14 → ~8, one line each where possible); Setup reduced to
   install + `init` + config + a credentials pointer.
3. **AGENTS.md rule update** (if 2a): reword the three-surfaces README bullet
   to the verb-index contract; keep the pre-PR grep checklist.
4. **Bookkeeping.** No CHANGELOG entry (docs-only). Check the website landing
   doesn't hotlink removed README anchors.

## Acceptance / verification

- README at the picked target length; every deleted fact findable in `/docs`
  (audit list in the PR description); links/anchors valid.
- A newcomer path reads coherently: what it is → see it (GIFs) → install →
  first sync → docs site for everything else.
- Three-surfaces rule still holds under the new contract (grep the verb list
  vs `docs/cli/overview.md`).

## Notes

- **Sequencing:** land before Plans 36/37 execute if possible — both touch
  the README, and a slim README makes their sweeps smaller. Not a blocker
  either way.
- **Relation to [Plan 34](DONE-34-post-pivot-identity-and-messaging.md):** the
  hero/positioning language is signed off and stays; this plan changes
  *volume*, not message.
- **Out of scope:** docs-site restructuring, AGENTS.md content beyond the
  rule tweak, template README.
