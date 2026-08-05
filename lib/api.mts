import type { DataTable, DataTableColumn, DataTableRow, Execution, Workflow } from "./types.mts";

/**
 * n8n public REST API client — since Plan 33 only the surfaces MCP cannot
 * serve: executions (no MCP read of full run data), data-table rows (MCP is
 * add-only), and full-fidelity workflow GET/POST for `backup` (Plan 51 Part B —
 * MCP's read strips credentials/pinData/staticData/description, so it can't
 * export a redeployable copy). The daily code path and lifecycle (pull/push/
 * watch/status/publish) stay on MCP (lib/mcp.mts).
 */
/**
 * Which n8n API scope a refused request needed (Plan 63 task 6).
 *
 * A 403 says "valid key, missing scope" and n8n names no scope — so the caller
 * is left guessing which of eight to add. The scope names are already pinned in
 * `template/.env.example` and the smoke suite, and Plan 25 verified the trap
 * this exists for: column and row reads have **distinct** scopes that do not
 * fold into `dataTable:read`, so a key that lists tables fine still 403s on
 * `/columns`.
 */
function scopeHint(method: string, pathname: string): string {
  const readOnly = " decanter only ever READS data tables — no write scope is needed.";
  if (pathname.includes("/data-tables/") && pathname.includes("/columns")) return `Add \`dataTableColumn:read\` (listing tables uses \`dataTable:list\`, which does NOT cover columns).${readOnly}`;
  if (pathname.includes("/data-tables/") && pathname.includes("/rows")) return `Add \`dataTableRow:read\` (separate from \`dataTable:read\`).${readOnly}`;
  if (pathname.startsWith("/api/v1/data-tables")) return `Add \`dataTable:list\` and \`dataTable:read\`.${readOnly}`;
  if (/^\/api\/v1\/executions\/\d/.test(pathname)) return "Add `execution:read`.";
  if (pathname.startsWith("/api/v1/executions")) return "Add `execution:list` (and `execution:read` to fetch one).";
  if (pathname.startsWith("/api/v1/workflows") && method === "POST") return "Add `workflow:create` (`backup restore` redeploys a backup as a new workflow).";
  if (pathname.startsWith("/api/v1/workflows")) return "Add `workflow:read` (and `workflow:list` for init's connection check).";
  return "Check the key's scopes in n8n → Settings → n8n API.";
}

export class N8nApi {
  #host: string;
  #apiKey: string;
  #timeoutMs: number;

  constructor({ host, apiKey, requestTimeoutMs = 30_000 }: { host: string; apiKey: string; requestTimeoutMs?: number }) {
    this.#host = host;
    this.#apiKey = apiKey;
    this.#timeoutMs = requestTimeoutMs;
  }

