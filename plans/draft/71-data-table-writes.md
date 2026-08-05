# Plan 71 — Data-table writes: probe feasibility before promising anything

**Status:** Draft
**Priority:** P3
**Source:** feature request in the 2026-07-30 field report — the user wanted three
queue rows reset and the agent had to hand it back.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

Decanter's data-table support is read-only by design (Plan 25 listed "any write"
as an explicit non-goal). Whether a *write* path is even buildable is **unproven**
— and the answer differs by transport, so the first task is a live probe, not
code.

## What's settled

- **Over MCP: definitively impossible for updating existing rows.** n8n's
  data-table MCP tools are **add-only** (create/rename, add rows + columns), and
  `search_data_tables` never returns row values — there is no op that mutates an
  existing row. `AGENTS.md:656` records this from the spike, and
  [`lib/api.mts:5`](../../lib/api.mts) cites it as why the REST path exists at all.
- **Over REST: unresolved.** The smoke suite proves `POST /api/v1/data-tables`
  (create table) and `POST /api/v1/data-tables/{id}/rows` (insert) work, and write
  scopes exist (`dataTable:create`, `dataTableColumn:create`,
  `dataTableRow:create`). But no in-repo evidence establishes a PATCH/PUT/DELETE
  row endpoint or a `dataTableRow:update`/`:delete` scope — the smoke key
  deliberately carries only `:create`.

## First task: one probe

Stand up a throwaway instance with the existing smoke harness, mint a key with
`dataTableRow:update` / `dataTableRow:delete` **if those scope names exist**, and
try PATCH/DELETE on `/api/v1/data-tables/{id}/rows`.

- **If they exist:** a write path is a REST-only verb with an opt-in config gate
  mirroring the existing `dataTables` switch — Plan 25's non-goal was a scope
  decision, not a technical block.
- **If they don't:** the honest answer to the user becomes "n8n itself has no
  row-update API", and **that sentence belongs in
  [`docs/cli/data-tables.md`](../../docs/cli/data-tables.md)** — today the docs say
  only that *decanter* doesn't write, leaving the reader to assume decanter is the
  constraint.

## Not in scope

The report also asked for the read-only nature to be documented more prominently.
**It already is** — bolded in the docs page's first prose paragraph, the first
bullet of the scaffolded `AGENTS.md`'s data-tables section (with the reason: MCP
can't read rows), inline in `--help`, and in the README verb table. The one place
it's *missing* is at the moment of failure, which is
[Plan 63](../done/63-field-feedback-bugfixes.md) task 6's 403 hint.
