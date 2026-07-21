---
title: data-tables
description: Fetch n8n data-table schemas and rows into local gitignored files for dev/debug.
order: 14
---

```sh
n8n-decanter data-tables [table…]              # schema + rows for every table (or the named ones)
n8n-decanter data-tables [table…] --filter '<json>' --search <text> --sort <col:asc|desc> --limit N --all
n8n-decanter data-tables [table…] clean        # delete fetched data (offline)
```

Fetches each n8n **data table** (the built-in project-scoped tables, n8n ≥ 2.x)
— its schema and its rows — into local files, so you can develop and debug a
workflow against the **real table contents** offline (e.g. to give a
[node run](/docs/cli/node-run/) fixture realistic shapes, or just to eyeball what
a table holds). **Read-only against the API** — the CLI never creates, updates,
or deletes a data table, column, or row.

A `<table>` is a table's **id or its exact name** (case-insensitive). With no
argument, every table is fetched.

## Where the data lands

Data tables are **project-scoped — not owned by a workflow** — so, unlike
[executions](/docs/cli/executions/) (which nest under each workflow folder), they
land in a **single top-level `data-tables/` dir** next to
`decanter.config.json`:

```txt
data-tables/
  <table-slug>/
    meta.json       # id, name, projectId, fetchedAt, rowCount + the applied filter/search/sort/limit
    columns.json    # the table schema (each column's name + type)
    rows.json       # the (possibly filtered) rows
```

The slug is the kebab of the table name with its id appended (names aren't
guaranteed unique). `meta.json` records what produced `rows.json`, so a filtered
slice is self-describing and never mistaken for the whole table.

## Pull a filtered slice

A table's rows can be large, so the verb pulls a **slice** by pushing the filter
down to the server rather than downloading everything:

| Flag | Meaning |
| --- | --- |
| `--filter '<json>'` | Server-side condition filter — a JSON string passed 1:1 to the API (see shape below) |
| `--search <text>` | Free-text search across string columns |
| `--sort <col:asc\|desc>` | Sort by a column, ascending or descending |
| `--limit N` | Rows per page (default 100, API cap 250; `--limit N` or `--limit=N`) |
| `--all` | Follow the cursor to exhaust the (usually filtered) result, not just one page |

The `--filter` value is n8n's own condition object as a JSON string:

```json
{ "type": "and", "filters": [ { "columnName": "status", "condition": "eq", "value": "active" } ] }
```

`condition` is n8n's row operator (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`,
…); combine several under `"type": "and"` / `"or"`. For example, only the active
orders, newest first:

```sh
n8n-decanter data-tables "Orders" \
  --filter '{"type":"and","filters":[{"columnName":"status","condition":"eq","value":"active"}]}' \
  --sort createdAt:desc
```

The applied filter, search, sort, and limit are written into that table's
`meta.json` alongside the resulting `rowCount`.

## Never commit table data

Each `data-tables/` dir is written **self-ignored** (it contains a `.gitignore`
of just `*`) because table rows can hold PII — they must never reach git.
`init`'s scaffolded root `.gitignore` also lists `data-tables/`.

## `data-tables clean`

Offline. Deletes the whole local `data-tables/` dir. Run it when you're done.

## Config gate

The fetch is gated by the `dataTables` key in
[`decanter.config.json`](/docs/concepts/configuration/) (default `true`). Set it
to `false` to disable the fetch entirely — the verb then refuses with a clear
message, and the recommended API key needn't carry the data-table read scopes.
`data-tables clean` stays available regardless.

## Scopes

While `dataTables` is on, the [recommended scoped key](/docs/concepts/configuration/)
needs the read scopes `dataTable:list`, `dataTable:read`, `dataTableColumn:read`,
and `dataTableRow:read` (a full-access key also works). Data-table endpoints need
n8n **≥ 2.x** — on an older instance the fetch reports that it isn't available.
