// Unit tests for the public-API 403 → scope hint mapping (lib/api.mts),
// Plan 63 task 6.
//
// n8n answers a valid-but-under-scoped key with a bare 403 and names no scope,
// so the user is left guessing which of eight to add. The trap Plan 25 verified
// live is the reason this is per-endpoint rather than one generic line: column
// and row reads have DISTINCT scopes that do not fold into `dataTable:read`, so
// a key that lists tables fine still 403s on `/columns`.
//
// Driven through the real `N8nApi` against a node:http server that 403s
// everything — no n8n, no Docker.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { N8nApi } from "../../lib/api.mts";

let server: http.Server;
let api: N8nApi;

before(async () => {
  server = http.createServer((_req, res) => void res.writeHead(403).end("forbidden"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  api = new N8nApi({ host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "k" });
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** The rejected promise's message, so each case reads as one assertion. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "(no error thrown)";
  } catch (err) {
    return (err as Error).message;
  }
}

describe("public API 403 → which scope is missing (Plan 63 task 6)", () => {
  it("every 403 says the key is valid but under-scoped", async () => {
    const msg = await refusal(api.listExecutions({ limit: 1 }));
    assert.match(msg, /refused \(403\)/);
    assert.match(msg, /N8N_API_KEY is valid but lacks a scope/);
  });

  it("distinguishes the three data-table scopes — the trap a single hint would miss", async () => {
    assert.match(await refusal(api.listDataTables()), /dataTable:list/);
    // /columns and /rows are NOT covered by dataTable:read (Plan 25, live-verified)
    const columns = await refusal(api.getDataTableColumns("t1"));
    assert.match(columns, /dataTableColumn:read/);
    assert.match(columns, /does NOT cover columns/);
    assert.match(await refusal(api.getDataTableRows("t1", {})), /dataTableRow:read/);
  });

  it("tells data-table users no write scope is needed", async () => {
    assert.match(await refusal(api.listDataTables()), /only ever READS/);
  });

  it("separates listing executions from fetching one", async () => {
    assert.match(await refusal(api.listExecutions({ limit: 1 })), /execution:list/);
    assert.match(await refusal(api.getExecution("42")), /execution:read/);
  });

  it("names workflow:create for the restore path, workflow:read for a plain read", async () => {
    assert.match(await refusal(api.createWorkflow({ name: "x", nodes: [], connections: {} } as never)), /workflow:create/);
    assert.match(await refusal(api.getWorkflow("wf1")), /workflow:read/);
  });
});
