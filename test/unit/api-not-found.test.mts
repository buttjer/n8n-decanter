// Unit tests for the public-API 404 → per-endpoint hint mapping (lib/api.mts),
// Plan 89.
//
// A 404 used to fall through to the bare status line plus n8n's body. For a
// single execution or a single workflow that line hides the two causes a user
// can act on: the id is wrong (or pruned by n8n's execution retention), or the
// workflow is gone / invisible to the key's project. Every other 404 keeps the
// bare line — and the token `404` must survive everywhere, because
// lib/datatables.mts matches `\b404\b` to say "the data-tables API is not
// available".
//
// Driven through the real `N8nApi` against a node:http server that 404s
// everything — no n8n, no Docker.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { N8nApi } from "../../lib/api.mts";

/** Recognisable so a case can prove n8n's own body is still passed through. */
const BODY = '{"code":404,"message":"sentinel-n8n-body"}';

let server: http.Server;
let api: N8nApi;

before(async () => {
  server = http.createServer((_req, res) => void res.writeHead(404, { "content-type": "application/json" }).end(BODY));
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

// Loose by meaning, not by wording: the phrasing is the implementer's call.
// "Not Found" alone is NOT the hint — it is n8n's status text, present today.
const DOES_NOT_EXIST = /(does not|doesn't|no longer) exist/i;
const RETENTION = /retention|prun/i;
const WORKFLOW_CAUSES = /deleted/i;
const PROJECT_VISIBILITY = /project/i;

describe("public API 404 → what the missing thing means (Plan 89)", () => {
  it("getExecution: keeps the status line and body, adds the execution hint", async () => {
    const msg = await refusal(api.getExecution("999"));
    assert.ok(msg.includes("GET /api/v1/executions/999?includeData=true failed: 404 Not Found"), `today's status line stays — got:\n${msg}`);
    assert.ok(msg.includes("sentinel-n8n-body"), "n8n's own body still shows");
    assert.match(msg, DOES_NOT_EXIST, "says the execution does not exist on this instance");
    assert.match(msg, RETENTION, "names data-retention pruning as a cause");
  });

  it("getWorkflow: keeps the status line and body, adds the workflow hint", async () => {
    const msg = await refusal(api.getWorkflow("wfX"));
    assert.ok(msg.includes("GET /api/v1/workflows/wfX failed: 404 Not Found"), `today's status line stays — got:\n${msg}`);
    assert.ok(msg.includes("sentinel-n8n-body"), "n8n's own body still shows");
    assert.match(msg, DOES_NOT_EXIST, "says the workflow does not exist on this instance");
    assert.match(msg, WORKFLOW_CAUSES, "names deletion since the last pull");
    assert.match(msg, PROJECT_VISIBILITY, "names the key's project not seeing it");
    assert.doesNotMatch(msg, RETENTION, "the workflow hint is its own — one shared hint for both endpoints fails here");
  });

  // Regression guards: green today, must stay green. Only the two by-id
  // reads get a hint; a hint keyed on a path PREFIX would leak onto the list,
  // the create (backup restore) and the data-table routes. The data-tables
  // mapping keys on the 404 token, so it must survive everywhere.
  const bare: Array<[string, () => Promise<unknown>]> = [
    ["listDataTables", () => api.listDataTables()],
    ["getDataTableColumns", () => api.getDataTableColumns("t1")],
    ["listExecutions", () => api.listExecutions({ limit: 1 })],
    ["createWorkflow", () => api.createWorkflow({ name: "x", nodes: [], connections: {} } as never)],
  ];
  for (const [name, call] of bare) {
    it(`${name}: still says 404, carries neither hint`, async () => {
      const msg = await refusal(call());
      assert.match(msg, /\b404\b/, "lib/datatables.mts matches this token");
      assert.ok(msg.includes("sentinel-n8n-body"));
      assert.doesNotMatch(msg, DOES_NOT_EXIST);
      assert.doesNotMatch(msg, RETENTION);
      assert.doesNotMatch(msg, WORKFLOW_CAUSES);
      assert.doesNotMatch(msg, PROJECT_VISIBILITY);
    });
  }
});
