# Decisions needed — open questions for Malte

Items an agent cannot settle alone: they need your preference, your
infrastructure, or your go-ahead. Each entry says what's proposed, what the
options cost, and what happens if you do nothing. Delete entries once
decided (move the outcome into the relevant plan).

## `preflight` verb — group `check`/`simulate`/`test` under one gate? (2026-07-22)

- **Context:** [Plan 34](OPEN-34-post-pivot-identity-and-messaging.md) coins
  **"preflights"** as the marketing/docs umbrella for the verification surface
  (`check`, `simulate`, Plan 33's upcoming `test`). Decided 2026-07-22:
  vocabulary only for now — no CLI surface. You flagged you'll consider going
  further.
- **Proposed (parked):** a `preflight` verb that runs the whole gate as one
  command — offline (`check` + `simulate`), plus `test` when credentials and
  the instance allow. One CI-friendly entry point; the product mirrors the
  marketing term.
- **Costs/considerations:** verb-surface growth (Plan 27 grammar), overlap
  with `push`'s own gates, fixture-selection semantics (`simulate`/`test`
  need captures or mocks — what does a bare `preflight` pick?), and whether
  it's a real verb or an alias.
- **If you do nothing:** nothing breaks — "preflights" stays docs vocabulary
  and the verbs stay separate.
- **If adopted:** distinctive-features backlog entry + docs taxonomy update
  (Plan 34's preflight card then points at one verb).

*Resolved so far: `completion` verb → kept
alongside the Plan 19 picker (decided 2026-07-19, recorded in
[Plan 19](DONE-19-interactive-workflow-picker.md) Notes);
Docker smoke suite → approved
dev-only, graduated to [Plan 15](DONE-15-docker-n8n-smoke-suite.md);
bundle compression/minification → dropped (recorded in
[Plan 14](DONE-14-bundle-shared-code-into-ts-pushes.md) Notes);
dist/template release blocker → fixed, acknowledged (re-verify step in
[Plan 13](DONE-13-open-source-release.md)).*
