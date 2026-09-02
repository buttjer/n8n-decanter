# Plan 88 — a failed `data-tables` fetch leaves yesterday's rows, and the name on disk is not an accepted ref

**Status:** Not started
**Priority:** P2 — the ref fix is a one-line comparison; the staleness fix needs
a small decision (stamp vs. remove) but no design change.
**Source:** user field feedback 2026-09-02, report 1 ("Kleinigkeiten"), verified
against the code the same day. Twenty minutes of the reporter's debugging went
into an evaluation run that silently read the previous fetch. Same batch as
[Plan 86](../done/86-init-writes-when-asked-for-help.md),
[Plan 87](87-auth-errors-point-the-wrong-way.md),
[Plan 89](89-rest-verbs-prerequisite-chain.md),
[Plan 90](90-backup-source-instance-stamp.md) and
[Plan 91](../draft/91-guard-hint-for-credential-type-refusal.md).
**Snapshot:** 2026-09-02T04:57Z @ 3c5ee4d
**Model:** Haiku — mechanical, two small edits in one file, plus tests.

`data-tables <name>` matches a table by id or **exact** name, but the folder it
writes is the **kebab** of that name — so the one string decanter shows the user
is a string it will not accept. And when the ref misses, it throws before
writing anything, leaving the previous run's `rows.json` in place: the next
analysis run reads it as if it were current.

## Why

The two halves are one story. The ref mismatch is what makes the command fail,
and the stale file is what makes the failure expensive. Fix only the ref and the
staleness lies in wait for the next failure mode (a 403, a dropped connection, a
table deleted server-side). Fix only the staleness and users keep hitting the
mismatch.

This is the base rule "a signal that is off must be readable as off": a
`rows.json` from a failed run is byte-indistinguishable from a fresh one to
anything that opens it directly.

**One mitigation already exists and neither user found it:** `meta.json` carries
`fetchedAt` (`lib/datatables.mts:124`). The staleness *is* recorded — just not
anywhere the consumer of `rows.json` looks. That narrows the fix: the
information exists, it needs to reach the reader.

## Findings, as verified

1. **Matching is id or exact lowercased name only.** `selectTables`
   (`lib/datatables.mts:43`):
   `tables.filter((t) => String(t.id) === ref || t.name.toLowerCase() === lc)`.
2. **The folder is kebab plus id.** `dataTableSlug` (`lib/datatables.mts:19`):
   `` `${kebabCase(name)}-${safeId}` ``. So a table named
   `cardmuseum marketplace sync queue` lands in
   `data-tables/cardmuseum-marketplace-sync-queue-<id>/`, and typing that folder
   name back is a miss.
3. **The error is otherwise good and should be kept.**
   `lib/datatables.mts:47` lists every known table with its id — the report
   explicitly credited that. This plan makes the *match* smarter; it does not
   make the error less informative.
4. **Nothing is cleaned up on failure.** `selectTables` throws before the write
   loop (`lib/datatables.mts:100-138`), so no file is touched. The previous
   run's `meta.json` / `columns.json` / `rows.json` survive intact.
5. **A partial multi-table run has the same shape.** The loop writes per table;
   a throw on table 3 of 5 leaves two directories fresh and three stale, with
   nothing at the top level saying which is which.
6. The directory is gitignored (`writeFileSync(path.join(outRoot, ".gitignore"),
   "*\n")`, `lib/datatables.mts:97`), so git will not surface the staleness
   either.

## Tasks

1. **Accept the name the user can see.** In `selectTables`
   (`lib/datatables.mts:38-52`), match on `kebabCase(ref) === kebabCase(t.name)`
   in addition to the existing id and exact-name tests. `kebabCase` is already
   imported (`lib/datatables.mts:5`). This makes the folder name, the display
   name, and any spacing/casing variant all work.
2. **Consider accepting the full folder slug** (`<kebab>-<id>`) too, since that
   is what a user copies out of a file path. Cheap: strip a trailing `-<id>`
   that matches a known table before comparing.
3. **Make a stale `rows.json` readable as stale.** Pick one and say why in the
   code comment:
   - **Stamp** — write a sibling marker (or rename to `rows.stale.json`) for
     every selected-but-not-fetched table when the run fails. Preserves the data
     for anyone who wants it.
   - **Remove** — delete the table's directory contents up front, so a failed
     run leaves nothing to misread. Simpler, but destroys data on a transient
     network blip.
   Preference: **stamp**, because the failure modes here are mostly transient
   and deleting a large fetched table over a dropped connection is its own bad
   afternoon.
4. **Report the partial case explicitly.** When the loop throws part-way, the
   summary must name which tables were refreshed and which were left — a count
   is not enough; the reader needs the names to know whether their table is one
   of them.
5. **Surface `fetchedAt` at read time.** The log line at
   `lib/datatables.mts:137` already reports what was written. The gap is on the
   consuming side: nothing warns when a `rows.json` being relied on is hours or
   days old. Cheapest useful version — on a *successful* run, note any sibling
   table directory in `data-tables/` whose `meta.json` `fetchedAt` is much older
   than this run's. Scope this last; it is the only task here with design
   latitude, and tasks 1-4 are worth landing without it.

## Acceptance / verification

- `data-tables cardmuseum-marketplace-sync-queue` matches a table named
  `cardmuseum marketplace sync queue`, and so do the spaced and mixed-case
  forms.
- A genuinely unknown ref still errors with the full table list — that message
  is a feature, assert on it.
- Fetch a table successfully, then fetch again with the mock returning an error:
  the resulting on-disk state is unambiguous by task 3's chosen rule, and the
  test asserts on the **file layout**, not on stdout.
- Two-table fetch where the second fails: the output names both tables and their
  states.
- Drive the real CLI against the mock's `GET /api/v1/...` routes per the root
  `AGENTS.md` recipe.

## Notes

- **CHANGELOG:** `Fixed` — "`data-tables` accepts the folder/kebab form of a
  table name, not just its exact display name"; `Fixed` — "a failed
  `data-tables` fetch no longer leaves the previous run's `rows.json` looking
  current".
- **Docs:** [docs/cli](../../docs/cli) `data-tables` page — document what a
  failed fetch leaves behind, since that is now a defined behaviour rather than
  an accident. Mention `meta.json`'s `fetchedAt` as the freshness field; it is
  currently undocumented as far as the reader is concerned.
- **PLAN.md:** `data-tables/` layout is described there — task 3's marker file
  changes that layout.
- Related but out of scope: [Plan 71](../draft/71-data-table-writes.md)
  (data-table writes). This plan stays read-only.
