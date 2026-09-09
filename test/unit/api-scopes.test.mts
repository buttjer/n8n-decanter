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

// Plan 92: `N8N_DECANTER_AUTH=upstream` — a proxy in front of n8n attaches the
// API key. Measured 2026-09-09 against a live agentgateway: a client-sent key
// header is APPENDED to the one the proxy adds, and n8n 401s the pair. So the
// header must be ABSENT, which is a different thing from empty — and the
// difference is invisible to any assertion that only checks the value.
describe("upstream auth mode (Plan 92)", () => {
  let echo: http.Server;
  let headers: http.IncomingHttpHeaders = {};
  let status = 200;
  let base: string;

  before(async () => {
    echo = http.createServer((req, res) => {
      headers = req.headers;
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  });
  after(async () => { await new Promise<void>((r) => echo.close(() => r())); });

  it("sends NO key header at all — not an empty one", async () => {
    status = 200;
    await new N8nApi({ host: base, apiKey: "", authMode: "upstream" }).getWorkflow("wf1");
    assert.ok(!Object.keys(headers).includes("x-n8n-api-key"), "the header must be absent, not blank");
  });

  it("still sends it in credentials mode, so the default is untouched", async () => {
    status = 200;
    await new N8nApi({ host: base, apiKey: "sentinel" }).getWorkflow("wf1");
    assert.equal(headers["x-n8n-api-key"], "sentinel");
  });

  it("401 names the proxy rather than a key the user does not have", async () => {
    status = 401;
    const msg = await refusal(new N8nApi({ host: base, apiKey: "", authMode: "upstream" }).getWorkflow("wf1"));
    assert.match(msg, /rejected \(401\)/);
    assert.match(msg, /sent no API key by design/);
    assert.match(msg, /N8N_DECANTER_AUTH=upstream/);
    assert.doesNotMatch(msg, /Settings → n8n API/, "sending them to mint a key would be the wrong fix");
  });

  // Before Plan 92 a 401 fell through to the bare status line — the least
  // helpful landing spot, and the one upstream mode makes most likely.
  it("401 in credentials mode points at the key variable", async () => {
    status = 401;
    const msg = await refusal(new N8nApi({ host: base, apiKey: "bad" }).getWorkflow("wf1"));
    assert.match(msg, /rejected \(401\)/);
    assert.match(msg, /is not valid for/);
  });

  it("403 points at the proxy's key, not at the user's .env", async () => {
    status = 403;
    const msg = await refusal(new N8nApi({ host: base, apiKey: "", authMode: "upstream" }).getWorkflow("wf1"));
    assert.match(msg, /workflow:read/, "the scope name is still the useful half");
    assert.match(msg, /belongs to the upstream auth proxy/);
  });
});
