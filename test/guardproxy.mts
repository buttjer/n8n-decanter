// Focused suite for the MCP guard in both transports: the HTTP guard-proxy
// (lib/mcpserve.mts, `mcp serve`, Plan 33 Task 4) and the stdio guard
// (lib/mcpconnect.mts, `mcp connect` — what the scaffolded .mcp.json spawns).
// Both ride a scripted upstream "n8n" MCP endpoint: pass-through (incl. SSE
// decoding), the jsCode block, fail-closed parsing, the session secret
// (HTTP) / session-id management (stdio), the body cap, and the upstream-401
// token refresh. Binds localhost ports — sandboxes may block that.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { McpClient } from "../lib/mcp.mts";
import { runStdioGuard } from "../lib/mcpconnect.mts";
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
let upstream403s = 0; // ditto for 403 — a switched-off MCP server (Plan 74)
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
    if (upstream403s > 0) {
      upstream403s--;
      return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ message: "MCP access is disabled" }));
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    const msg = body === "" ? {} : JSON.parse(body);
    // notifications get n8n's 202-empty — the stdio guard must emit nothing
    if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) return void res.writeHead(202).end();
    // answer as SSE (the shape the pass-through must not mangle)
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "up-sess-1" })
      // `content` rides alongside `echo` for TOOL CALLS only — a real
      // `initialize` result carries none, and that difference is what the Plan 68
      // notice tests exercise: the queue must survive a message it cannot ride.
      .end(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: msg.method === "tools/call"
          ? { echo: msg.params?.name, content: [{ type: "text", text: `ok: ${msg.params?.name}` }] }
          : { echo: msg.method },
      })}\n\n`);
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upstreamHost = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

// A stub client: the proxy needs bearerToken(), plus callTool() since the
// publish gate (Plan 64 task 3c) reads the draft before letting a publish
// through. `draftNodes` is what that read returns; null makes it throw, which
// is the fail-closed path.
let refreshes = 0;
let draftNodes: unknown[] | null = [];
const mcpStub = {
  bearerToken: async (force = false) => {
    if (force) refreshes++;
    return force ? "refreshed-token" : "real-n8n-token";
  },
  callTool: async (name: string) => {
    if (name !== "get_workflow_details") throw new Error("unexpected tool " + name);
    if (draftNodes === null) throw new Error("n8n unreachable");
    return { workflow: { id: "wf1", name: "Demo", nodes: draftNodes, connections: {} } };
  },
} as unknown as McpClient;

const codeNode = (name: string, jsCode: string) => ({ id: `c-${name}`, name, type: "n8n-nodes-base.code", parameters: { jsCode } });
const publishCall = (id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "publish_workflow", arguments: { workflowId: "wf1" } } });
/** The error text out of a blocked tool result, whichever transport produced it. */
const blockText = (msg: any): string => JSON.parse(msg.result.content[0].text).error;

// Recording mirror (Plan 51 Part A): the guard calls schedule(id) after
// forwarding a non-blocked update_workflow; assert the hook fires correctly.
const scheduled: string[] = [];
/** Notices the mirror wants delivered; a test pushes here, the guard drains it. */
const pendingNotices: string[] = [];
const mirrorStub = {
  schedule: (id: string) => scheduled.push(id),
  drain: async () => {},
  takeNotices: () => pendingNotices.splice(0, pendingNotices.length),
};

const configDir = mkdtempSync(path.join(os.tmpdir(), "decanter-guard-"));
const handle = await startGuardProxy({ mcp: mcpStub, host: upstreamHost, configDir, port: 0, mirror: mirrorStub, log });
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

// Both transports share `guardMessage`; they must not drift in what they RECORD
// either, or an audit trail means different things depending on how the agent
// happens to be wired.
await step("http guard logs: same startup line and same NAME-ONLY audit trail as the stdio guard", async () => {
  assert.ok(
    logs.some((l) => /^info guard: connected to .* blocking jsCode writes in update_workflow$/.test(l)),
    "the http transport announces itself too: " + logs.join(" | "),
  );
  const before = logs.length;
  await post(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "search_workflows", arguments: { token: "sh-hh-hh" } } }));
  const fresh = logs.slice(before);
  assert.ok(fresh.includes("info guard: forwarded search_workflows"), "forwarded call is audited: " + fresh.join(" | "));
  assert.ok(!fresh.some((l) => l.includes("sh-hh-hh")), "arguments must NEVER be logged: " + fresh.join(" | "));
});

await step("structure ops pass: update_workflow WITHOUT jsCode forwards", async () => {
  const r = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "renameNode", oldName: "A", newName: "B" }] } } }));
  assert.equal(r.status, 200);
  assert.match(r.text, /"echo":"update_workflow"/, "reached the upstream");
});

await step("live mirror: a forwarded (non-blocked) update_workflow schedules a refresh of its workflowId", async () => {
  scheduled.length = 0;
  await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf-mirror", operations: [{ type: "renameNode", oldName: "A", newName: "B" }] } } }));
  assert.deepEqual(scheduled, ["wf-mirror"], "structure edit → snapshot refresh scheduled");
});

await step("live mirror: non-update_workflow tools do NOT schedule a refresh", async () => {
  scheduled.length = 0;
  await post(rpc({ params: { name: "search_workflows", arguments: {} } }));
  assert.deepEqual(scheduled, [], "reads never trigger a mirror");
});

await step("the guard: update_workflow carrying jsCode (any depth) is blocked with instructive guidance", async () => {
  const before = seen.length;
  scheduled.length = 0;
  const r = await post(rpc({ params: { name: "update_workflow", arguments: { workflowId: "wf1", operations: [{ type: "updateNodeParameters", nodeName: "Transform", parameters: { jsCode: "hacked" } }] } } }));
  assert.equal(r.status, 200, "answered in-band, not a transport error");
  const msg = JSON.parse(r.text);
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /guard-proxy.*n8n-decanter push/s);
  assert.equal(seen.length, before, "the write never reached n8n");
  assert.deepEqual(scheduled, [], "a blocked write never schedules a mirror refresh");
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

// ---------- the publish gate, on BOTH transports (Plan 64 task 3c) ----------
// `n8n-decanter publish` refuses a draft with dangling refs, but the raw MCP
// tool used to sail straight past it — so an agent could ship exactly what the
// rest of Plan 64 exists to catch. The gate is async (it needs a read), which is
// why it is separate from the synchronous `guardMessage`; both transports share
// it, and the stdio step below drives the SAME cases so they cannot drift.

const PUBLISH_CASES = [
  { name: "clean draft forwards", nodes: [codeNode("Fetch", "return [];")] as unknown[] | null, blocked: false },
  { name: "dangling ref is refused", nodes: [codeNode("T", "return $('Gone').all();")] as unknown[] | null, blocked: true },
  { name: "failed read is refused (fail closed)", nodes: null, blocked: true },
];

await step("publish gate (HTTP): a broken draft is refused, a clean one forwards, a failed read refuses", async () => {
  for (const c of PUBLISH_CASES) {
    draftNodes = c.nodes;
    const before = seen.length;
    const r = await post(JSON.stringify(publishCall()));
    assert.equal(r.status, 200, c.name);
    if (!c.blocked) {
      assert.ok(seen.length > before, `${c.name}: must reach n8n`);
      continue;
    }
    assert.equal(seen.length, before, `${c.name}: n8n must never see it`);
    assert.equal(JSON.parse(r.text).result.isError, true, c.name);
  }
  draftNodes = [];
});

await step("publish gate: the refusal routes both halves, and a failed read never claims the workflow is broken", async () => {
  draftNodes = [
    codeNode("T", "return $('Gone').all();"),
    { id: "s1", name: "Label", type: "n8n-nodes-base.set", parameters: { value: "={{ $('Vanished').first().json.x }}" } },
  ];
  const broken = blockText(JSON.parse((await post(JSON.stringify(publishCall()))).text));
  assert.match(broken, /2 dangling reference\(s\) on the draft of wf1 would go live/);
  assert.match(broken, /expression parameters \(structure — fix in n8n/);
  assert.match(broken, /Code-node source/);
  assert.ok(broken.indexOf("expression parameters") < broken.indexOf("Code-node source"), "parameters listed first — the order that does not lose the code edit");
  assert.match(broken, /n8n-decanter test wf1/);

  draftNodes = null;
  const unreadable = blockText(JSON.parse((await post(JSON.stringify(publishCall()))).text));
  assert.match(unreadable, /could not read wf1 to check it before publishing, so it was NOT published/);
  assert.match(unreadable, /says nothing about the workflow/);
  assert.doesNotMatch(unreadable, /dangling/, "a failed check must not read as a finding");
  draftNodes = [];
});


await step("close removes the discovery file", async () => {
  await handle.close();
  assert.ok(!existsSync(path.join(configDir, PROXY_STATE_FILE)));
});

// ---------- the stdio guard (`mcp connect`) ----------

/** Run the stdio guard on PassThrough pipes with a line-at-a-time reader. */
function startStdio(host = upstreamHost) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runStdioGuard({ mcp: mcpStub, host, timeoutMs: 5000, mirror: mirrorStub, log, input, output });
  let buf = "";
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  const next = (): Promise<string> =>
    new Promise((resolve) => {
      const l = lines.shift();
      if (l !== undefined) resolve(l);
      else waiters.push(resolve);
    });
  const send = (msg: unknown): boolean => input.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
  return {
    send,
    next,
    pending: lines,
    end: async () => {
      input.end();
      await done;
    },
  };
}

const stdio = startStdio();

await step("stdio pass-through: initialize forwards with the real token; SSE decodes to a JSON line; session id is captured and replayed", async () => {
  stdio.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const first = JSON.parse(await stdio.next());
  assert.equal(first.id, 1);
  assert.equal(first.result.echo, "initialize", "SSE data line decoded to plain JSON-RPC");
  assert.equal(seen[seen.length - 1].auth, "Bearer real-n8n-token", "decanter's own credential used");
  stdio.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  assert.equal(JSON.parse(await stdio.next()).id, 2);
  assert.equal(seen[seen.length - 1].session, "up-sess-1", "captured session id replayed upstream");
});

await step("stdio notification: n8n's 202-empty emits nothing (the next line answers the next request)", async () => {
  stdio.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  stdio.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const line = JSON.parse(await stdio.next());
  assert.equal(line.id, 3, "notification produced no output line");
});

await step("stdio guard: a jsCode write is answered locally, upstream untouched", async () => {
  const before = seen.length;
  stdio.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_workflow", arguments: { operations: [{ type: "updateNodeParameters", nodeName: "T", parameters: { jsCode: "x" } }] } } });
  const msg = JSON.parse(await stdio.next());
  assert.equal(msg.id, 4);
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /guard-proxy.*n8n-decanter push/s);
  assert.equal(seen.length, before, "the write never reached n8n");
});

// Plan 68: the live mirror runs a full `pull`, so it can overwrite an unpushed
// local edit. It always warned — to a stderr-only logger, which is the one
// stream an agent structurally cannot read, so the party able to react never
// heard. The result of a tool call is the channel it does read.
await step("stdio: a live-mirror clobber notice rides the next tool result, exactly once", async () => {
  pendingNotices.push("n8n-decanter live mirror: overwrote unpushed local changes in code/main.js");

  stdio.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const carried = JSON.parse(await stdio.next());
  assert.equal(carried.id, 5);
  assert.match(carried.result.content[0].text, /^ok: search_workflows/, "the upstream result survives");
  assert.match(carried.result.content[0].text, /overwrote unpushed local changes in code\/main\.js/, "the notice reached the agent");

  // Drained, not repeated — a warning that re-appears on every later call is
  // noise the agent learns to skip, which is how it stops being read at all.
  stdio.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const clean = JSON.parse(await stdio.next());
  assert.equal(clean.id, 6);
  assert.doesNotMatch(clean.result.content[0].text, /overwrote unpushed/, "the notice is delivered once");
});

// A notice must never be swallowed by a message that cannot carry it: the queue
// is only drained once the guard knows this message has a text result to append
// to. Otherwise a handshake landing between the pull and the next tool call
// would eat the warning — the exact silent-loss shape this plan is about.
await step("stdio: a notice survives a message that cannot carry it, and lands on the next one", async () => {
  pendingNotices.push("n8n-decanter live mirror: overwrote unpushed local changes in code/other.js");

  stdio.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
  const handshake = JSON.parse(await stdio.next());
  assert.equal(handshake.id, 7);
  assert.equal(handshake.result.content, undefined, "the handshake has no text result to carry it");

  stdio.send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const later = JSON.parse(await stdio.next());
  assert.match(later.result.content[0].text, /code\/other\.js/, "the notice waited for a message that could carry it");
});

// The guard used to speak ONLY when it blocked, so an empty log meant either
// "ran, blocked nothing" or "never started" — indistinguishable exactly when it
// matters (a Plan 35 harness bug left the guard dead for three field-test rounds
// and the silence read as innocence). Startup line + per-call audit trail fix that.
await step("stdio guard logs: a startup line, then one NAME-ONLY line per forwarded tool call", async () => {
  assert.ok(
    logs.some((l) => /^info guard: connected to .* blocking jsCode writes in update_workflow$/.test(l)),
    "a guard that never started must be distinguishable from one that blocked nothing: " + logs.join(" | "),
  );
  const before = logs.length;
  stdio.send({ jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "get_workflow_details", arguments: { workflowId: "wf-audit", secret: "sh-hh-hh" } } });
  await stdio.next();
  const fresh = logs.slice(before);
  assert.ok(fresh.includes("info guard: forwarded get_workflow_details"), "forwarded call is audited: " + fresh.join(" | "));
  assert.ok(!fresh.some((l) => l.includes("sh-hh-hh")), "arguments must NEVER be logged — this log is not a secret surface: " + fresh.join(" | "));
});

await step("stdio guard logs: protocol noise is not audited, and a blocked call is not logged as forwarded", async () => {
  let before = logs.length;
  stdio.send({ jsonrpc: "2.0", id: 45, method: "initialize", params: {} });
  await stdio.next();
  assert.ok(!logs.slice(before).some((l) => l.startsWith("info guard: forwarded")), "the handshake is protocol noise, not agent intent");
  before = logs.length;
  stdio.send({ jsonrpc: "2.0", id: 46, method: "tools/call", params: { name: "update_workflow", arguments: { operations: [{ type: "updateNodeParameters", nodeName: "T", parameters: { jsCode: "x" } }] } } });
  await stdio.next();
  const fresh = logs.slice(before);
  assert.ok(!fresh.some((l) => l.startsWith("info guard: forwarded")), "a blocked write never counts as forwarded: " + fresh.join(" | "));
  assert.ok(fresh.some((l) => l.includes("blocked a jsCode write")), "the block is still reported: " + fresh.join(" | "));
});

await step("stdio live mirror: a forwarded update_workflow schedules a refresh; a blocked jsCode write does not", async () => {
  // the stdio guard schedules AFTER forward() returns (a tick past the response
  // line), so settle microtasks before asserting the fire-and-forget schedule
  const settle = () => new Promise((r) => setImmediate(r));
  scheduled.length = 0;
  stdio.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "update_workflow", arguments: { workflowId: "wf-stdio", operations: [{ type: "renameNode", oldName: "A", newName: "B" }] } } });
  await stdio.next();
  await settle();
  assert.deepEqual(scheduled, ["wf-stdio"], "structure edit scheduled after forward");
  scheduled.length = 0;
  stdio.send({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "update_workflow", arguments: { workflowId: "wf-stdio", operations: [{ type: "updateNodeParameters", nodeName: "T", parameters: { jsCode: "x" } }] } } });
  await stdio.next();
  await settle();
  assert.deepEqual(scheduled, [], "blocked jsCode write never schedules");
});

await step("stdio fail closed: an unparseable line gets a -32700 error, nothing forwarded", async () => {
  const before = seen.length;
  stdio.send("{not json");
  const msg = JSON.parse(await stdio.next());
  assert.equal(msg.id, null);
  assert.equal(msg.error.code, -32700);
  assert.match(msg.error.message, /fail closed/);
  assert.equal(seen.length, before);
});

await step("stdio upstream 401 → one forced token refresh, then the retry succeeds", async () => {
  upstream401s = 1;
  const before = refreshes;
  stdio.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const msg = JSON.parse(await stdio.next());
  assert.equal(msg.result.echo, "search_workflows", JSON.stringify(msg));
  assert.equal(refreshes, before + 1, "exactly one forced refresh");
  assert.equal(seen[seen.length - 1].auth, "Bearer refreshed-token");
});

await step("stdio ends with the agent: input EOF resolves the guard", async () => {
  await stdio.end();
  assert.equal(stdio.pending.length, 0, "no stray output lines");
});

await step("stdio upstream down: an id'd request gets a JSON-RPC error naming the host", async () => {
  const dead = startStdio("http://127.0.0.1:9");
  dead.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const msg = JSON.parse(await dead.next());
  assert.equal(msg.id, 6);
  assert.equal(msg.error.code, -32001);
  assert.match(msg.error.message, /unreachable.*127\.0\.0\.1:9/);
  await dead.end();
});

// The wording of these two is load-bearing, not cosmetic: it is the FIRST thing
// an agent sees when the instance rejects it, and two blind rounds watched an
// agent read the old 401 ("run `n8n-decanter init`") and tell its user the
// project had never been set up — sending them through a pointless init while
// the .env sat there, correct, with a merely rotated token.
await step("upstream 401 (stdio): the refusal leads with the CAUSE, not with `init`", async () => {
  const s = startStdio();
  upstream401s = 2; // the guard swallows the first with one forced token refresh
  s.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const msg = JSON.parse(await s.next());
  assert.equal(msg.id, 21);
  assert.ok(
    msg.error.message.startsWith("n8n rejected decanter's existing MCP credentials (401)"),
    `must open with the cause, got: ${msg.error.message}`,
  );
  assert.match(msg.error.message, /NOT a missing-setup error/, "must say outright that this is not a missing setup");
  assert.match(msg.error.message, /Settings → MCP/, "must name where to mint a fresh token");
  upstream401s = 0;
  await s.end();
});

await step("upstream 403 (stdio): a switched-off MCP server is named, with n8n's own reason", async () => {
  const s = startStdio();
  upstream403s = 1;
  s.send({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
  const msg = JSON.parse(await s.next());
  assert.equal(msg.id, 22);
  assert.match(msg.error.message, /403/);
  assert.match(msg.error.message, /MCP access is disabled/, "n8n's own reason must survive");
  assert.match(msg.error.message, /Settings → MCP/, "must point at the switch");
  upstream403s = 0;
  await s.end();
});

await step("publish gate (stdio): identical verdicts — the two transports must not drift", async () => {
  const s = startStdio();
  for (const c of PUBLISH_CASES) {
    draftNodes = c.nodes;
    const before = seen.length;
    s.send(publishCall(9));
    const msg = JSON.parse(await s.next());
    assert.equal(msg.id, 9, c.name);
    if (!c.blocked) {
      assert.ok(seen.length > before, `${c.name}: must reach n8n`);
      assert.equal(msg.result.isError, undefined, `${c.name}: forwarded, so the upstream echo comes back`);
      continue;
    }
    assert.equal(seen.length, before, `${c.name}: n8n must never see it`);
    assert.equal(msg.result.isError, true, c.name);
  }
  draftNodes = [];
  await s.end();
});


if (!hasFailed()) {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(configDir, { recursive: true, force: true });
}
console.log(`\n${passedCount()} guard-proxy checks passed`);
