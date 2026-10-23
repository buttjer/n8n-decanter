import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import type { DataTable, DataTableColumn, DataTableRow, Log } from "./types.mts";
import { kebabCase } from "./util.mts";

/** Top-level dir (next to decanter.config.json) holding fetched data tables. */
export const DATA_TABLES_DIR = "data-tables";
/** Default rows fetched per page — the API caps a page at 250. */
export const DEFAULT_ROW_LIMIT = 100;

/**
 * Folder slug for a fetched table: the kebab of its name with the id appended
 * (data-table names aren't guaranteed unique, so the id disambiguates). The id
 * is stripped of anything non-alphanumeric to stay filesystem-safe.
 */
export function dataTableSlug(id: string | number, name: string): string {
  const safeId = String(id).replace(/[^A-Za-z0-9]+/g, "") || "id";
  return `${kebabCase(name)}-${safeId}`;
}

/** Options for a data-table fetch — the CLI's filter/slice flags. */
export interface FetchDataTablesOptions {
  /** Ids, names (any case) or folder names to scope the fetch to; empty = every table. */
  tableRefs?: string[];
  /** Rows per page (default 100, API cap 250). */
  limit?: number;
  /** Server-side `filter` — a JSON string of conditions, passed through 1:1. */
  filter?: string;
  /** Server-side `search` — free text across string columns. */
  search?: string;
  /** Server-side `sortBy` — `columnName:asc|desc`. */
  sortBy?: string;
  /** Follow `cursor` to exhaust the (usually filtered) result, not one page. */
  all?: boolean;
}

/**
 * Resolve one ref against candidates, in two tiers: precise (id, name or
 * folder, each compared case-insensitively) first, and only when that hits
 * nothing a loose kebab match on the name. Tiers are per ref, so one ref's
 * loose hit never pulls in another ref's precise twin — `sync-queue` stays the
 * table literally named that, not also `Sync Queue`. `kebabCase(ref)` covers
 * the spaced, underscored and mixed-case forms; names kebab alike are all
 * selected (names are not unique).
 */
function resolveRef<T extends { id: string; name: string; folder: string }>(ref: string, candidates: T[]): T[] {
  const lc = ref.toLowerCase();
  const precise = candidates.filter(
    (c) => c.id === ref || c.name.toLowerCase() === lc || c.folder.toLowerCase() === lc,
  );
  if (precise.length > 0) return precise;
  return candidates.filter((c) => kebabCase(c.name) === kebabCase(ref));
}

/** Server tables as ref-match candidates; the folder is what `pull` would name the dir. */
function serverCandidates(tables: DataTable[]): { id: string; name: string; folder: string }[] {
  return tables.map((t) => ({ id: String(t.id), name: t.name, folder: dataTableSlug(t.id, t.name) }));
}

/**
 * Resolve every ref against the server's tables (id, name in any case, or
 * folder), without throwing — a ref that hits nothing is reported in
 * `missedRefs` rather than aborting here, because `fetchDataTables` still
 * needs to know which *other* refs' tables to stale before it throws the
 * miss error (nothing is fetched at all once any ref misses).
 */
function selectTables(
  tables: DataTable[],
  tableRefs: string[],
): { selected: DataTable[]; missedRefs: string[] } {
  if (tableRefs.length === 0) return { selected: tables, missedRefs: [] };
  const candidates = serverCandidates(tables);
  const picked = new Map<string, DataTable>();
  const missedRefs: string[] = [];
  for (const ref of tableRefs) {
    const hits = resolveRef(ref, candidates).map((c) => tables.find((t) => String(t.id) === c.id)!);
    if (hits.length === 0) {
      missedRefs.push(ref);
      continue;
    }
    for (const t of hits) picked.set(String(t.id), t);
  }
  return { selected: [...picked.values()], missedRefs };
}

/** The miss error text (unchanged), naming every server table known. */
function missError(ref: string, tables: DataTable[]): Error {
  const known = tables.map((t) => `"${t.name}" (${t.id})`).join(", ");
  return new Error(`no data table matches "${ref}"${known ? ` — tables: ${known}` : " — no data tables on the server"}`);
}

