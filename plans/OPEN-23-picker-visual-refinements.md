# Plan 23 — Picker visual refinements

**Priority:** P2
**Status:** Not started
**Theme:** Feed the docs-site picker *simulation*'s visual polish (aligned
columns, shape-based status glyphs, a titled stage header) back into the real
`lib/picker.mts` — presentation only, the state machine is untouched.
**Model:** Sonnet (rendering + column math; Haiku fine for the mechanical parts).

## Why

The Plan 16 docs site ships a scripted picker animation
([`website/src/components/TerminalDemo.astro`](../website/src/components/TerminalDemo.astro))
that reads cleaner than today's real picker:

- workflow rows have an **aligned id column** (names padded to a common width),
- each row leads with a **`●`/`○` status glyph** (filled = pulled, hollow =
  not pulled) instead of a trailing `(not pulled)` phrase,
- each stage has a short **title** so the panel reads as a titled block.

All three are pure `renderLines` changes — the reducer, filtering, windowing,
resume logic, and their unit tests stay exactly as they are. The user asked to
feed these design decisions back (2026-07-20, "I like your style").

## Source

Direct user request (2026-07-20), building on
[Plan 19](DONE-19-interactive-workflow-picker.md) (the picker) and the
[Plan 16](DONE-16-docs-website.md) simulation. Cross-links
[Plan 22](DONE-22-test-suite-depth.md) (picker-IO tests). The related
*"`executions` missing from the interactive menu"* backlog item shipped
separately in **v0.3.0** (#29), so it's dropped from the tasks below.

## Tasks

All edits are confined to `renderLines` (and small pure helpers beside it) in
[`lib/picker.mts`](../lib/picker.mts).

1. **Aligned id column.** Pad each visible workflow name to the widest name in
   the current window (capped at the existing 48-char truncation) so the dim
   ids line up in a straight column. Keep truncation + the `… N more` overflow
   line. Mechanical string-width math — no color/state logic.
2. **Shape-based status glyph.** Lead each row with `●` (pulled) / `○` (not
   pulled), colored green/yellow as today. Because the two glyphs differ by
   **shape**, this stays readable under `NO_COLOR`/monochrome — which lets the
   trailing `(not pulled)` words go (see Design decision). The `❯` cursor stays
   the leftmost column; the status glyph sits between it and the name.
3. **Titled stage header.** Add a short title line per stage — `pick a workflow`
   over the filter line, and the workflow's name over its verb list (the verb
   stage already prints `name  id`; make it read as a heading). Match the
   simulation's tone; **skip the heavy box-drawing frame** unless it still feels
   light at a real 10-row `LIST_HEIGHT` (decide during implementation).
4. **Pure render tests.** `renderLines` is currently untested by CI. Add a
   handful of `node:test` cases (feed a `PickerState`, assert the rendered
   strings: glyphs present, ids aligned, monochrome-safe output). Dovetails
   with [Plan 22](DONE-22-test-suite-depth.md)'s picker goal.

## Acceptance / verification

- Bare `n8n-decanter` on a TTY shows aligned ids, `●/○` status glyphs, and a
  per-stage title.
- Output stays legible with `NO_COLOR=1` (glyphs distinguish state by shape,
  not color alone) — the guarantee Plan 19 protected with the `(not pulled)`
  words.
- Reducer/filter/window/resume behavior and their existing unit tests are
  unchanged; new render tests pass; `npm test` + `npm run typecheck` green.
- Piped/non-TTY invocation is unaffected (the picker never runs there).

## Design decision

**Drop the `(not pulled)` words in favor of the `○` glyph.** Plan 19 spelled
out the state in words specifically so color wasn't load-bearing under
`NO_COLOR`. `●` vs `○` carries the same distinction by *shape*, so the words
become redundant per row. To keep it discoverable, state the key once in the
footer legend (e.g. `● pulled · ○ not pulled`) rather than on every row.
Flag for the user if they'd rather keep the words.

## Notes

- **CHANGELOG:** user-facing appearance change → a `Changed` entry when it
  lands.
- **PLAN.md:** no data-model or flow change — presentation only; no PLAN.md
  edit expected.
- **Git:** code change → **worktree**, not the docs fast path.
- Keep the split the file already documents: pure state machine (exported,
  tested) vs. the thin TTY IO block — all of this lives in the IO half.