  /**
   * Recent executions, newest first. Read-only by design — the executions API is
   * never written through. `limit` caps the single page (the API allows up to
   * 250); no pagination on purpose, "recent" is the use case. `includeData`
   * defaults to `true` (full run data, what `capture`/pinning needs); pass
   * `false` for a lightweight metadata-only health probe (status/timing only —
   * `preflight`'s `history` check, which must not download every run's payload).
   */
  async listExecutions({ workflowId, status, limit = 5, includeData = true }: { workflowId?: string; status?: string; limit?: number; includeData?: boolean }): Promise<Execution[]> {
    const query = new URLSearchParams({
      includeData: includeData ? "true" : "false",
      limit: String(limit),
      ...(workflowId !== undefined && { workflowId }),
      ...(status !== undefined && { status }),
    });
    const page = (await this.#request("GET", `/api/v1/executions?${query}`)) as { data: Execution[] };
    return page.data;
  }

  async getExecution(id: string): Promise<Execution> {
    return this.#request("GET", `/api/v1/executions/${encodeURIComponent(id)}?includeData=true`) as Promise<Execution>;
  }

  /**
   * One workflow at full REST fidelity (`GET /workflows/:id`) — the recovery
   * read `backup` needs (Plan 51 Part B). Unlike MCP's sanitized
   * `get_workflow_details`, REST returns node credential refs, `pinData`,
   * `staticData`, and `description`, and reads the **draft tip**. Byte-exact
   * `jsCode`; node ids match the MCP read (spike-verified).
   */
  async getWorkflow(id: string): Promise<Workflow> {
    return this.#request("GET", `/api/v1/workflows/${encodeURIComponent(id)}`) as Promise<Workflow>;
  }

  /**
   * Create a workflow from a full-fidelity body (`POST /workflows`) — the
   * redeploy write for `backup restore` (Plan 51 Part B). Lands a **new,
   * unpublished** workflow (new workflow id) while **preserving node ids** and
   * credential refs carried in `nodes` (spike-verified GET→POST round-trip).
   * Publishing is the operator's next step.
   */
  async createWorkflow(workflow: unknown): Promise<Workflow> {
    return this.#request("POST", "/api/v1/workflows", workflow) as Promise<Workflow>;
  }

  /**
   * All data tables (n8n ≥ 2.x built-in project tables), cursor-paginated like
   * `listWorkflows`. Read-only by design — the data-table API is never written
   * through (see lib/datatables.mts). On pre-2.x instances the endpoint 404s;
   * the caller surfaces that as a friendly hint.
   */
  async listDataTables(): Promise<DataTable[]> {
    const all: DataTable[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", ...(cursor !== undefined && { cursor }) });
      const page = (await this.#request("GET", `/api/v1/data-tables?${query}`)) as { data: DataTable[]; nextCursor?: string | null };
      all.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return all;
  }

  /**
   * A data table's columns (its schema). Tolerates both a bare array and a
   * `{ data: [...] }` envelope so a shape difference between n8n versions
   * doesn't break the fetch. Read-only.
   */
  async getDataTableColumns(id: string): Promise<DataTableColumn[]> {
    const res = (await this.#request("GET", `/api/v1/data-tables/${encodeURIComponent(id)}/columns`)) as DataTableColumn[] | { data: DataTableColumn[] };
    return Array.isArray(res) ? res : res.data;
  }

  /**
   * One page of a data table's rows. The server-side `filter` (a JSON string of
   * conditions), `search` (free text over string columns), and `sortBy`
   * (`col:asc|desc`) narrow the result so callers pull only the rows they need
   * from a potentially huge table; `limit` (default 100, API cap 250) + `cursor`
   * paginate. Returns the page plus `nextCursor`. Read-only.
   */
  async getDataTableRows(
    id: string,
    { limit = 100, cursor, filter, search, sortBy }: { limit?: number; cursor?: string; filter?: string; search?: string; sortBy?: string } = {},
  ): Promise<{ data: DataTableRow[]; nextCursor?: string | null }> {
    const query = new URLSearchParams({
      limit: String(limit),
      ...(cursor !== undefined && { cursor }),
      ...(filter !== undefined && { filter }),
      ...(search !== undefined && { search }),
      ...(sortBy !== undefined && { sortBy }),
    });
    return (await this.#request("GET", `/api/v1/data-tables/${encodeURIComponent(id)}/rows?${query}`)) as { data: DataTableRow[]; nextCursor?: string | null };
  }

  async #request(method: string, pathname: string, body?: unknown): Promise<unknown> {
    try {
      // The signal also covers body consumption, so a stalled response
      // stream can't hang the CLI either.
      const res = await fetch(this.#host + pathname, {
        method,
        headers: {
          "X-N8N-API-KEY": this.#apiKey,
          accept: "application/json",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        // A 403 from the public API means the key is valid but under-scoped —
        // and n8n does not say which scope is missing. Mapped HERE rather than
        // in each caller so every REST surface (executions, data-tables, backup)
        // gets it: `pathname` already identifies what was refused.
        if (res.status === 403) {
          throw new Error(`${method} ${pathname} was refused (403) — N8N_API_KEY is valid but lacks a scope. ${scopeHint(method, pathname)}`);
        }
        throw new Error(`${method} ${pathname} failed: ${res.status} ${res.statusText}\n${text.slice(0, 2000)}`);
      }
      return text ? JSON.parse(text) : undefined;
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`${method} ${pathname} timed out after ${this.#timeoutMs / 1000}s — n8n did not respond (raise "requestTimeoutMs" in decanter.config.json for a slow instance)`);
      }
      throw err;
    }
  }
}
