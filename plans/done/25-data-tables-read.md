# Plan 25 — Read data tables (dev/debug)

**Priority:** P2 (valuable, moderate scope; one live-verification gate)
**Status:** Done (2026-07-21 — all tasks implemented, unit + e2e + smoke green,
docs/changelog/PLAN.md updated; endpoints + scopes live-verified on n8n 2.30.7
*and* 2.31.4)
**Theme:** A read-only `data-tables` verb that pulls n8n data-table schemas and
rows into local gitignored files so you can develop/debug workflows against the
real table contents — config-gated (default on), with the read scopes added to
the recommended scoped-key permissions.

## Why

Workflows increasingly lean on n8n **data tables** (the built-in project-scoped
tables, n8n ≥ 2.x). When you author or debug a Code node — or a node that reads
a data table — offline, you have no view of what's actually in the table:
its columns or its rows. Today the CLI can fetch real **execution** data
([executions](../done/3-local-run-and-diff-fidelity.md)) but nothing about data
tables.

This adds the data-table analogue of `executions`: a **read-only** fetch of
table schema + rows into local, **gitignored** files, purely for development and
debugging (e.g. to hand a node's `run`/`simulate` fixture realistic shapes, or
to eyeball what a table holds). No writes — the CLI never mutates a data table.

The capability sits **behind a config flag that defaults to on**, so it works
out of the box but can be switched off by users who don't want the CLI reading
their tables at all (and who then needn't grant the read scope). Because it's
on by default, the data-table **read scope is added to the recommended
scoped-key permissions**.

## Source

- User request (2026-07-21): "read access to data tables for development and
  debug reasons, behind a config, default true, add it to recommended
  permissions."
- Extends the read-only-fetch pattern established by the `executions` verb
  (`lib/executions.mts`, Plan 3).
- New capability, not previously in [Plan 0](../draft/).

## Design decision

- **Shape = a fetch-to-disk verb, not run/simulate integration.** Mirror
  `executions`: fetch → materialize local JSON → gitignore. Wiring live
  data-table reads *into* the `run` emulator or the `simulate` engine so Data
  Table nodes execute offline is a **separate, larger** effort — see Non-goals.
  The "add it to recommended permissions" + "default true" framing matches a
  CLI-issued read exactly (as `execution:read` already is).
- **Placement is instance/project level, not per-workflow.** Data tables are
  **not** owned by one workflow (they're project-scoped), so — unlike
  `executions/`, which nests under each `workflows/<Name>/` — fetched tables
  land in a **single top-level `data-tables/`** dir next to `decanter.config.json`
  (`configDir`), self-ignored (`data-tables/.gitignore` = `*`). Layout:
  `data-tables/<table-slug>/columns.json` + `data-tables/<table-slug>/rows.json`
  (+ a `meta.json` carrying id/name/projectId). Slug is a kebab of the table
  name with the id appended for uniqueness (names aren't guaranteed unique).
- **Config gate.** New `decanter.config.json` key **`dataTables`** (boolean,
  **default `true`**). `true` → the verb is available; `false` → the fetch verb
  refuses with a clear message ("data-table reads are disabled — set
  \"dataTables\": true in decanter.config.json") and the recommended key needn't
  carry the read scope. Gates the fetch only; `data-tables clean` (offline
  local delete) stays available regardless.
- **Rows can be large → fetch a *filtered* slice.** The rows endpoint takes
  server-side `filter` (a JSON string of conditions, e.g.
  `{"type":"and","filters":[{"columnName":"status","condition":"eq","value":"active"}]}`),
  `search` (free text across string columns), and `sortBy` (`columnName:asc|desc`),
  plus `limit` (default 100, max 250) + `cursor` pagination. So the verb exposes
  filtering as a first-class way to pull only the rows you need instead of the
  whole table — a dev/debug convenience, not a backup tool. Default is a single
  capped page; `--all` follows `cursor` to exhaust a (usually filtered) result.

## Open question

- **What does "add it to recommended permissions" mean?** Two real surfaces:
  1. **n8n API-key scopes** — the "recommended minimal-scope key" lists in
     `README.md` / `docs/concepts/configuration.md` / `template/.env.example`.
     Task 5 covers this (default assumption — the CLI issues the read, so the
     recommended key should allow it, exactly like `execution:read`).
  2. **Agent permission allowlist** — `template/.claude/settings.local.json.example`
     `permissions.allow`. **Tension:** the closest analog, `executions` (also
     fetches potentially-PII data to a gitignored dir), is *deliberately not*
     in that allowlist. Auto-allowing `data-tables` would break that precedent,
     so it's left decision-gated in task 6 rather than assumed.
  Resolve which surface(s) before the allowlist part of task 6 is wired; (1) is
  taken as done regardless.

  **Resolved (2026-07-21):** both surfaces. The tension in (2) dissolved because
  the precedent flipped just before this plan ran — **PR #81 added `executions`
  to the Claude allowlist** as a "safe read" (`Bash(n8n-decanter executions)` +
  `:*`). `data-tables` is the same class (reads the remote, never writes,
  gitignored), so it joined the allowlist the same way (`data-tables` + `:*`),
  and `data-tables clean` is offline like `executions clean`. Surface (1) shipped
  as planned.

## Tasks

Grounded in the real files. Endpoint/field/scope **shapes are gated on live
verification** (see task 7) — same discipline as Plan 20.

1. **API client — read-only methods** (`lib/api.mts`). Add, mirroring
   `listWorkflows`/`getExecution` (GET only, timeout-guarded via `#request`):
   - `listDataTables()` — `GET /api/v1/data-tables`, cursor-paginated like
     `listWorkflows` (verify pagination shape).
   - `getDataTableColumns(id)` — `GET /api/v1/data-tables/{id}/columns`.
   - `getDataTableRows(id, { limit, cursor, filter, search, sortBy })` —
     `GET /api/v1/data-tables/{id}/rows`, passing the server-side `filter`
     (JSON string), `search`, `sortBy`, and `limit` (default 100, max 250) query
     params so callers pull a **filtered slice** of a large table. Returns the
     page + `nextCursor`; a `{ all: true }` helper (or the fetch module) follows
     `cursor` to exhaust a filtered result. Never write through any data-table
     endpoint.
   - Add `DataTable` / `DataTableColumn` / `DataTableRow` types to
     `lib/types.mts`.

2. **Fetch + materialize module** (`lib/datatables.mts`, new — model on
   `lib/executions.mts`):
   - `fetchDataTables(api, configDir, { tableRefs, limit, filter, search, sortBy, all }, log)`
     — list tables (optionally filtered to given refs by id or name), fetch
     columns + the (filtered) rows for each, write
     `data-tables/<slug>/{meta,columns,rows}.json`. **`meta.json` records the
     applied `filter`/`search`/`sortBy`/`limit` and row count** so a filtered
     `rows.json` is self-describing (never mistaken for the whole table).
     Self-ignore the `data-tables/` dir with a `.gitignore` of `*` (data tables
     can hold PII — same reasoning as `executions/`). Log per-file writes + a
     summary that names the filter when one is set.
   - `cleanDataTables(configDir, log)` — offline delete of the local
     `data-tables/` dir (mirrors `cleanExecutions`).

3. **Config** (`lib/config.mts`, `lib/types.mts`). Add `dataTables: boolean`
   to `DecanterConfig` (default `true`: `cfg.dataTables !== false`). Parse it in
   `loadConfig` alongside `commitOnPush` etc.

4. **CLI wiring** (`n8n-decanter.mts`):
   - Add `data-tables` to `VERBS` (hyphenated single token — parses as a
     positional matching a verb; a workflow literally named `data-tables` must
     be addressed by id, same existing rule).
   - `dispatch` case `"data-tables"`: parse optional table refs + `clean`
     subcommand (grammar like `executions`: `clean` may sit anywhere; other
     args are table refs). `clean` → `cleanDataTables` (offline). Otherwise
     check `config.dataTables` — refuse if `false` — then `fetchDataTables`.
   - **Filter/select flags** for pulling a slice of a large table: `--filter`
     (pass-through JSON string, 1:1 with the API param — agent-friendly),
     `--search` (free text), `--sort` (`col:asc|desc`), `--limit` (rows/page,
     default 100, cap 250), `--all` (follow `cursor` to exhaust the filtered
     set). Extend the value-flag regex in `main()` — currently
     `--(status|limit|execution|pin|n8n-version)` — to add `filter|search|sort`;
     `--all` is a boolean flag. `--filter='{…}'` passes JSON as one arg (the
     existing `--flag=value` / `--flag value` parser handles it).
   - Offline classification: `data-tables clean` is offline (no credentials);
     the fetch is online.
   - `usage()` line + `__complete` word list (`data-tables`).
   - **Picker menu** (`lib/picker.mts` `PICKER_VERBS`): data tables aren't
     per-workflow, so **do not** add to the per-workflow verb menu; note this
     explicitly (deviation from how `executions` was added).

5. **Recommended n8n API-key permissions (scopes) + gitignore.** Every place
   that lists the recommended scoped-key permissions gets the data-table read
   scopes (`dataTable:list`/`read`, `dataTableColumn:read`, `dataTableRow:read`),
   with a one-line note that they're only needed while `dataTables` is on:
   - `README.md` scoped-key bullets (~L85–94).
   - `docs/concepts/configuration.md` scopes list (~L45–48) **and** the config
     table (add a `dataTables` row, default `true`).
   - `template/.env.example` scoped-key comment block.
   - `docs/getting-started/quickstart.md` scope list.
   - `init` root `.gitignore` scaffold (`lib/init.mts`): add `data-tables/`
     (belt-and-suspenders with the self-ignore, same as `workflows/*/executions/`).

6. **Agent-facing surfaces (verb list + agent permission allowlist).**
   - `README.md` `## Commands` block (~L111–147): add the `data-tables`
     usage line(s) (and `data-tables clean`) — the verb enumeration users read;
     also extend the "read-only against the API" prose (~L182–188) with a
     data-tables sentence alongside `executions`.
   - `template/AGENTS.md.example`: add a `## Data tables (data-tables/ —
     temporary, gitignored)` section mirroring the existing
     `## Real execution data (executions/…)` section, so every agent (Codex /
     opencode / Claude read it natively) learns the verb + the gitignored dir.
     Per `CLAUDE.md`, the substance goes here, not in a per-agent file.
   - **Agent permission allowlist — decision-gated** (see "Open question"):
     `template/.claude/settings.local.json.example` `permissions.allow`
     currently allowlists the safe verbs `check`/`run`/`add`/`status`;
     `template/opencode.json.example` is allow-`*`-with-denies (no change
     needed). Whether `data-tables` joins the Claude allowlist depends on
     which "recommended permissions" was meant — resolve before wiring.

7. **Live verification (Docker smoke, `test/smoke-n8n.mts`, Plan 15/18).**
   Against the pinned n8n 2.x container, verify the **endpoints, response
   field shapes, and the exact read scope names** (see "Scopes" below —
   `dataTable:*` vs the older `dataStore:*` internal name is the key unknown).
   Seed a table + rows via the API, assert the read verb round-trips schema +
   rows, assert a **`--filter`/`--search`/`--sort` fetch narrows the rows**
   server-side, and assert a key lacking the read scope 403s. Record the
   verified facts (endpoints, filter param shape, scope names) to the
   [[plan20-api-facts]]-style memory.

8. **Tests.**
   - Unit (`test/unit/`): config default (`dataTables` true when absent, false
     when set); slug derivation; `cleanDataTables` on a temp dir.
   - e2e (`test/e2e.mts`): mock-server step mirroring the `executions` step —
     fetch tables into `data-tables/`, assert files + self-ignore, then
     `data-tables clean`; and a `dataTables: false` step asserting the refusal.

9. **Docs + changelog + PLAN.md.**
   - New `docs/cli/data-tables.md` (verb page, mirror `docs/cli/executions.md`:
     usage, options, where data lands, "never commit", `clean`, offline/online),
     with a **"Pull a filtered slice"** section documenting `--filter` (with the
     JSON condition shape + operator examples), `--search`, `--sort`, `--limit`,
     `--all`.
   - `docs/cli/overview.md`: add to the command surface + the offline/online
     table (fetch = "reads the remote, never writes"; `clean` = offline).
   - `CHANGELOG.md` `[Unreleased]` → **Added**: the `data-tables` read verb + the
     `dataTables` config (default on).
   - `PLAN.md`: record the new **top-level gitignored `data-tables/` layout**,
     the `dataTables` config key, and the read-only-by-design stance (the CLI
     never writes data tables).

## Scopes (confirmed in task 7)

**Live-verified 2026-07-21 against `n8nio/n8n:2.31.4` and `2.30.7`** (facts saved
to the plan25-datatables-api-facts memory). The minimal **read** set the verb
needs — all present and enforced:

- `dataTable:list`, `dataTable:read` — list/read tables
- `dataTableColumn:read` — read columns (schema)
- `dataTableRow:read` — read rows

**Resolved:** current n8n names these **`dataTable:*`** (not the older internal
`dataStore:*`), and column/row reads have **distinct** scopes
(`dataTableColumn:read`, `dataTableRow:read`) — they don't fold into
`dataTable:read`. A key lacking them 403s. Data-table endpoints are present
across the supported matrix (2.30.7 → 2.31.4); the verb still feature-detects and
surfaces a friendly "need n8n ≥ 2.x" hint on a 404 for older/other instances,
and a full-access key works too. Verified endpoint/field shapes: list is
`{data,nextCursor}` (inlines columns), `/columns` is a bare array, `/rows` is
`{data,nextCursor}` with server-side `filter`/`search`/`sortBy`/`limit`+`cursor`;
`sortBy`'s `col:dir` value must be URL-encoded (the CLI's `URLSearchParams`
handles it); the table `id` is an alphanumeric token, not numeric.

## Acceptance / verification

- `n8n-decanter data-tables` fetches every table's schema + rows into a
  gitignored top-level `data-tables/` dir; `data-tables <ref>` scopes to one
  table; `data-tables clean` removes the dir (offline).
- **Filtered pull works:** `--filter '<json>'`, `--search`, and `--sort` narrow
  the rows server-side; `--limit`/`--all` control page size / exhaustion; the
  applied filter is recorded in each table's `meta.json`.
- With `"dataTables": false`, the fetch refuses with a clear message; `clean`
  still works.
- The CLI issues **only** GET against data-table endpoints (grep/tests confirm
  no write path).
- README, configuration.md, quickstart, and `.env.example` list the read
  scopes; configuration.md documents the `dataTables` key (default `true`).
- Unit + e2e green; smoke suite live-verifies endpoints + scope names on 2.x
  and the facts are saved to memory.
- CHANGELOG, docs page, overview, and PLAN.md updated in the same PR.

## Non-goals

- **Any write** to data tables (create/update/upsert/delete tables, rows, or
  columns). Read-only by design; the write scopes stay off the recommended key.
- **Committing** fetched table data (always gitignored — may hold PII).
- **Run/simulate integration** — making the `run` emulator or `simulate` engine
  serve live data-table reads to Data Table nodes offline. Larger; a candidate
  follow-up that would build on this verb's API client. Relates to
  [Plan 7](../done/7-engine-true-simulation-suite.md).
- Syncing data tables as a git-tracked, round-trippable artifact (this is the
  n8n-as-code concept's boundary — data tables are runtime data, not workflow
  source).

## Notes

- **Model (advisory):** Opus for the live-verification + scope/endpoint design
  (task 1, 2, 7); Sonnet for the mechanical CLI/docs/test wiring (tasks 3–6,
  8–9).
- Filed as a distinct feature from the n8n-as-code core, but it does **not**
  warrant its own backlog group per `AGENTS.md`: it's a read-side developer
  convenience within the existing sync-dir surface, exactly like `executions`.
