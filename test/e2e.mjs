// End-to-end test: mock n8n API + the real CLI as a subprocess.
// Needs to bind a localhost port — sandboxed environments may block this.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT, "n8n-decanter.mjs");
const TMP = path.join(os.tmpdir(), `n8n-decanter-e2e-${process.pid}`);
const ROOT = path.join(TMP, "workflows");

// ---------- mock n8n ----------
const ALLOWED_PUT = ["name", "nodes", "connections", "settings", "staticData"];
const db = new Map();
const server = http.createServer((req, res) => {
  if (req.headers["x-n8n-api-key"] !== "test-key") return void res.writeHead(401).end("unauthorized");
  if (req.method === "GET" && req.url.startsWith("/api/v1/workflows?")) {
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [...db.values()], nextCursor: null }));
  }
  const m = req.url.match(/^\/api\/v1\/workflows\/([^/]+)$/);
  if (!m) return void res.writeHead(404).end("nope");
  const wf = db.get(m[1]);
  if (!wf) return void res.writeHead(404).end("not found");
  if (req.method === "GET") {
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(wf));
  }
  if (req.method === "PUT") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body);
      const unknown = Object.keys(sent).filter((k) => !ALLOWED_PUT.includes(k));
      if (unknown.length > 0) return void res.writeHead(400).end("request/body must NOT have additional properties: " + unknown.join(","));
      Object.assign(wf, sent, { updatedAt: new Date().toISOString() });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(wf));
    });
  }
});

const JS_CODE = "// @ts-check\nconst items = $input.all();\nfor (const item of items) {\n  item.json.total = Number(item.json.total ?? 0);\n}\nreturn items;\n";
db.set("wf123", {
  id: "wf123",
  name: "Order Sync",
  active: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  nodes: [
    { id: "n1", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "orders" } },
    { id: "n2", name: "Transform", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0], parameters: { jsCode: JS_CODE } },
    { id: "n3", name: "Amazon Feed", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 0], parameters: { jsCode: "return $input.all();\n" } },
  ],
  connections: { Webhook: { main: [[{ node: "Transform", type: "main", index: 0 }]] } },
  settings: { executionOrder: "v1", timezone: "Europe/Berlin" },
  staticData: null,
  pinData: {},
  tags: [],
  versionId: "aaa",
});

// ---------- helpers ----------
let env;
async function cli(...args) {
  // async on purpose: the mock server lives in this process, a sync exec would deadlock
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...args], { cwd: TMP, env, encoding: "utf8" });
    return { out: stdout + stderr, code: 0 };
  } catch (err) {
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.code ?? 1 };
  }
}
const wfDir = (name) => path.join(ROOT, name);
const read = (...p) => readFileSync(path.join(...p), "utf8");
const state = (dir) => JSON.parse(read(dir, ".decanter.json"));
const remoteNode = (id, nid) => db.get(id).nodes.find((n) => n.id === nid);
let passed = 0;
function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok   ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}\n${err.stack}\n\nwork dir kept: ${TMP}`);
      server.close();
      process.exit(1);
    });
}

// ---------- run ----------
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: ["wf123"] }, null, 2));

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
env = { ...process.env, N8N_HOST: `http://127.0.0.1:${server.address().port}`, N8N_API_KEY: "test-key" };

const dir1 = wfDir("Order Sync");

await step("init: writes .env, copies template, scaffolds config", async () => {
  const target = path.join(TMP, "init-target");
  const pending = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  pending.child.stdin.write(`${env.N8N_HOST}\ntest-key\n`);
  pending.child.stdin.end();
  const { stdout, stderr } = await pending;
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\n`);
  assert.ok(existsSync(path.join(target, "AGENTS.md")), "AGENTS.md copied");
  assert.match(read(target, "CLAUDE.md"), /AGENTS\.md/);
  assert.ok(existsSync(path.join(target, "workflows")), "workflows dir copied");
  assert.equal(JSON.parse(read(target, "decanter.config.json")).root, "./workflows");
  assert.match(read(target, ".gitignore"), /^\.env$/m);
  assert.match(stdout + stderr, /credentials verified/);
  // re-init must not clobber user edits to template-provided files
  writeFileSync(path.join(target, "AGENTS.md"), "user content\n");
  const again = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  again.child.stdin.write("\n\n"); // keep existing host + key
  again.child.stdin.end();
  await again;
  assert.equal(read(target, "AGENTS.md"), "user content\n");
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\n`);
});

await step("pull: creates folder, files, placeholders, state", async () => {
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir1, "Transform.js"), JS_CODE);
  assert.equal(read(dir1, "Amazon Feed.js"), "return $input.all();\n");
  const wfJson = read(dir1, "workflow.json");
  assert.match(wfJson, /"\/\/@file:Transform\.js"/);
  assert.match(wfJson, /"\/\/@file:Amazon Feed\.js"/);
  const s = state(dir1);
  assert.equal(s.workflowId, "wf123");
  assert.equal(s.nodes.n2.file, "Transform.js");
  assert.match(s.nodes.n2.lastPushedHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(s.lastPulledWorkflowHash);
});

await step("push unchanged: byte-identical js round-trip", async () => {
  const before = remoteNode("wf123", "n2").parameters.jsCode;
  const r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, before);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, JS_CODE);
});

