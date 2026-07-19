import type { Workflow, WorkflowPut } from "./types.mts";

export class N8nApi {
  #host: string;
  #apiKey: string;
  #timeoutMs: number;

  constructor({ host, apiKey, requestTimeoutMs = 30_000 }: { host: string; apiKey: string; requestTimeoutMs?: number }) {
    this.#host = host;
    this.#apiKey = apiKey;
    this.#timeoutMs = requestTimeoutMs;
  }

  async getWorkflow(id: string): Promise<Workflow> {
    return this.#request("GET", `/api/v1/workflows/${encodeURIComponent(id)}`) as Promise<Workflow>;
  }

  /**
   * All workflows, cursor-paginated. Name matching stays client-side — the
   * server-side `name` filter is exact-match only, which defeats prefix
   * resolution.
   */
  async listWorkflows(): Promise<Workflow[]> {
    const all: Workflow[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", ...(cursor !== undefined && { cursor }) });
      const page = (await this.#request("GET", `/api/v1/workflows?${query}`)) as { data: Workflow[]; nextCursor?: string | null };
      all.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return all;
  }

  async updateWorkflow(id: string, body: WorkflowPut): Promise<Workflow | undefined> {
    return this.#request("PUT", `/api/v1/workflows/${encodeURIComponent(id)}`, body) as Promise<Workflow | undefined>;
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
