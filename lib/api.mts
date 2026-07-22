import type { DataTable, DataTableColumn, DataTableRow, Execution } from "./types.mts";

/**
 * n8n public REST API client — since Plan 33 only the surfaces MCP cannot
 * serve: executions (no MCP read of full run data) and data-table rows (MCP
 * is add-only). The workflow code path and lifecycle (pull/push/watch/status/
 * publish/create/archive) live in lib/mcp.mts.
 */
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
   * Recent executions with full run data, newest first. Read-only by design —
   * the executions API is never written through. `limit` caps the single page
   * (the API allows up to 250); no pagination on purpose, "recent" is the use
   * case.
   */
  async listExecutions({ workflowId, status, limit = 5 }: { workflowId?: string; status?: string; limit?: number }): Promise<Execution[]> {
    const query = new URLSearchParams({
      includeData: "true",
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
