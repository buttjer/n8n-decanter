import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  /** Ids or exact names to scope the fetch to; empty = every table. */
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

/** Pick the tables named by `tableRefs` (id or exact name); empty = all. */
function selectTables(tables: DataTable[], tableRefs: string[]): DataTable[] {
  if (tableRefs.length === 0) return tables;
  const picked = new Map<string, DataTable>();
  for (const ref of tableRefs) {
    const lc = ref.toLowerCase();
    const hits = tables.filter((t) => String(t.id) === ref || t.name.toLowerCase() === lc);
    if (hits.length === 0) {
      const known = tables.map((t) => `"${t.name}" (${t.id})`).join(", ");
      throw new Error(`no data table matches "${ref}"${known ? ` — tables: ${known}` : " — no data tables on the server"}`);
    }
    for (const t of hits) picked.set(String(t.id), t);
  }
  return [...picked.values()];
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
  let tables: DataTable[];
  try {
    tables = await api.listDataTables();
  } catch (err) {
    const msg = (err as Error).message;
    if (/\b404\b/.test(msg)) {
      throw new Error(`the n8n data-tables API is not available (404) — data tables need n8n ≥ 2.x; a full-access key still works if your instance predates them\n${msg}`);
    }
    throw err;
  }
  const selected = selectTables(tables, opts.tableRefs ?? []);
  if (selected.length === 0) {
    log.info("no data tables on the server");
    return;
  }

  const outRoot = path.join(configDir, DATA_TABLES_DIR);
  mkdirSync(outRoot, { recursive: true });
  // Self-ignoring dir: data tables can hold PII — same reasoning as executions/.
  writeFileSync(path.join(outRoot, ".gitignore"), "*\n");
  const rel = (p: string) => path.relative(process.cwd(), p);
  const filterDesc = filterSummary(opts);

  for (const table of selected) {
    const dir = path.join(outRoot, dataTableSlug(table.id, table.name));
    mkdirSync(dir, { recursive: true });

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
    log.info(`wrote ${rel(dir)}/{meta,columns,rows}.json (${columns.length} column${columns.length === 1 ? "" : "s"}, ${rows.length} row${rows.length === 1 ? "" : "s"})`);
  }

  log.ok(`${selected.length} data table${selected.length === 1 ? "" : "s"}${filterDesc} -> ${rel(outRoot)} (gitignored — temp data, "data-tables clean" removes it)`);
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