/** One table dir directly under `data-tables/`, matchable against a ref the same way a server table is (`resolveRef` above). */
interface LocalCandidate {
  id: string;
  name: string;
  folder: string;
  dir: string;
  /** Whether `meta.json` was present and readable — else known by folder only. */
  hasMeta: boolean;
}

/** Local table dirs under `data-tables/`, read from their `meta.json` where possible. */
function localCandidates(outRoot: string): LocalCandidate[] {
  if (!existsSync(outRoot)) return [];
  const out: LocalCandidate[] = [];
  for (const entry of readdirSync(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(outRoot, entry.name);
    const metaPath = path.join(dir, "meta.json");
    let id = entry.name;
    let name = entry.name;
    let hasMeta = false;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        if (meta && typeof meta.name === "string") {
          id = String(meta.id);
          name = meta.name;
          hasMeta = true;
        }
      } catch {
        // unreadable meta.json: the dir is a candidate by its folder name only.
      }
    }
    out.push({ id, name, folder: entry.name, dir, hasMeta });
  }
  return out;
}

/** Human label for a report line: `"<name>" (<id>)`, or just the folder when meta.json is gone. */
const labelFor = (t: { name: string; id: string | number } | undefined, fallbackFolder: string): string =>
  t ? `"${t.name}" (${t.id})` : fallbackFolder;

/**
 * Rename a dir's `rows.json` to `rows.stale.json` (replacing a leftover one),
 * leaving `meta.json`/`columns.json` untouched so `fetchedAt` still dates the
 * stale rows. Renamed rather than deleted: these failures are mostly
 * transient, and deleting a large fetched table over one is its own bad
 * afternoon; renamed rather than left with a sibling marker, so opening
 * `rows.json` directly after a failure gets "file not found" instead of
 * yesterday's rows looking current. A dir with no `rows.json` (never fetched,
 * or already stale) is left exactly as it was, and never created new.
 */
function staleDir(dir: string): boolean {
  const rowsPath = path.join(dir, "rows.json");
  if (!existsSync(rowsPath)) return false;
  renameSync(rowsPath, path.join(dir, "rows.stale.json"));
  return true;
}

/** One table this run was meant to refresh and (on this path) did not. */
interface NotRefreshedTarget {
  label: string;
  dir: string;
}

/** Prints the stale-rows report (refreshed/not-refreshed/moved), skipping empty lines. */
function printFailureReport(log: Log, refreshedLabels: string[], targets: NotRefreshedTarget[]): void {
  if (refreshedLabels.length > 0) log.info(`refreshed: ${refreshedLabels.join(", ")}`);
  const notRefreshedLabels = targets.map((t) => t.label);
  if (notRefreshedLabels.length > 0) log.info(`not refreshed: ${notRefreshedLabels.join(", ")}`);
  const moved = targets.filter((t) => staleDir(t.dir)).map((t) => path.basename(t.dir));
  if (moved.length > 0) log.warn(`moved rows.json to rows.stale.json in: ${moved.join(", ")}`);
}

/**
 * Name every local dir this run did not write — called both after a normal
 * run and when a successful (possibly unscoped) fetch selects zero server
 * tables, since local dirs from an earlier run can still sit under
 * `outRoot` either way. No age threshold: every such dir is older than this
 * run by definition, and nothing has measured where "much older" begins —
 * the reader judges from the timestamps.
 */
function reportUntouched(outRoot: string, writtenFolders: Set<string>, log: Log): void {
  const untouched = localCandidates(outRoot).filter((c) => !writtenFolders.has(c.folder));
  if (untouched.length === 0) return;
  // fetchedAt comes from each dir's own meta.json; the reader judges
  // freshness from those timestamps — no age threshold anywhere.
  const part = (c: LocalCandidate): string => {
    let fetchedAt: string | undefined;
    if (c.hasMeta && existsSync(path.join(c.dir, "meta.json"))) {
      try {
        const m = JSON.parse(readFileSync(path.join(c.dir, "meta.json"), "utf8")) as { fetchedAt?: unknown };
        if (typeof m.fetchedAt === "string") fetchedAt = m.fetchedAt;
      } catch {
        // unreadable meta.json — the line degrades to the no-meta label
      }
    }
    if (fetchedAt === undefined) return `${c.folder} (no meta.json)`;
    const stale = existsSync(path.join(c.dir, "rows.stale.json")) && !existsSync(path.join(c.dir, "rows.json"));
    return `${c.folder} (${stale ? "stale, " : ""}fetched ${fetchedAt})`;
  };
  log.info(`not refreshed by this run: ${untouched.map(part).join(", ")}`);
}

