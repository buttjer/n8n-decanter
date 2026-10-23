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

A `<table>` is a table's **id, its name in any case, its kebab form, or its
folder name**. A table `cardmuseum marketplace sync queue` with id `3` is
matched by `3`, `cardmuseum marketplace sync queue`, `Cardmuseum Marketplace
Sync Queue`, `cardmuseum-marketplace-sync-queue`, or
`cardmuseum-marketplace-sync-queue-3` — an exact name or id match always wins
over the kebab form, so two similarly-named tables don't collide. With no
argument, every table is fetched.

Uses the n8n **public API key** (`N8N_API_KEY`) — MCP's data-table tools
are add-only with no row reads, so this verb keeps the REST path. Without a
key it fails with guidance.

## Where the data lands

Data tables are **project-scoped — not owned by a workflow** — so, unlike
[executions](/docs/cli/executions/) (which nest under each workflow folder), they
land in a **single top-level `data-tables/` dir** next to
`decanter.config.json`:

```txt
data-tables/
  <table-slug>/
    meta.json         # id, name, projectId, fetchedAt, rowCount + the applied filter/search/sort/limit
    columns.json      # the table schema (each column's name + type)
    rows.json         # the (possibly filtered) rows
    rows.stale.json   # present only after a failed refetch — see below
```

The slug is the kebab of the table name with its id appended (names aren't
guaranteed unique). `meta.json` records what produced `rows.json`, so a filtered
slice is self-describing and never mistaken for the whole table. Its
`fetchedAt` is the field to check for freshness — it dates whatever rows the
dir currently holds, fresh or stale.

## When a fetch fails

If a table's columns or rows fail to fetch — a dropped connection, a 403 from
a key missing a scope — its existing `rows.json` is **renamed** to
`rows.stale.json` rather than deleted or left in place. `meta.json` and
`columns.json` are untouched, so `meta.json`'s `fetchedAt` still dates the
stale rows honestly. A table dir with a `rows.stale.json` and no `rows.json`
means its last refetch failed; the next successful fetch restores `rows.json`
and removes `rows.stale.json`.

Renaming rather than deleting means a transient failure never costs you a
large table's previously-fetched rows. Renaming rather than leaving a
separate "stale" marker next to an untouched `rows.json` means anyone opening
`rows.json` directly sees "file not found" instead of silently reading
yesterday's data as if it were current.

The command fails with exit code 1 and reports, by name, which tables it
refreshed and which it didn't — including any table it renamed `rows.json` to
`rows.stale.json` for.

After a successful run, if the `data-tables/` dir holds other local table
folders the run wasn't asked to fetch, it prints one line naming each of
them and its `fetchedAt` (or `stale`, or `no meta.json`), so you can see at a
glance which tables are from an earlier run.

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