const TS_SOURCE = 'interface FeedRow { sku: string; qty: number }\nconst rows: FeedRow[] = $input.all().map((i) => ({ sku: String(i.json.sku), qty: Number(i.json.qty) }));\nreturn rows.map((r) => ({ json: { ...r } }));\n';

await step("convert node to .ts + push: compiles, appends marker", async () => {
  unlinkSync(path.join(dir1, "Amazon Feed.js"));
  writeFileSync(path.join(dir1, "Amazon Feed.ts"), TS_SOURCE);
  writeFileSync(path.join(dir1, "workflow.json"), read(dir1, "workflow.json").replace("//@file:Amazon Feed.js", "//@file:Amazon Feed.ts"));
  const r = await cli("push");
  assert.equal(r.code, 0, r.out);
  const code = remoteNode("wf123", "n3").parameters.jsCode;
  assert.match(code, /\n\/\/ @ts-n8n sha256:[0-9a-f]{64}$/);
  assert.ok(!code.includes("FeedRow[]"), "types must be stripped");
  assert.ok(code.includes("rows.map"), "logic must survive");
  assert.equal(state(dir1).nodes.n3.file, "Amazon Feed.ts");
});

await step("pull after ts push: in sync, .ts untouched, no .remote.js", async () => {
  const before = read(dir1, "Amazon Feed.ts");
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir1, "Amazon Feed.ts"), before);
  assert.ok(!existsSync(path.join(dir1, "Amazon Feed.remote.js")));
  assert.match(read(dir1, "workflow.json"), /"\/\/@file:Amazon Feed\.ts"/);
});

await step("remote UI edit on ts node: push aborts, pull surfaces .remote.js", async () => {
  const node = remoteNode("wf123", "n3");
  node.parameters.jsCode = node.parameters.jsCode.replace("return rows.map", "// hotfix from UI\nreturn rows.map");
  let r = await cli("push");
  assert.equal(r.code, 1, "push must abort on drift");
  assert.match(r.out, /remote code changed since last sync/);
  assert.match(r.out, /pull first/);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /edited in the n8n UI/);
  assert.match(read(dir1, "Amazon Feed.remote.js"), /hotfix from UI/);
  // after pull, push is allowed again and restores the TS-compiled version
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.ok(!remoteNode("wf123", "n3").parameters.jsCode.includes("hotfix"));
});

await step("marker removed remotely (rewrite in UI): .ts never clobbered", async () => {
  remoteNode("wf123", "n3").parameters.jsCode = "return [];";
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no @ts-n8n marker/);
  assert.equal(read(dir1, "Amazon Feed.remote.js"), "return [];");
  assert.equal(read(dir1, "Amazon Feed.ts"), TS_SOURCE);
  const r2 = await cli("push");
  assert.equal(r2.code, 0, r2.out);
  assert.match(remoteNode("wf123", "n3").parameters.jsCode, /\/\/ @ts-n8n sha256:/);
  await cli("pull"); // resync, removes stale .remote.js
  assert.ok(!existsSync(path.join(dir1, "Amazon Feed.remote.js")));
});

await step("structural remote edit: push aborts, pull resyncs", async () => {
  const wf = db.get("wf123");
  wf.nodes.push({ id: "n4", name: "Set", type: "n8n-nodes-base.set", typeVersion: 3, position: [660, 0], parameters: {} });
  let r = await cli("push");
  assert.equal(r.code, 1);
  assert.match(r.out, /workflow structure changed remotely/);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(read(dir1, "workflow.json"), /"n4"/);
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
});

await step("status: reports pending local edit, then in sync", async () => {
  const js = path.join(dir1, "Transform.js");
  writeFileSync(js, read(dir1, "Transform.js") + "// local tweak\n");
  let r = await cli("status");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Transform: local changes in Transform\.js — push pending/);
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(remoteNode("wf123", "n2").parameters.jsCode, /local tweak/);
  r = await cli("status");
  assert.match(r.out, /Transform: in sync/);
  assert.match(r.out, /structure: in sync/);
});

await step("remote workflow + node rename: folder and file follow", async () => {
  const wf = db.get("wf123");
  wf.name = "Order Sync v2";
  wf.nodes.find((n) => n.id === "n2").name = "Transform: EU/US";
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  const dir2 = wfDir("Order Sync v2");
  assert.ok(existsSync(dir2), "folder renamed");
  assert.ok(!existsSync(dir1), "old folder gone");
  assert.ok(existsSync(path.join(dir2, "Transform- EU-US.js")), "file renamed with sanitized name");
  assert.ok(!existsSync(path.join(dir2, "Transform.js")));
  assert.equal(state(dir2).nodes.n2.file, "Transform- EU-US.js");
  assert.match(read(dir2, "workflow.json"), /"\/\/@file:Transform- EU-US\.js"/);
});

await step("watch path: pushSingleNode round-trip", async () => {
  const { pushSingleNode } = await import(pathToFileURL(path.join(PROJECT, "lib/push.mjs")).href);
  const { N8nApi } = await import(pathToFileURL(path.join(PROJECT, "lib/api.mjs")).href);
  const dir2 = wfDir("Order Sync v2");
  writeFileSync(path.join(dir2, "Transform- EU-US.js"), "return $input.all(); // watched\n");
  const api = new N8nApi({ host: env.N8N_HOST, apiKey: "test-key" });
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  await pushSingleNode(api, dir2, "n2", {}, log);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, "return $input.all(); // watched\n");
});

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} steps passed`);