/** Human summary fragment naming the applied server-side filter, or "". */
function filterSummary(opts: FetchDataTablesOptions): string {
  const parts: string[] = [];
  if (opts.filter !== undefined) parts.push(`filter ${opts.filter}`);
  if (opts.search !== undefined) parts.push(`search "${opts.search}"`);
  if (opts.sortBy !== undefined) parts.push(`sort ${opts.sortBy}`);
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

/**
 * Fetch data-table schemas + (filtered) rows into a single top-level,
 * self-ignored `data-tables/` dir — mirrors `executions` (read-only, temp,
 * gitignored). Data tables are project-scoped (not owned by a workflow), so
 * they land next to `decanter.config.json`, not under a workflow folder. Each
 * table becomes `data-tables/<slug>/{meta,columns,rows}.json`; `meta.json`
 * records the applied filter/search/sort/limit and the row count so a filtered
 * `rows.json` is self-describing. The CLI never writes any data-table endpoint.
 */
export async function fetchDataTables(
  api: N8nApi,
  configDir: string,
  opts: FetchDataTablesOptions,
  log: Log,
): Promise<void> {
  const outRoot = path.join(configDir, DATA_TABLES_DIR);
  const refs = opts.tableRefs ?? [];
  const rel = (p: string) => path.relative(process.cwd(), p);

  let tables: DataTable[];
  try {
    tables = await api.listDataTables();
  } catch (err) {
    // The server's table list couldn't be read, so every local dir a ref
    // selects (or every local dir, unscoped) is what this run was meant
    // to refresh — none of it was, so all of it goes stale before we throw.
    const locals = localCandidates(outRoot);
    const targets = (refs.length === 0 ? locals : dedupeByDir(refs.flatMap((ref) => resolveRef(ref, locals))))
      .map((c): NotRefreshedTarget => ({ label: labelFor(c.hasMeta ? c : undefined, c.folder), dir: c.dir }));
    printFailureReport(log, [], targets);
    const msg = (err as Error).message;
    if (/\b404\b/.test(msg)) {
      throw new Error(`the n8n data-tables API is not available (404) — data tables need n8n ≥ 2.x; a full-access key still works if your instance predates them\n${msg}`);
    }
    throw err;
  }

  const { selected, missedRefs } = selectTables(tables, refs);
  if (missedRefs.length > 0) {
    // One or more refs missed, so nothing is fetched at all — the tables the
    // *other* refs selected, and the local dirs the missed refs select, all
    // go stale before the miss error is thrown.
    const locals = localCandidates(outRoot);
    const serverTargets = selected.map((t): NotRefreshedTarget => ({
      label: labelFor(t, ""),
      dir: path.join(outRoot, dataTableSlug(t.id, t.name)),
    }));
    const localTargets = dedupeByDir(missedRefs.flatMap((ref) => resolveRef(ref, locals))).map(
      (c): NotRefreshedTarget => ({ label: labelFor(c.hasMeta ? c : undefined, c.folder), dir: c.dir }),
    );
    printFailureReport(log, [], [...serverTargets, ...localTargets]);
    throw missError(missedRefs[0], tables);
  }

  if (selected.length === 0) {
    log.info("no data tables on the server");
    // This run (always unscoped here — a scoped run with no matches throws
    // via missedRefs above) wrote nothing, so every local dir under outRoot
    // is "not refreshed by this run".
    reportUntouched(outRoot, new Set(), log);
    return;
  }

  const filterDesc = filterSummary(opts);
  let rootReady = existsSync(outRoot);
  const refreshedLabels: string[] = [];

  for (let i = 0; i < selected.length; i++) {
    const table = selected[i];
    const dir = path.join(outRoot, dataTableSlug(table.id, table.name));
    try {
      const columns: DataTableColumn[] = await api.getDataTableColumns(String(table.id));

      const rows: DataTableRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.getDataTableRows(String(table.id), {
          limit: opts.limit ?? DEFAULT_ROW_LIMIT,
          cursor,
          filter: opts.filter,
          search: opts.search,
          sortBy: opts.sortBy,
        });
        rows.push(...page.data);
        cursor = opts.all ? (page.nextCursor ?? undefined) : undefined;
      } while (cursor !== undefined);

      // Nothing on disk changes until both fetches succeed — a failed run
      // must never create data-tables/ or a table's dir.
      if (!rootReady) {
        mkdirSync(outRoot, { recursive: true });
        rootReady = true;
      }
      // Self-ignoring dir: data tables can hold PII — same reasoning as
      // executions/. Rewritten on every successful fetch (not just when the
      // dir is first created) so a hand-deleted or pre-existing .gitignore
      // heals itself instead of staying wrong for the rest of this run and beyond.
      writeFileSync(path.join(outRoot, ".gitignore"), "*\n");
      mkdirSync(dir, { recursive: true });

      const meta = {
        id: table.id,
        name: table.name,
        projectId: table.projectId ?? null,
        fetchedAt: new Date().toISOString(),
        rowCount: rows.length,
        // A filtered rows.json is a slice, never the whole table — record what
        // produced it so it can't be mistaken for a full export.
        filter: opts.filter ?? null,
        search: opts.search ?? null,
        sortBy: opts.sortBy ?? null,
        limit: opts.limit ?? DEFAULT_ROW_LIMIT,
        all: Boolean(opts.all),
      };
      writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
      writeFileSync(path.join(dir, "columns.json"), JSON.stringify(columns, null, 2) + "\n");
      writeFileSync(path.join(dir, "rows.json"), JSON.stringify(rows, null, 2) + "\n");
      // A fresh refresh supersedes a leftover stale snapshot from an earlier failure.
      const stalePath = path.join(dir, "rows.stale.json");
      if (existsSync(stalePath)) rmSync(stalePath);
      refreshedLabels.push(labelFor(table, ""));
      log.info(`wrote ${rel(dir)}/{meta,columns,rows}.json (${columns.length} column${columns.length === 1 ? "" : "s"}, ${rows.length} row${rows.length === 1 ? "" : "s"})`);
    } catch (err) {
      // Table i failed — everything before it is already fresh on disk;
      // table i and everything after it (selection order) were meant to
      // refresh and did not, so they all go stale (no retry, no continuing).
      const notRefreshed = selected.slice(i).map((t): NotRefreshedTarget => ({
        label: labelFor(t, ""),
        dir: path.join(outRoot, dataTableSlug(t.id, t.name)),
      }));
      printFailureReport(log, refreshedLabels, notRefreshed);
      throw err;
    }
  }

  const writtenFolders = new Set(selected.map((t) => dataTableSlug(t.id, t.name)));
  reportUntouched(outRoot, writtenFolders, log);
  log.ok(`${selected.length} data table${selected.length === 1 ? "" : "s"}${filterDesc} -> ${rel(outRoot)} (gitignored — temp data, "data-tables clean" removes it)`);
}

/** Dedupe candidates picked by more than one ref, keeping the first. */
function dedupeByDir<T extends { dir: string }>(items: T[]): T[] {
  const byDir = new Map<string, T>();
  for (const item of items) if (!byDir.has(item.dir)) byDir.set(item.dir, item);
  return [...byDir.values()];
}

/** Offline delete of the local `data-tables/` dir (mirrors cleanExecutions). */
export function cleanDataTables(configDir: string, log: Log): void {
  const outRoot = path.join(configDir, DATA_TABLES_DIR);
  if (!existsSync(outRoot)) {
    log.info("no data-tables/ dir to clean");
    return;
  }
  rmSync(outRoot, { recursive: true, force: true });
  log.ok(`removed ${path.relative(process.cwd(), outRoot)}`);
}
