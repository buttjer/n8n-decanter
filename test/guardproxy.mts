// Focused suite for the MCP guard-proxy (lib/mcpserve.mts, Plan 33 Task 4).
// Drives startGuardProxy directly against a scripted upstream "n8n" MCP
// endpoint: pass-through (incl. SSE), the jsCode block, fail-closed parsing,
// the session secret, the body cap, and the upstream-401 token refresh.
// Binds localhost ports — sandboxes may block that.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { McpClient } from "../lib/mcp.mts";
import { containsJsCodeKey, guardMessage, PROXY_STATE_FILE, startGuardProxy } from "../lib/mcpserve.mts";
import type { Log } from "../lib/types.mts";
import { createStepRunner } from "./harness.mts";

const { step, passedCount, hasFailed } = createStepRunner();

const logs: string[] = [];
const log: Log = {
  info: (m) => logs.push(`info ${m}`),
  ok: (m) => logs.push(`ok ${m}`),
  warn: (m) => logs.push(`warn ${m}`),
  error: (m) => logs.push(`error ${m}`),
};

// ---------- scripted upstream n8n MCP endpoint ----------
const seen: Array<{ auth: string | undefined; session: string | undefined; body: string }> = [];
let upstream401s = 0; // when > 0, that many next requests answer 401
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ auth: req.headers.authorization, session: req.headers["mcp-session-id"] as string | undefined, body });
    if (req.url !== "/mcp-server/http") return void res.writeHead(404).end();
    if (upstream401s > 0) {
      upstream401s--;
      return void res.writeHead(401).end("unauthorized");
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    const msg = body === "" ? {} : JSON.parse(body);
    // answer as SSE (the shape the pass-through must not mangle)
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "up-sess-1" })
      .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result: { echo: msg.params?.name ?? msg.method } })}\n\n`);
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upstreamHost = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

// A stub client: the proxy only needs bearerToken(); count the force-refreshes.
let refreshes = 0;
const mcpStub = {
  bearerToken: async (force = false) => {
    if (force) refreshes++;
    return force ? "refreshed-token" : "real-n8n-token";
  },
} as unknown as McpClient;

const configDir = mkdtempSync(path.join(os.tmpdir(), "decanter-guard-"));
const handle = await startGuardProxy({ mcp: mcpStub, host: upstreamHost, configDir, port: 0, log });
const auth = { authorization: `Bearer ${handle.secret}` };

const rpc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_workflows", arguments: {} }, ...over });

async function post(body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = auth): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(handle.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

await step("state file: endpoint + secret land in a 0600 discovery file", async () => {
  const stateFile = path.join(configDir, PROXY_STATE_FILE);
  assert.ok(existsSync(stateFile));
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.url, handle.url);
  assert.equal(state.secret, handle.secret);
});

await step("session secret: requests without it are rejected, upstream never sees them", async () => {
  const before = seen.length;
  let r = await post(rpc(), {});
  assert.equal(r.status, 401);
  r = await post(rpc(), { authorization: "Bearer wrong" });
  assert.equal(r.status, 401);
  assert.equal(seen.length, before, "nothing forwarded");
});

await step("pass-through: harmless calls forward with the REAL token; SSE + session id come back untouched", async () => {
  const r = await post(rpc());
  assert.equal(r.status, 200);
  assert.match(r.text, /data: .*"echo":"search_workflows"/, "SSE piped verbatim");
  assert.equal(r.headers.get("mcp-session-id"), "up-sess-1", "session header surfaced");
  const fwd = seen[seen.length - 1];
  assert.equal(fwd.auth, "Bearer real-n8n-token", "agent secret swapped for the real credential");
});

await step("structure ops pass: update_workflow WITHOUT jsCode forwards", async () => {
  const r = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "renameNode", oldName: "A", newName: "B" }] } } }));
  assert.equal(r.status, 200);
  assert.match(r.text, /"echo":"update_workflow"/, "reached the upstream");
});

await step("the guard: update_workflow carrying jsCode (any depth) is blocked with instructive guidance", async () => {
  const before = seen.length;
  const r = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "updateNodeParameters", nodeName: "Transform", parameters: { jsCode: "hacked" } }] } } }));
  assert.equal(r.status, 200, "answered in-band, not a transport error");
  const msg = JSON.parse(r.text);
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /guard-proxy.*n8n-decanter push/s);
  assert.equal(seen.length, before, "the write never reached n8n");
  assert.ok(logs.some((l) => l.includes("blocked a jsCode write")), "operator log line");
});

await step("no op-type enumeration: a jsCode key nested anywhere blocks; other tools with jsCode pass", async () => {
  // nested deep inside an unknown future op shape → still blocked
  const nested = { params: { name: "update_workflow", arguments: { future: [{ deeper: { jsCode: "x" } }] } } };
  const blocked = await post(rpc(nested));
  assert.equal(JSON.parse(blocked.text).result.isError, true);
  // a different tool (e.g. validate_workflow with code) is not update_workflow → passes
  const other = await post(rpc({ params: { name: "validate_workflow", arguments: { code: "workflow('a','b')" } } }));
  assert.match(other.text, /"echo":"validate_workflow"/);
  // pure helpers agree
  assert.equal(containsJsCodeKey({ a: [{ b: { jsCode: "x" } }] }), true);
  assert.equal(containsJsCodeKey({ a: "jsCode" }), false, "values are not keys");
  assert.equal(guardMessage({ method: "initialize" }), null);
});

await step("the setNodeParameter bypass is closed: jsCode via a path+value op is blocked, and reaches n8n never", async () => {
  const before = seen.length;
  // n8n's verified update_workflow op: setNodeParameter carries "jsCode" only
  // in the JSON-Pointer path, the code in a scalar value — no jsCode KEY
  const r = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "setNodeParameter", nodeName: "Transform", path: "/jsCode", value: "exfiltrate()" }] } } }));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).result?.isError, true, "setNodeParameter jsCode write blocked: " + r.text);
  assert.equal(seen.length, before, "the disguised write never reached n8n");
  // the deeper pointer form (/parameters/jsCode) is blocked too
  const r2 = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "setNodeParameter", nodeName: "Transform", path: "/parameters/jsCode", value: "x" }] } } }));
  assert.equal(JSON.parse(r2.text).result?.isError, true);
  // a setNodeParameter to a NON-code field still passes (structure op)
  const r3 = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "setNodeParameter", nodeName: "Transform", path: "/mode", value: "runOnceForEachItem" }] } } }));
  assert.match(r3.text, /"echo":"update_workflow"/, "non-jsCode setNodeParameter passes: " + r3.text);
});

await step("fail closed: an unparseable body is refused, never forwarded", async () => {
  const before = seen.length;
  const r = await post("{not json");
  assert.equal(r.status, 403);
  assert.match(r.text, /fail closed/);
  assert.equal(seen.length, before);
});

await step("body cap: an oversized request gets 413", async () => {
  const r = await post(new Uint8Array(new ArrayBuffer(11 * 1024 * 1024)).fill(0x61));
  assert.equal(r.status, 413);
});

await step("upstream 401 → one forced token refresh, then the retry succeeds", async () => {
  upstream401s = 1;
  const before = refreshes;
  const r = await post(rpc());
  assert.equal(r.status, 200, r.text);
  assert.equal(refreshes, before + 1, "exactly one forced refresh");
  assert.equal(seen[seen.length - 1].auth, "Bearer refreshed-token", "retry used the refreshed token");
});

await step("close removes the discovery file", async () => {
  await handle.close();
  assert.ok(!existsSync(path.join(configDir, PROXY_STATE_FILE)));
});

if (!hasFailed()) {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(configDir, { recursive: true, force: true });
}
console.log(`\n${passedCount()} guard-proxy checks passed`);
