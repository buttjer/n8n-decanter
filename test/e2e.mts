// End-to-end test: mock n8n (MCP server for the code path + REST for the
// API-only verbs) + the real CLI as a subprocess.
// Needs to bind a localhost port — sandboxed environments may block this.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createStepRunner } from "./harness.mts";
import { kebabCase } from "../lib/util.mts";

const execFile = promisify(execFileCb);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");
const TMP = path.join(os.tmpdir(), `n8n-decanter-e2e-${process.pid}`);
const ROOT = path.join(TMP, "workflows");

// ---------- mock n8n ----------
// One server, two surfaces (mirrors Plan 32's split): the MCP endpoint
// (`POST /mcp-server/http`, bearer-authed JSON-RPC) serves the workflow code
// path — search/details/update/publish/create; the REST endpoints keep
// serving what MCP cannot: executions, data tables, duplicate's POST,
// delete's DELETE. Workflows carry an `availableInMCP` flag exactly like a
// real 2.x instance: search lists everything, details/update/publish refuse
// unavailable ones.
const MCP_TOKEN = "test-mcp-token";
const UNAVAILABLE_TEXT = "Workflow is not available in MCP. Enable MCP access from the workflow card in the workflows list, or from the workflow settings.";
const db = new Map<string, any>();
let updateCount = 0; // update_workflow calls served — watch steps assert deltas
let slowUpdateMs = 0; // when > 0, update_workflow responses are delayed (queued-push test)
let createCount = 0;
const mkid = () => Math.random().toString(16).slice(2, 14).padEnd(12, "0");

/** Rewrite literal $('Old') / $("Old") refs in a string (the mock's stand-in
 * for n8n's server-side expression rewriting on rename). */
const renameRefs = (text: string, oldName: string, newName: string): string =>
  text.split(`$('${oldName}')`).join(`$('${newName}')`).split(`$("${oldName}")`).join(`$("${newName}")`);

const renameRefsDeep = (value: any, oldName: string, newName: string): any => {
  if (typeof value === "string") return renameRefs(value, oldName, newName);
  if (Array.isArray(value)) return value.map((v) => renameRefsDeep(v, oldName, newName));
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) value[k] = renameRefsDeep(value[k], oldName, newName);
  }
  return value;
};

/** Apply an update_workflow op batch, mirroring the verified 2.30.7 semantics:
 * name-addressed, updateNodeParameters merges, renameNode keeps ids and
 * rewrites connections + expression refs, addNode re-mints the id. */
function applyOps(wf: any, operations: any[]): void {
  for (const [i, op] of operations.entries()) {
    if (op.type === "updateNodeParameters") {
      const node = wf.nodes.find((n: any) => n.name === op.nodeName);
      if (!node) throw new Error(`Operation ${i} failed: node '${op.nodeName}' not found`);
      node.parameters = op.replace ? { ...op.parameters } : { ...node.parameters, ...op.parameters };
    } else if (op.type === "renameNode") {
      const node = wf.nodes.find((n: any) => n.name === op.oldName);
      if (!node) throw new Error(`Operation ${i} failed: node '${op.oldName}' not found`);
      node.name = op.newName;
      if (Object.hasOwn(wf.connections ?? {}, op.oldName)) {
        wf.connections[op.newName] = wf.connections[op.oldName];
        delete wf.connections[op.oldName];
      }
      for (const byType of Object.values(wf.connections ?? {})) {
        for (const groups of Object.values(byType as any)) {
          for (const group of groups as any[]) {
            for (const target of group) if (target.node === op.oldName) target.node = op.newName;
          }
        }
      }
      for (const n of wf.nodes) renameRefsDeep(n.parameters, op.oldName, op.newName);
    } else if (op.type === "addNode") {
      // the server mints the node id — deliberately adversarial for the CLI's
      // by-name landing resolution
      wf.nodes.push({ ...op.node, id: mkid() });
    } else if (op.type === "setWorkflowMetadata") {
      if (typeof op.name === "string") wf.name = op.name;
    } else {
      throw new Error(`Operation ${i} failed: unsupported op ${op.type}`);
    }
  }
  wf.updatedAt = new Date().toISOString();
}

/** get_workflow_details payload: full nodes (byte-exact jsCode) + the derived
 * noise pull must strip (activeVersion/shared/scopes/canExecute). */
const detailsOf = (wf: any) => ({
  workflow: {
    id: wf.id, name: wf.name, active: wf.active, isArchived: false,
    versionId: wf.versionId, activeVersionId: wf.activeVersionId ?? null,
    createdAt: wf.createdAt, updatedAt: wf.updatedAt,
    settings: wf.settings, connections: wf.connections, nodes: wf.nodes,
    activeVersion: wf.activeVersion ?? null, shared: wf.shared,
    scopes: ["workflow:read", "workflow:update"], canExecute: true,
    tags: wf.tags ?? [], meta: null, parentFolderId: null,
    pinData: wf.pinData,
  },
  triggerInfo: "",
});

const summaryOf = (wf: any) => ({
  id: wf.id, name: wf.name, description: null, active: wf.active,
  createdAt: wf.createdAt, updatedAt: wf.updatedAt, triggerCount: 0,
  scopes: ["workflow:read"], canExecute: true,
  availableInMCP: wf.availableInMCP !== false, tags: [],
});

/** One MCP tool call → its result envelope (or `null` to hang forever). */
function callMcpTool(name: string, args: any): any | null {
  const err = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  const ok = (payload: any) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
  const gate = (id: string): any | undefined => {
    const wf = db.get(id);
    if (!wf) return err("Workflow not found or you don't have permission to access it.");
    if (wf.availableInMCP === false) return err(UNAVAILABLE_TEXT);
    return undefined;
  };
  switch (name) {
    case "search_workflows":
      return ok({ data: [...db.values()].map(summaryOf), count: db.size });
    case "get_workflow_details": {
      if (args.workflowId === "wf-hang") return null; // timeout step: never respond
      return gate(args.workflowId) ?? ok(detailsOf(db.get(args.workflowId)));
    }
    case "update_workflow": {
      const gated = gate(args.workflowId);
      if (gated) return gated;
      const wf = db.get(args.workflowId);
      try {
        updateCount++;
        applyOps(wf, args.operations);
      } catch (e) {
        return err(JSON.stringify({ error: (e as Error).message }));
      }
      return ok({ workflowId: wf.id, name: wf.name, nodeCount: wf.nodes.length, url: `http://mock/workflow/${wf.id}`, appliedOperations: args.operations.length, autoAssignedCredentials: [], validationWarnings: [] });
    }
    case "publish_workflow": {
      const wf = db.get(args.workflowId);
      if (!wf) return err("Workflow not found or you don't have permission to access it.");
      if (wf.availableInMCP === false) return ok({ success: false, workflowId: args.workflowId, activeVersionId: null, error: UNAVAILABLE_TEXT });
      wf.active = true;
      wf.activeVersionId = wf.versionId;
      return ok({ success: true, workflowId: wf.id, activeVersionId: wf.activeVersionId });
    }
    case "unpublish_workflow": {
      const wf = db.get(args.workflowId);
      if (!wf) return err("Workflow not found or you don't have permission to access it.");
      wf.active = false;
      wf.activeVersionId = null;
      return ok({ success: true, workflowId: wf.id });
    }
    case "create_workflow_from_code": {
      const m = String(args.code).match(/^workflow\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)$/);
      if (!m) return err(JSON.stringify({ error: "Failed to parse generated workflow code" }));
      const id = `wf-new-${createCount++}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      db.set(id, {
        id, name: JSON.parse(`"${m[2]}"`), active: false, createdAt: now, updatedAt: now,
        nodes: [], connections: {}, settings: {}, staticData: null, pinData: {}, tags: [],
        versionId: `ver-${id}`, activeVersionId: null,
        availableInMCP: true, // MCP-created workflows are born available (spike-verified)
      });
      return ok({ workflowId: id, name: db.get(id).name, warnings: [{ code: "NO_NODES", message: "Workflow has no nodes" }] });
    }
    default:
      return err(`Unknown tool: ${name}`);
  }
}

const server = http.createServer((req, res) => {
  // ---- MCP endpoint (bearer-authed JSON-RPC over streamable HTTP) ----
  if (req.url === "/mcp-server/http") {
    if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) return void res.writeHead(401).end("unauthorized");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.method === "initialize") {
        // plain-JSON response (tools/call answers as SSE — both parser branches covered)
        return void res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "e2e-session" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock MCP", version: "0" } } }));
      }
      if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
      if (msg.method !== "tools/call") {
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }));
      }
      const result = callMcpTool(msg.params.name, msg.params.arguments ?? {});
      if (result === null) return; // hang forever (timeout step)
      const respond = () =>
        void res
          .writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "e2e-session" })
          .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
      if (slowUpdateMs > 0 && msg.params.name === "update_workflow") setTimeout(respond, slowUpdateMs);
      else respond();
    });
    return;
  }

  // ---- REST endpoints (the API-only verbs) ----
  if (req.headers["x-n8n-api-key"] !== "test-key") return void res.writeHead(401).end("unauthorized");
  // init's API-key probe (GET /workflows?limit=1) — a shallow list suffices
  if (req.method === "GET" && req.url!.startsWith("/api/v1/workflows?")) {
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], nextCursor: null }));
  }
  // create: POST /api/v1/workflows (duplicate's lossless clone) — API-born
  // workflows are NOT available in MCP, mirroring a real instance
  if (req.method === "POST" && req.url === "/api/v1/workflows") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sent = JSON.parse(body);
      for (const required of ["name", "nodes", "connections", "settings"]) {
        if (sent[required] === undefined) return void res.writeHead(400).end(`request/body must have required property '${required}'`);
      }
      const id = `wf-new-${createCount++}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const created = {
        id, name: sent.name, active: false, createdAt: now, updatedAt: now,
        nodes: sent.nodes, connections: sent.connections, settings: sent.settings,
        staticData: null, pinData: {}, tags: [],
        versionId: `ver-${id}`, activeVersionId: null,
        availableInMCP: false,
      };
      db.set(id, created);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(created));
    });
    return;
  }
  if (req.method === "GET" && req.url!.startsWith("/api/v1/executions")) {
    const one = req.url!.match(/^\/api\/v1\/executions\/(\d+)\?/);
    if (one) {
      const exec = EXECUTIONS.find((e) => String(e.id) === one[1]);
      if (!exec) return void res.writeHead(404).end("not found");
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(exec));
    }
    const params = new URL(req.url!, "http://localhost").searchParams;
    let list = EXECUTIONS;
    const wfId = params.get("workflowId");
    if (wfId) list = list.filter((e) => e.workflowId === wfId);
    const status = params.get("status");
    if (status) list = list.filter((e) => e.status === status);
    const limit = Number(params.get("limit") ?? 10);
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: list.slice(0, limit), nextCursor: null }));
  }
  // data tables (Plan 25): read-only list / columns / filtered rows. Shapes
  // mirror the researched n8n ≥ 2.x endpoints (list is cursor-paginated like
  // workflows; columns is a bare array; rows takes server-side filter/search/
  // sortBy/limit + cursor). The CLI only ever GETs these.
  if (req.method === "GET" && req.url!.startsWith("/api/v1/data-tables")) {
    const cols = req.url!.match(/^\/api\/v1\/data-tables\/([^/?]+)\/columns/);
    if (cols) {
      const t = DATA_TABLES.find((d) => String(d.id) === cols[1]);
      if (!t) return void res.writeHead(404).end("not found");
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(t.columns));
    }
    const rows = req.url!.match(/^\/api\/v1\/data-tables\/([^/?]+)\/rows/);
    if (rows) {
      const t = DATA_TABLES.find((d) => String(d.id) === rows[1]);
      if (!t) return void res.writeHead(404).end("not found");
      const params = new URL(req.url!, "http://localhost").searchParams;
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(queryRows(t.rows, params)));
    }
    // list — omit rows/columns so the separate columns fetch is exercised
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: DATA_TABLES.map((d) => ({ id: d.id, name: d.name, projectId: d.projectId })), nextCursor: null }));
  }
  const m = req.url!.match(/^\/api\/v1\/workflows\/([^/]+)$/);
  if (!m) return void res.writeHead(404).end("nope");
  const wf = db.get(m[1]);
  if (!wf) return void res.writeHead(404).end("not found");
  if (req.method === "GET") {
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(wf));
  }
  if (req.method === "DELETE") {
    db.delete(m[1]); // hard delete, even when published (matches 2.x)
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(wf));
  }
  res.writeHead(405).end("method not allowed");
});

// Shape mirrors the Plan 15 smoke-verified 2.x response: items under
// data.resultData.runData["<Node Name>"][0].data.main[0][], newest first,
// per-execution workflowVersionId (executions run the *published* version).
const EXECUTIONS = [
  {
    id: 202, status: "error", mode: "webhook", workflowId: "wf123", workflowVersionId: "aaa",
    startedAt: "2026-07-19T10:05:00.000Z", stoppedAt: "2026-07-19T10:05:01.000Z",
    data: { resultData: { runData: { Webhook: [{ data: { main: [[{ json: { order: 7 }, pairedItem: { item: 0 } }]] } }] }, error: { message: "boom" } } },
  },
  {
    id: 201, status: "success", mode: "webhook", workflowId: "wf123", workflowVersionId: "aaa",
    startedAt: "2026-07-19T10:00:00.000Z", stoppedAt: "2026-07-19T10:00:01.000Z",
    data: { resultData: { runData: {
      Webhook: [{ data: { main: [[{ json: { order: 1, total: "9.5" }, pairedItem: { item: 0 } }]] } }],
      Transform: [{ data: { main: [[{ json: { order: 1, total: 9.5 }, pairedItem: { item: 0 } }]] } }],
    } } },
  },
  {
    id: 100, status: "success", mode: "manual", workflowId: "wf-other", workflowVersionId: "zzz",
    startedAt: "2026-07-19T09:00:00.000Z", stoppedAt: "2026-07-19T09:00:01.000Z",
    data: { resultData: { runData: {} } },
  },
];

// data-table fixtures (Plan 25) + a tiny server-side query engine so the e2e
// can assert that --filter/--search/--sort narrow rows on the server, not
// client-side. Two tables, one with several rows to filter/paginate.
const DATA_TABLES = [
  {
    id: 1, name: "Orders", projectId: "proj-1",
    columns: [{ id: 1, name: "status", type: "string" }, { id: 2, name: "total", type: "number" }],
    rows: [
      { id: 1, status: "active", total: 10 },
      { id: 2, status: "closed", total: 20 },
      { id: 3, status: "active", total: 30 },
    ],
  },
  {
    id: 2, name: "Customers", projectId: "proj-1",
    columns: [{ id: 1, name: "email", type: "string" }],
    rows: [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }],
  },
];

function queryRows(rows: any[], params: URLSearchParams): { data: any[]; nextCursor: string | null } {
  let out = [...rows];
  const filter = params.get("filter");
  if (filter) {
    const parsed = JSON.parse(filter) as { filters?: Array<{ columnName: string; condition: string; value: unknown }> };
    for (const f of parsed.filters ?? []) {
      if (f.condition === "eq") out = out.filter((r) => r[f.columnName] === f.value);
    }
  }
  const search = params.get("search");
  if (search) out = out.filter((r) => Object.values(r).some((v) => typeof v === "string" && v.includes(search)));
  const sortBy = params.get("sortBy");
  if (sortBy) {
    const [col, dir] = sortBy.split(":");
    out.sort((a, b) => ((a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "desc" ? -1 : 1)));
  }
  const limit = Number(params.get("limit") ?? 100);
  const cursor = Number(params.get("cursor") ?? 0);
  const page = out.slice(cursor, cursor + limit);
  return { data: page, nextCursor: cursor + limit < out.length ? String(cursor + limit) : null };
}

const JS_CODE = "// @ts-check\nconst items = $input.all();\nfor (const item of items) {\n  item.json.total = Number(item.json.total ?? 0);\n}\nreturn items;\n";
db.set("wf123", {
  id: "wf123",
  name: "Order Sync",
  active: true,
  availableInMCP: true,
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
  activeVersionId: "aaa", // published & in sync (live version == draft); version-aware status stays plain
  // n8n 2.x derived fields — pull must keep them OUT of workflow.json
  activeVersion: { versionId: "aaa", nodes: [{ id: "n2", parameters: { jsCode: JS_CODE } }], workflowPublishHistory: [] },
  shared: [{ createdAt: "2026-07-01T00:00:00.000Z", role: "workflow:owner" }],
});

// ---------- helpers ----------
let env: NodeJS.ProcessEnv;
async function cli(...args: string[]) {
  // async on purpose: the mock server lives in this process, a sync exec would deadlock
  let out: string;
  let code: number;
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...args], { cwd: TMP, env, encoding: "utf8" });
    out = stdout + stderr;
    code = 0;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.code ?? 1;
  }
  // styling is TTY-gated (Plan 11): piped output must never carry escapes
  assert.ok(!out.includes("\x1b"), `ANSI escape leaked into piped output of "${args.join(" ")}": ${JSON.stringify(out.slice(0, 300))}`);
  return { out, code };
}
// Folders are kebab-case now (Plan 27); wfDir mirrors the CLI's own slugging so
// call sites can keep naming workflows by their human name. wf123 is pulled
// first as "Order Sync", so its folder is a sticky `order-sync` for its whole
// life (dir1) even as the workflow is renamed remotely.
const wfDir = (name: string) => path.join(ROOT, kebabCase(name));
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");
const state = (dir: string) => JSON.parse(read(dir, ".decanter.json"));
const remoteNode = (id: string, nid: string) => db.get(id).nodes.find((n: any) => n.id === nid);
/** In-process McpClient on the mock (bearer auth) for the watch/push steps. */
async function mcpClient() {
  const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib/mcp.mts")).href);
  return new McpClient({ host: env.N8N_HOST!, auth: { kind: "bearer", token: MCP_TOKEN } });
}
const { step, passedCount, hasFailed } = createStepRunner({
  onFail: () => {
    console.error(`work dir kept: ${TMP}`);
    server.close();
  },
});

// ---------- run ----------
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
// commitOnPush/commitOnPull off for the base scenario; a dedicated step tests them explicitly
writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: ["wf123"], commitOnPush: false, commitOnPull: false }, null, 2));

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
env = {
  ...process.env,
  N8N_HOST: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
  N8N_API_KEY: "test-key",
  N8N_MCP_TOKEN: MCP_TOKEN,
};

const dir1 = wfDir("Order Sync");

function listFilesRecursive(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(p, base));
    else files.push(path.relative(base, p));
  }
  return files;
}

await step("init: writes .env (MCP token + optional API key), copies whole template, scaffolds config", async () => {
  const target = path.join(TMP, "init-target");
  // piped init prompts in order: host, MCP token (paste fallback — no TTY, no
  // browser consent), optional API key
  const pending = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  pending.child.stdin!.write(`${env.N8N_HOST}\n${MCP_TOKEN}\ntest-key\n`);
  pending.child.stdin!.end();
  const { stdout, stderr } = await pending;
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\nN8N_MCP_TOKEN=${MCP_TOKEN}\n`);
  // the ENTIRE template must be copied, whatever it contains; `X.example`
  // materializes as `X` (inert in the repo, live in the target)
  const templateDir = path.join(PROJECT, "template");
  const templateFiles = listFilesRecursive(templateDir);
  assert.ok(templateFiles.length > 0, "template must not be empty");
  const materialize = (rel: string) => (rel.endsWith(".example") ? rel.slice(0, -".example".length) : rel);
  for (const rel of templateFiles) {
    const destRel = materialize(rel);
    assert.ok(existsSync(path.join(target, destRel)), `template file not copied: ${rel} -> ${destRel}`);
    // .env pre-exists (init wrote credentials), so the template copy is skipped there
    if (destRel !== ".env") {
      assert.equal(read(target, destRel), read(templateDir, rel), `content mismatch: ${rel} -> ${destRel}`);
    }
  }
  assert.ok(existsSync(path.join(target, "workflows")), "workflows dir copied");
  assert.equal(JSON.parse(read(target, "decanter.config.json")).root, "./workflows");
  assert.match(read(target, ".gitignore"), /^\.env$/m);
  assert.match(read(target, ".gitignore"), /^\.decanter-auth\.json$/m);
  assert.match(read(target, ".gitignore"), /^workflows\/\*\/executions\/$/m);
  assert.match(read(target, ".gitignore"), /^data-tables\/$/m);
  // both credential probes ran against the mock
  assert.match(stdout + stderr, /MCP connection verified — \d+ workflows? visible/);
  assert.match(stdout + stderr, /API key verified/);
  // piped init prints a plain version line instead of the TTY logo
  assert.match(stdout + stderr, /n8n-decanter v\d+\.\d+\.\d+/);
  assert.ok(!(stdout + stderr).includes("\x1b"), "init must not emit ANSI when piped");
  // init records a copy-time baseline manifest (.decanter-template.json) that
  // tracks every materialized template file *except* the credential-bearing .env
  const manifest = JSON.parse(read(target, ".decanter-template.json")) as { version: string; files: Record<string, string> };
  const expectedKeys = templateFiles.map(materialize).filter((r) => r !== ".env").sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), expectedKeys, "manifest tracks all template files but .env");
  assert.ok(!("env" in manifest.files) && !(".env" in manifest.files), ".env must never be manifest-tracked");
  // re-init must not clobber user edits to template-provided files, and must
  // report the drift instead (modification-aware refresh)
  const probe = materialize(templateFiles.find((f) => materialize(f) !== ".env")!);
  writeFileSync(path.join(target, probe), "user content\n");
  const again = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  again.child.stdin!.end(); // complete .env → nothing is asked
  const againResult = await again;
  assert.equal(read(target, probe), "user content\n");
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\nN8N_MCP_TOKEN=${MCP_TOKEN}\n`);
  assert.match(againResult.stdout + againResult.stderr, /using existing \.env host/);
  assert.match(againResult.stdout + againResult.stderr, /using existing MCP token/);
  assert.ok((againResult.stdout + againResult.stderr).includes(`left unchanged (modified locally): ${probe}`), "re-init must report the modified file as drift");
  // init --force re-copies template files over existing ones (.env protected),
  // flagging the ones that had local changes
  const forced = execFile(process.execPath, [CLI, "init", target, "--force"], { encoding: "utf8" });
  forced.child.stdin!.end();
  const forcedResult = await forced;
  assert.ok((forcedResult.stdout + forcedResult.stderr).includes(`--force: overwrote ${probe} with the template version (had local changes)`), "--force must flag clobbered local edits");
  const probeTemplateRel = templateFiles.find((f) => materialize(f) === probe)!;
  assert.equal(read(target, probe), read(templateDir, probeTemplateRel), "--force must restore the template version");
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\nN8N_MCP_TOKEN=${MCP_TOKEN}\n`, ".env must survive --force");
});

await step("init: credential probes — skipped MCP, non-2xx and unreachable API outcomes get their own log lines", async () => {
  // non-2xx: a real server that answers, but rejects
  const rejecting = http.createServer((_req, res) => void res.writeHead(403).end("nope"));
  await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", () => resolve()));
  const rejectingPort = (rejecting.address() as import("node:net").AddressInfo).port;
  try {
    const target = path.join(TMP, "init-target-probe-403");
    const pending = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
    pending.child.stdin!.write(`http://127.0.0.1:${rejectingPort}\n\nsome-key\n`); // blank MCP token = skip
    pending.child.stdin!.end();
    const { stdout, stderr } = await pending;
    assert.match(stdout + stderr, /no MCP credentials yet/);
    assert.match(stdout + stderr, /API key check failed \(403 Forbidden\) — \.env written anyway/);
  } finally {
    rejecting.close();
  }

  // unreachable: nothing listens on this port — the same catch branch (and
  // log line shape) a real fetch timeout would hit; init's probe timeout is
  // a fixed 10s, too slow to exercise directly in an offline suite
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const deadPort = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const target = path.join(TMP, "init-target-probe-unreachable");
  const pending = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  pending.child.stdin!.write(`http://127.0.0.1:${deadPort}\n\nsome-key\n`);
  pending.child.stdin!.end();
  const { stdout, stderr } = await pending;
  assert.match(stdout + stderr, /could not reach http:\/\/127\.0\.0\.1:\d+ \([^)]*\) — \.env written anyway/);
});

await step("bare invocation piped: usage, never the interactive picker", async () => {
  // Plan 19's picker is TTY-gated; this whole suite runs the CLI piped, so a
  // bare run in an inited project must keep printing plain usage text
  const r = await cli();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Usage:/);
  assert.ok(!r.out.includes("type to filter"), "picker UI leaked into piped output");
});

await step("pull: creates folder, kebab-case files in code/, placeholders, state (via MCP details)", async () => {
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  // derived/permission fields stay out of workflow.json — the file holds the
  // workflow itself, code exists exactly once (in code/)
  assert.ok(!read(dir1, "workflow.json").includes("activeVersion"), "activeVersion stripped");
  assert.ok(!read(dir1, "workflow.json").includes('"shared"'), "shared stripped");
  assert.ok(!read(dir1, "workflow.json").includes('"scopes"'), "scopes stripped");
  assert.ok(!read(dir1, "workflow.json").includes('"canExecute"'), "canExecute stripped");
  assert.equal(read(dir1, "code", "transform.js"), JS_CODE);
  assert.equal(read(dir1, "code", "amazon-feed.js"), "return $input.all();\n");
  const wfJson = read(dir1, "workflow.json");
  assert.match(wfJson, /"\/\/@file:code\/transform\.js"/);
  assert.match(wfJson, /"\/\/@file:code\/amazon-feed\.js"/);
  const s = state(dir1);
  assert.equal(s.workflowId, "wf123");
  assert.equal(s.nodes.n2.file, "code/transform.js");
  assert.equal(s.nodes.n2.name, "Transform", "node display name cached (Plan 32)");
  assert.match(s.nodes.n2.lastPushedHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(s.lastPulledWorkflowHash, undefined, "structural hashing is gone (Plan 32)");
});

await step("push unchanged: no-op — code already in sync, remote untouched", async () => {
  const before = remoteNode("wf123", "n2").parameters.jsCode;
  const r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /"Order Sync" \(wf123\): code already in sync — nothing to push/);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, before);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, JS_CODE);
});

await step("push: a code edit lands on the DRAFT only; --publish takes it live", async () => {
  const js = path.join(dir1, "code", "transform.js");
  writeFileSync(js, JS_CODE + "// draft edit\n");
  let r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pushed "Order Sync" \(wf123\) — 1 node — draft updated; the live version is unchanged \(run "publish" to go live\)/);
  assert.match(remoteNode("wf123", "n2").parameters.jsCode, /draft edit/);
  // merge semantics: a {jsCode}-only write preserves sibling params
  assert.equal(remoteNode("wf123", "n1").parameters.path, "orders", "untouched nodes stay untouched");
  // restore and take it live in one go
  writeFileSync(js, JS_CODE);
  r = await cli("push", "--publish");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pushed "Order Sync" \(wf123\)/);
  assert.match(r.out, /published "Order Sync" \(wf123\) — code is live now/);
  assert.equal(db.get("wf123").activeVersionId, db.get("wf123").versionId);
});

await step("pre-code/ layout migrates on pull; check flags it before", async () => {
  // simulate the old flat layout for one node: file at the folder root
  renameSync(path.join(dir1, "code", "transform.js"), path.join(dir1, "Transform.js"));
  const s = state(dir1);
  s.nodes.n2.file = "Transform.js";
  writeFileSync(path.join(dir1, ".decanter.json"), JSON.stringify(s, null, 2) + "\n");
  writeFileSync(path.join(dir1, "workflow.json"), read(dir1, "workflow.json").replace("//@file:code/transform.js", "//@file:Transform.js"));
  let r = await cli("check");
  assert.equal(r.code, 1, "old layout must fail the compliance check: " + r.out);
  assert.match(r.out, /sits outside code\//);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /renamed Transform\.js -> code\/transform\.js/);
  assert.equal(read(dir1, "code", "transform.js"), JS_CODE);
  assert.ok(!existsSync(path.join(dir1, "Transform.js")), "old flat file must be gone");
  assert.equal(state(dir1).nodes.n2.file, "code/transform.js");
  assert.match(read(dir1, "workflow.json"), /"\/\/@file:code\/transform\.js"/);
  r = await cli("check");
  assert.equal(r.code, 0, r.out);
});

const TS_SOURCE = 'interface FeedRow { sku: string; qty: number }\nconst rows: FeedRow[] = $input.all().map((i) => ({ sku: String(i.json.sku), qty: Number(i.json.qty) }));\nreturn rows.map((r) => ({ json: { ...r } }));\n';

await step("convert node to .ts + push: compiles, appends marker (placeholder re-point drives the file map)", async () => {
  unlinkSync(path.join(dir1, "code", "amazon-feed.js"));
  writeFileSync(path.join(dir1, "code", "amazon-feed.ts"), TS_SOURCE);
  writeFileSync(path.join(dir1, "workflow.json"), read(dir1, "workflow.json").replace("//@file:code/amazon-feed.js", "//@file:code/amazon-feed.ts"));
  const r = await cli("push");
  assert.equal(r.code, 0, r.out);
  const code = remoteNode("wf123", "n3").parameters.jsCode;
  assert.match(code, /\n\/\/ @ts-n8n sha256:[0-9a-f]{64}$/);
  assert.ok(!code.includes("FeedRow[]"), "types must be stripped");
  assert.ok(code.includes("rows.map"), "logic must survive");
  assert.equal(state(dir1).nodes.n3.file, "code/amazon-feed.ts");
});

await step("pull after ts push: in sync, .ts untouched, no .remote.js artifacts", async () => {
  const before = read(dir1, "code", "amazon-feed.ts");
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir1, "code", "amazon-feed.ts"), before);
  assert.ok(!existsSync(path.join(dir1, "code", "amazon-feed.remote.js")));
  assert.match(read(dir1, "workflow.json"), /"\/\/@file:code\/amazon-feed\.ts"/);
});

await step("remote UI edit on ts node: push aborts on code drift; pull warns (no .remote.js) and re-baselines", async () => {
  const node = remoteNode("wf123", "n3");
  node.parameters.jsCode = node.parameters.jsCode.replace("return rows.map", "// hotfix from UI\nreturn rows.map");
  let r = await cli("push");
  assert.equal(r.code, 1, "push must abort on drift");
  assert.match(r.out, /remote code changed since last sync/);
  assert.match(r.out, /pull first/);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /edited in the n8n UI since last push/);
  assert.match(r.out, /status --diff/);
  assert.ok(!existsSync(path.join(dir1, "code", "amazon-feed.remote.js")), "no conflict artifact since Plan 32");
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
  assert.match(r.out, /keeping your \.ts/);
  assert.equal(read(dir1, "code", "amazon-feed.ts"), TS_SOURCE);
  assert.ok(!existsSync(path.join(dir1, "code", "amazon-feed.remote.js")), "no conflict artifact since Plan 32");
  const r2 = await cli("push");
  assert.equal(r2.code, 0, r2.out);
  assert.match(remoteNode("wf123", "n3").parameters.jsCode, /\/\/ @ts-n8n sha256:/);
});

await step("structure changed remotely: never blocks push; status hints; pull refreshes the snapshot", async () => {
  const wf = db.get("wf123");
  wf.nodes.push({ id: "n4", name: "Set", type: "n8n-nodes-base.set", typeVersion: 3, position: [660, 0], parameters: {} });
  // structure is n8n's job (Plan 32): status only hints, exit stays 0
  let r = await cli("status");
  assert.equal(r.code, 0, "a structure-only remote change is not drift: " + r.out);
  assert.match(r.out, /structure snapshot out of date — pull to refresh/);
  // push proceeds — it writes jsCode only, structure is untouched
  r = await cli("push");
  assert.equal(r.code, 0, "push must not block on remote structure changes: " + r.out);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(read(dir1, "workflow.json"), /"n4"/);
  r = await cli("status");
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("snapshot out of date"), "refreshed snapshot clears the hint: " + r.out);
});

await step("status: reports pending local edit, then in sync", async () => {
  const js = path.join(dir1, "code", "transform.js");
  writeFileSync(js, read(dir1, "code", "transform.js") + "// local tweak\n");
  let r = await cli("status");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync \(wf123\).*published/);
  assert.match(r.out, /Transform: local changes in code\/transform\.js — push pending/);
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(remoteNode("wf123", "n2").parameters.jsCode, /local tweak/);
  r = await cli("status");
  assert.match(r.out, /Transform: in sync/);
});

await step("remote workflow rename: folder is sticky, name cached; node rename still renames the file", async () => {
  const wf = db.get("wf123");
  wf.name = "Order Sync v2";
  wf.nodes.find((n: any) => n.id === "n2").name = "Transform: EU/US";
  // n8n rewrites connections on rename; the mock must mirror that
  wf.connections.Webhook.main[0][0].node = "Transform: EU/US";
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  // Plan 27: the folder does NOT follow a remote rename — it stays the sticky
  // `order-sync` slug (dir1); the display name is cached in .decanter.json.
  assert.ok(existsSync(dir1), "sticky folder kept");
  assert.ok(!existsSync(wfDir("Order Sync v2")), "no renamed folder created");
  assert.equal(state(dir1).name, "Order Sync v2", ".decanter.json caches the current display name");
  // node rename still renames the file — the id-keyed map is the identity
  // anchor (Plan 32 Task 3): ids survive renames, files follow names
  assert.ok(existsSync(path.join(dir1, "code", "transform-eu-us.js")), "file renamed with kebab-case name");
  assert.ok(!existsSync(path.join(dir1, "code", "transform.js")));
  assert.equal(state(dir1).nodes.n2.file, "code/transform-eu-us.js");
  assert.equal(state(dir1).nodes.n2.name, "Transform: EU/US", "cached node name follows");
  assert.match(read(dir1, "workflow.json"), /"\/\/@file:code\/transform-eu-us\.js"/);
});

await step("watch path: pushSingleNode round-trip (MCP, addressed by current remote name)", async () => {
  const { pushSingleNode } = await import(pathToFileURL(path.join(PROJECT, "lib/push.mts")).href);
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  writeFileSync(path.join(dir2, "code", "transform-eu-us.js"), "return $input.all(); // watched\n");
  const log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };
  await pushSingleNode(await mcpClient(), dir2, "n2", {}, log);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, "return $input.all(); // watched\n");
});

await step("watch: takes a workflow id, errors on an unknown one before watching", async () => {
  const r = await cli("watch", "nope");
  assert.equal(r.code, 1);
  assert.match(r.out, /workflow nope not found/);
});

await step("watch: debounce coalesces, queued save re-pushes, close() stops", async () => {
  // in-process (like the pushSingleNode step): the WatchHandle exists for this
  const { watchWorkflow } = await import(pathToFileURL(path.join(PROJECT, "lib/watch.mts")).href);
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const js = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  const config = {
    configDir: TMP, root: ROOT, workflows: ["wf123"], commitOnPush: false, commitOnPull: false,
    browserReload: "off" as const, proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, host: env.N8N_HOST!, apiKey: "test-key",
  };
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), ok: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(`E ${m}`) };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // TMP is not a git repo yet at this point — watch skips the startup pull
  const handle = await watchWorkflow(await mcpClient(), config, "wf123", {}, log);
  const before = updateCount;
  try {
    // two rapid saves coalesce into a single push of the final content
    writeFileSync(js, "return $input.all(); // debounce-1\n");
    await sleep(30);
    writeFileSync(js, "return $input.all(); // debounce-2\n");
    await sleep(900);
    assert.equal(updateCount - before, 1, "rapid saves must coalesce into one push:\n" + logs.join("\n"));
    assert.match(remoteNode("wf123", "n2").parameters.jsCode, /debounce-2/);
    // a save landing while a push is in flight is queued and re-pushed
    slowUpdateMs = 300;
    writeFileSync(js, "return $input.all(); // queued-1\n");
    await sleep(320); // debounce fired, update held open
    writeFileSync(js, "return $input.all(); // queued-2\n");
    await sleep(1500);
    slowUpdateMs = 0;
    assert.equal(updateCount - before, 3, "queued save must trigger a follow-up push:\n" + logs.join("\n"));
    assert.match(remoteNode("wf123", "n2").parameters.jsCode, /queued-2/);
    // restore the synced content through watch itself, then stop
    writeFileSync(js, original);
    await sleep(900);
    assert.equal(updateCount - before, 4, "restore push:\n" + logs.join("\n"));
  } finally {
    slowUpdateMs = 0;
    await handle.close();
  }
  writeFileSync(js, original + "// after-close\n");
  await sleep(600);
  assert.equal(updateCount - before, 4, "no push after close()");
  writeFileSync(js, original); // silent restore — the watcher is closed
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, original);
});

await step("watch: workflow.json is a read-only snapshot — a save warns once, pushes nothing", async () => {
  const { watchWorkflow } = await import(pathToFileURL(path.join(PROJECT, "lib/watch.mts")).href);
  const dir2 = dir1;
  const wfJsonPath = path.join(dir2, "workflow.json");
  const config = {
    configDir: TMP, root: ROOT, workflows: ["wf123"], commitOnPush: false, commitOnPull: false,
    browserReload: "off" as const, proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, host: env.N8N_HOST!, apiKey: "test-key",
  };
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), ok: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(`E ${m}`) };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const handle = await watchWorkflow(await mcpClient(), config, "wf123", {}, log);
  const before = updateCount;
  const savedJson = read(wfJsonPath);
  try {
    assert.ok(logs.some((m) => m.includes('run "n8n-decanter publish" to take changes live')), "draft-only note at start:\n" + logs.join("\n"));
    const localWf = JSON.parse(savedJson);
    localWf.nodes.find((n: any) => n.id === "n2").position = [9999, 9999];
    writeFileSync(wfJsonPath, JSON.stringify(localWf, null, 2));
    await sleep(500);
    assert.ok(logs.some((m) => m.includes("read-only structure snapshot")), "snapshot warning:\n" + logs.join("\n"));
    assert.equal(updateCount, before, "a workflow.json save must never push");
    assert.deepEqual(remoteNode("wf123", "n2").position, [220, 0], "remote structure untouched");
    // only the first save warns
    const warnings = logs.filter((m) => m.includes("read-only structure snapshot")).length;
    writeFileSync(wfJsonPath, read(wfJsonPath));
    await sleep(400);
    assert.equal(logs.filter((m) => m.includes("read-only structure snapshot")).length, warnings, "warns once per session");
  } finally {
    writeFileSync(wfJsonPath, savedJson);
    await handle.close();
  }
});

await step("watch<->proxy: single-node push broadcasts a 'pushed' SSE event through the dev-reload proxy", async () => {
  const { watchWorkflow } = await import(pathToFileURL(path.join(PROJECT, "lib/watch.mts")).href);
  await cli("pull"); // fresh baseline
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const js = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(js);
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), ok: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(`E ${m}`) };
  const config = {
    configDir: TMP, root: ROOT, workflows: ["wf123"], commitOnPush: false, commitOnPull: false,
    browserReload: "proxy" as const, proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, host: env.N8N_HOST!, apiKey: "test-key",
  };

  const handle = await watchWorkflow(await mcpClient(), config, "wf123", {}, log);
  try {
    // deep link must go through the proxy — a different port than the raw upstream
    const proxyUrlMatch = logs.join("\n").match(/http:\/\/127\.0\.0\.1:(\d+)\/workflow\/wf123/);
    assert.ok(proxyUrlMatch, "editor deep-link through the proxy:\n" + logs.join("\n"));
    const proxyPort = proxyUrlMatch![1];
    assert.notEqual(proxyPort, new URL(env.N8N_HOST!).port, "editor link must use the proxy port, not the raw upstream host");

    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${proxyPort}/__decanter/events`, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          buf += c;
          // only save the code file once the SSE stream is actually live
          if (buf.includes(": connected")) writeFileSync(js, original + "// proxied push\n");
          if (buf.includes("event: pushed")) {
            req.destroy();
            resolve(buf);
          }
        });
        res.on("error", () => {}); // req.destroy() surfaces the abort here — ignore
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("no pushed SSE event within 3s:\n" + logs.join("\n"))), 3000).unref();
    });
    assert.match(received, /event: pushed/);
    assert.match(received, /"workflowId":"wf123"/);
    assert.match(remoteNode("wf123", "n2").parameters.jsCode, /proxied push/, "the save that triggered the SSE event actually pushed:\n" + logs.join("\n"));
  } finally {
    writeFileSync(js, original);
    await handle.close();
  }
  await cli("pull"); // re-baseline
});

await step("check: clean tree passes, typecheck skipped without tsconfig", async () => {
  const r = await cli("check");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  assert.match(r.out, /no tsconfig\.json found — skipping typecheck/);
});

await step("guard: inline code in workflow.json blocks push", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const wfJson = read(dir2, "workflow.json");
  writeFileSync(path.join(dir2, "workflow.json"), wfJson.replace('"//@file:code/transform-eu-us.js"', '"return 1;"'));
  let r = await cli("push");
  assert.equal(r.code, 1, "push must abort on inline code");
  assert.match(r.out, /inline code/);
  assert.match(r.out, /does not comply/);
  r = await cli("check");
  assert.equal(r.code, 1);
  assert.match(r.out, /inline code/);
  writeFileSync(path.join(dir2, "workflow.json"), wfJson);
});

await step("guard: @ts-n8n marker inside a .js file blocks push", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const file = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  writeFileSync(file, original + "// @ts-n8n sha256:" + "0".repeat(64) + "\n");
  const r = await cli("push");
  assert.equal(r.code, 1, "push must abort on marker in .js");
  assert.match(r.out, /@ts-n8n marker/);
  writeFileSync(file, original);
});

await step("guard: pre-Plan-32 .remote.js leftovers warn but don't block", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const leftover = path.join(dir2, "code", "transform-eu-us.remote.js");
  writeFileSync(leftover, "// leftover from a conflict\n");
  const r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unresolved remote copy code\/transform-eu-us\.remote\.js/);
  unlinkSync(leftover);
});

await step("guard: typecheck gate blocks type errors, --no-typecheck bypasses", async () => {
  writeFileSync(path.join(TMP, "n8n-globals.d.ts"), readFileSync(path.join(PROJECT, "n8n-globals.d.ts"), "utf8"));
  writeFileSync(path.join(TMP, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "CommonJS", moduleResolution: "Node", lib: ["ES2022"], allowJs: true, checkJs: true, noEmit: true, strict: true, skipLibCheck: true },
    include: ["n8n-globals.d.ts", "workflows/**/*.ts", "workflows/**/*.js"],
    exclude: ["**/*.remote.js"],
  }, null, 2));
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const file = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  writeFileSync(file, '// @ts-check\nconst bad = "x" * 2;\nreturn [{ json: { bad } }];\n');
  let r = await cli("push");
  assert.equal(r.code, 1, "push must abort on type error");
  assert.match(r.out, /typecheck failed/);
  r = await cli("push", "--no-typecheck");
  assert.equal(r.code, 0, "--no-typecheck must bypass the gate: " + r.out);
  writeFileSync(file, original);
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /typecheck OK/);
});

await step("check <id>: scopes layout checks and typecheck to that workflow", async () => {
  // a second, broken workflow that must stay invisible to a scoped check
  const dirB = wfDir("Broken Neighbor");
  mkdirSync(path.join(dirB, "code"), { recursive: true });
  writeFileSync(path.join(dirB, ".decanter.json"), JSON.stringify({ workflowId: "wfBroken", nodes: { b1: { file: "code/bad.js" } } }));
  writeFileSync(path.join(dirB, "workflow.json"), JSON.stringify({
    nodes: [{ id: "b1", name: "Bad", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { jsCode: "//@file:code/bad.js" } }],
    connections: {},
  }));
  writeFileSync(path.join(dirB, "code", "bad.js"), '// @ts-check\nconst bad = "x" * 2;\nreturn [{ json: { bad } }];\n');
  let r = await cli("check");
  assert.equal(r.code, 1, "unscoped check must fail on the broken neighbor: " + r.out);
  assert.match(r.out, /bad\.js/);
  r = await cli("check", "wf123");
  assert.equal(r.code, 0, "scoped check must not see the broken neighbor: " + r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  assert.match(r.out, /typecheck OK/);
  assert.ok(!r.out.includes("Broken Neighbor"), "unrelated workflow leaked into scoped output: " + r.out);
  assert.ok(!r.out.includes("bad.js"), "unrelated diagnostics leaked into scoped output: " + r.out);
  // a type error in the scoped workflow itself must still surface
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const file = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  writeFileSync(file, '// @ts-check\nconst broken = "x" * 2;\nreturn [{ json: { broken } }];\n');
  r = await cli("check", "wf123");
  assert.equal(r.code, 1, "scoped check must still catch errors in its own workflow");
  assert.match(r.out, /transform-eu-us\.js/);
  writeFileSync(file, original);
  rmSync(dirB, { recursive: true, force: true });
});

await step("commit-on-push: warns outside a repo, commits scoped inside one", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: ["wf123"], commitOnPush: true, commitOnPull: true }, null, 2));
  // outside a git repo: push succeeds and warns
  writeFileSync(path.join(dir2, "code", "transform-eu-us.js"), "return $input.all(); // v-git-1\n");
  let r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skipping commit/);
  // inside a repo: commit happens, scoped to the workflow folder
  await execFile("git", ["init"], { cwd: TMP });
  await execFile("git", ["-C", TMP, "config", "user.email", "e2e@test"]);
  await execFile("git", ["-C", TMP, "config", "user.name", "e2e"]);
  await execFile("git", ["-C", TMP, "config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(TMP, "unrelated.txt"), "not part of any workflow\n");
  writeFileSync(path.join(dir2, "code", "transform-eu-us.js"), "return $input.all(); // v-git-2\n");
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /committed: decanter: pushed "Order Sync v2" \(wf123\)/);
  const { stdout: committed } = await execFile("git", ["-C", TMP, "show", "--name-only", "--format="], { encoding: "utf8" });
  for (const file of committed.trim().split("\n")) {
    assert.match(file, /^workflows\/order-sync\//, `commit must only contain the workflow folder, found: ${file}`);
  }
  const { stdout: status } = await execFile("git", ["-C", TMP, "status", "--porcelain", "--", "unrelated.txt"], { encoding: "utf8" });
  assert.match(status, /^\?\? unrelated\.txt/m, "unrelated file must stay uncommitted and unstaged");
  // pushing without changes must not create an empty commit
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  const { stdout: count } = await execFile("git", ["-C", TMP, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  assert.equal(count.trim(), "1", "no empty follow-up commit");
  // pull commits too (commitOnPull); a remote rename refreshes the cached name +
  // workflow.json but the folder stays put (sticky, Plan 27).
  db.get("wf123").name = "Order Sync v3";
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /committed: decanter: pulled "Order Sync v3" \(wf123\)/);
  assert.ok(existsSync(dir1) && !existsSync(wfDir("Order Sync v3")), "folder stays put on remote rename");
  assert.equal(state(dir1).name, "Order Sync v3", "cached display name follows the rename");
  let { stdout: dirty } = await execFile("git", ["-C", TMP, "status", "--porcelain", "--", "workflows"], { encoding: "utf8" });
  assert.equal(dirty.trim(), "", "rename pull must leave no uncommitted changes under workflows/");
  // rename back so later steps keep their folder; must stay clean too
  db.get("wf123").name = "Order Sync v2";
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  ({ stdout: dirty } = await execFile("git", ["-C", TMP, "status", "--porcelain", "--", "workflows"], { encoding: "utf8" }));
  assert.equal(dirty.trim(), "", "rename-back pull must leave a clean tree");
});

await step("verb-first grammar: verb is positional[0]; verb-last errors; a workflow named like a verb resolves", async () => {
  let r = await cli("status", "wf123");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /: in sync/);
  // flags may sit anywhere among the arguments
  r = await cli("check", "--no-typecheck", "wf123");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  // verb-last is no longer accepted — slot 0 must be a known verb
  r = await cli("wf123", "status");
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown verb: wf123/);
  // a workflow literally named like a verb is just an argument now (no id-only caveat)
  db.set("wfPush", { ...structuredClone(db.get("wf123")), id: "wfPush", name: "push" });
  try {
    r = await cli("pull", "push"); // resolves the remote workflow named "push"
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(wfDir("push")), "pulled the workflow named push: " + r.out);
    r = await cli("status", "push"); // status on the workflow named push, not the verb
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /: in sync/);
  } finally {
    rmSync(wfDir("push"), { recursive: true, force: true });
    db.delete("wfPush");
  }
});

await step("name refs: exact name and case-insensitive prefix resolve; unknown name lists candidates", async () => {
  let r = await cli("status", "Order Sync v2");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /: in sync/);
  r = await cli("check", "order sy", "--no-typecheck"); // unique case-insensitive prefix
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  r = await cli("push", "Order Sync v2", "--no-typecheck"); // name push ≡ id push
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /"Order Sync v2" \(wf123\): code already in sync/);
  // name-shaped ref with no match must error with the candidate list — no prompt
  r = await cli("status", "No Such Flow");
  assert.equal(r.code, 1);
  assert.match(r.out, /no workflow matches "No Such Flow"/);
  assert.match(r.out, /"Order Sync v2"/);
});

await step("multi-workflow: one id fails, [i/n] progress shown, exit 1, the rest still processed", async () => {
  // an id that resolves (id-shaped, no local/remote match needed) but was
  // never pulled, ahead of a real one — proves a mid-list failure doesn't
  // stop the loop, and the overall exit code still reflects it
  const r = await cli("push", "--no-typecheck", "wf-not-pulled", "wf123");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\[1\/2\] wf-not-pulled: workflow wf-not-pulled not found under .* — pull it first/);
  assert.match(r.out, /\[2\/2\].*code already in sync/, "the item after the failure must still be processed: " + r.out);
});

await step("resolveRef: pull resolves an unpulled remote workflow by name (MCP search); a shared local prefix is ambiguous", async () => {
  db.set("wfZ1", { ...structuredClone(db.get("wf123")), id: "wfZ1", name: "Zeta Flow One" });
  db.set("wfZ2", { ...structuredClone(db.get("wf123")), id: "wfZ2", name: "Zeta Flow Two" });
  try {
    // only `pull` falls back to the remote workflow list to resolve a name
    // that isn't pulled locally yet (push/status don't — they'd need the
    // folder to already exist)
    let r = await cli("pull", "Zeta Flow One");
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(wfDir("Zeta Flow One")), "pulled by remote name: " + r.out);
    r = await cli("pull", "wfZ2");
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(wfDir("Zeta Flow Two")), r.out);

    // now that both are pulled locally, a shared name prefix is ambiguous — no prompt, just an error
    r = await cli("status", "Zeta Flow");
    assert.equal(r.code, 1);
    assert.match(r.out, /ambiguous workflow "Zeta Flow"/);
    assert.match(r.out, /"Zeta Flow One" \(wfZ1\)/);
    assert.match(r.out, /"Zeta Flow Two" \(wfZ2\)/);
  } finally {
    rmSync(wfDir("Zeta Flow One"), { recursive: true, force: true });
    rmSync(wfDir("Zeta Flow Two"), { recursive: true, force: true });
    db.delete("wfZ1");
    db.delete("wfZ2");
  }
});

await step("list: pulled + --remote over MCP; unavailable workflows marked with guidance; --json carries mcpAvailable", async () => {
  let r = await cli("list");
  assert.equal(r.code, 0, r.out);
  // display name is the cached "Order Sync v2"; folder is the sticky order-sync slug
  assert.match(r.out, /Order Sync v2 {2}wf123 {2}workflows[/\\]order-sync/);
  db.set("wf777", { ...structuredClone(db.get("wf123")), id: "wf777", name: "Unpulled Flow" });
  db.set("wf778", { ...structuredClone(db.get("wf123")), id: "wf778", name: "Gated Flow", availableInMCP: false });
  try {
    r = await cli("list", "--remote");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Unpulled Flow {2}wf777 {2}\(not pulled\)/);
    assert.match(r.out, /Gated Flow {2}wf778 {2}\(not available in MCP\)/);
    assert.match(r.out, /enable MCP access from the workflow card/);
    assert.match(r.out, /Order Sync v2 {2}wf123/);
    // --json: pulled rows carry a dir; remote-only rows are dir:null + mcpAvailable
    r = await cli("list", "--remote", "--json");
    assert.equal(r.code, 0, r.out);
    const rows = JSON.parse(r.out) as Array<{ name: string; id: string; dir: string | null; mcpAvailable?: boolean }>;
    const pulled = rows.find((x) => x.id === "wf123");
    assert.ok(pulled && pulled.name === "Order Sync v2" && /order-sync/.test(pulled.dir ?? ""), "pulled row: " + r.out);
    const unpulled = rows.find((x) => x.id === "wf777");
    assert.ok(unpulled && unpulled.dir === null && unpulled.mcpAvailable === true, "remote-only row has dir:null + mcpAvailable: " + r.out);
    const gated = rows.find((x) => x.id === "wf778");
    assert.ok(gated && gated.mcpAvailable === false, "gated row marked: " + r.out);
  } finally {
    db.delete("wf777");
    db.delete("wf778");
  }
});

await step("pull: an MCP-unavailable workflow errors with the server text + enable guidance", async () => {
  db.set("wfGate", { ...structuredClone(db.get("wf123")), id: "wfGate", name: "Gate Keeper", availableInMCP: false });
  try {
    const r = await cli("pull", "wfGate");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Workflow is not available in MCP/);
    assert.match(r.out, /enable MCP access from the workflow card/);
    assert.ok(!existsSync(wfDir("Gate Keeper")), "no folder for a refused pull");
  } finally {
    db.delete("wfGate");
  }
});

await step("completion: prints shell scripts; __complete emits verbs, flags, names, ids", async () => {
  let r = await cli("completion", "zsh");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /compdef _n8n_decanter n8n-decanter/);
  r = await cli("completion", "bash");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /complete -F _n8n_decanter n8n-decanter/);
  const bashScript = path.join(TMP, "completion.bash");
  writeFileSync(bashScript, r.out);
  try {
    await execFile("bash", ["-n", bashScript]); // syntax-check when bash exists
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  r = await cli("completion");
  assert.equal(r.code, 1, "completion without a shell must fail");
  r = await cli("__complete");
  assert.equal(r.code, 0, r.out);
  const words = r.out.trim().split("\n");
  for (const w of ["pull", "push", "watch", "list", "node", "create", "rename", "run", "--force", "--publish", "wf123", "Order Sync v2"]) {
    assert.ok(words.includes(w), `__complete must emit "${w}": ${r.out}`);
  }
  assert.ok(!words.includes("__complete"), "__complete must not advertise itself");
  // moved/removed surfaces must not linger in completion (Plan 27)
  assert.ok(!words.includes("--workflow"), "--workflow was removed");
  assert.ok(!words.includes("add"), "add moved to `node create`");
});

await step("mcp timeout: a hung instance aborts with a clear error", async () => {
  const cfg = read(TMP, "decanter.config.json");
  writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ ...JSON.parse(cfg), requestTimeoutMs: 300 }));
  try {
    const r = await cli("status", "wf-hang");
    assert.equal(r.code, 1, "timeout must exit 1: " + r.out);
    assert.match(r.out, /timed out after 0\.3s/);
    assert.match(r.out, /requestTimeoutMs/);
  } finally {
    writeFileSync(path.join(TMP, "decanter.config.json"), cfg);
  }
});

await step("DEBUG=1 prints the stack trace on errors", async () => {
  const r = await cli("definitely-not-a-verb");
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes("    at "), "no stack without DEBUG: " + r.out);
  try {
    await execFile(process.execPath, [CLI, "definitely-not-a-verb"], { cwd: TMP, env: { ...env, DEBUG: "1" }, encoding: "utf8" });
    assert.fail("must exit non-zero");
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    assert.match((e.stdout ?? "") + (e.stderr ?? ""), / {4}at /, "DEBUG=1 must include the stack");
  }
});

const runOutput = (out: string) => {
  // The printed items are the last JSON array on stdout; cli() appends stderr
  // (e.g. warnings) afterwards, so bound the slice by the final closing bracket.
  const start = out.indexOf("[", out.indexOf("returned"));
  return JSON.parse(out.slice(start, out.lastIndexOf("]") + 1));
};

await step("run: executes a .ts node against a fixture (all-items)", async () => {
  const rd = path.join(TMP, "runtest");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "Gen.ts"),
    "interface Row { id: number }\nconst rows: Row[] = $input.all().map((i) => ({ id: Number(i.json.id) }));\nreturn rows.map((r) => ({ json: r }));\n");
  writeFileSync(path.join(rd, "fx.json"), JSON.stringify({ input: [{ json: { id: 5 } }, { json: { id: 9 } }] }));
  const r = await cli("node", "run", path.join("runtest", "Gen.ts"), path.join("runtest", "fx.json"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /runOnceForAllItems/);
  assert.match(r.out, /returned 2 items/);
  assert.deepEqual(runOutput(r.out), [{ json: { id: 5 } }, { json: { id: 9 } }]);
});

await step("run: each-item mode (from workflow.json) loops per input item", async () => {
  const rd = path.join(TMP, "runtest2");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "workflow.json"), JSON.stringify({
    nodes: [{ id: "x", name: "Dbl", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0],
      parameters: { mode: "runOnceForEachItem", jsCode: "//@file:Dbl.js" } }],
  }));
  writeFileSync(path.join(rd, "Dbl.js"), "return { json: { n: $json.n * 2, i: $itemIndex } };\n");
  writeFileSync(path.join(rd, "fx.json"), JSON.stringify({ input: [{ json: { n: 2 } }, { json: { n: 5 } }] }));
  const r = await cli("node", "run", path.join("runtest2", "Dbl.js"), path.join("runtest2", "fx.json"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /runOnceForEachItem/);
  assert.deepEqual(runOutput(r.out), [{ json: { n: 4, i: 0 } }, { json: { n: 10, i: 1 } }]);
});

await step("run: resolves workflow.json from the parent of code/", async () => {
  writeFileSync(path.join(TMP, "fx-run.json"), JSON.stringify({ input: [{ json: { a: 1 } }, { json: { a: 2 } }] }));
  const r = await cli("node", "run", path.join("workflows", "order-sync", "code", "transform-eu-us.js"), "fx-run.json");
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("no workflow.json placeholder"), "must find the node via the parent workflow.json: " + r.out);
  assert.match(r.out, /returned 2 items/);
});

await step("run: $getWorkflowStaticData seeds from workflow.json, fixture overrides", async () => {
  const rd = path.join(TMP, "runtest-static");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "workflow.json"), JSON.stringify({
    nodes: [{ id: "sd", name: "SD", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0],
      parameters: { jsCode: "//@file:SD.js" } }],
    staticData: { global: { counter: 41 }, "node:SD": { seen: ["a"] } },
  }));
  writeFileSync(path.join(rd, "SD.js"),
    "const g = $getWorkflowStaticData('global');\nconst n = $getWorkflowStaticData('node');\nreturn [{ json: { counter: g.counter, seen: n.seen } }];\n");
  let r = await cli("node", "run", path.join("runtest-static", "SD.js"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { counter: 41, seen: ["a"] } }]);
  // fixture overrides per slice; the untouched slice keeps the workflow seed
  writeFileSync(path.join(rd, "fx.json"), JSON.stringify({ staticData: { global: { counter: 99 } } }));
  r = await cli("node", "run", path.join("runtest-static", "SD.js"), path.join("runtest-static", "fx.json"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { counter: 99, seen: ["a"] } }]);
  // a bare file without workflow.json gets empty objects, not a ReferenceError
  const bare = path.join(TMP, "runtest-bare");
  mkdirSync(bare, { recursive: true });
  writeFileSync(path.join(bare, "bare.js"),
    "return [{ json: { empty: Object.keys($getWorkflowStaticData('global')).length === 0 } }];\n");
  r = await cli("node", "run", path.join("runtest-bare", "bare.js"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { empty: true } }]);
  // invalid scope errors clearly
  writeFileSync(path.join(bare, "badscope.js"), "return $getWorkflowStaticData('nope');\n");
  r = await cli("node", "run", path.join("runtest-bare", "badscope.js"));
  assert.equal(r.code, 1);
  assert.match(r.out, /type must be "global" or "node"/);
});

await step("run: missing $() fixture data errors clearly", async () => {
  const rd = path.join(TMP, "runtest3");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "Ref.js"), "return $('Up').all();\n");
  const r = await cli("node", "run", path.join("runtest3", "Ref.js"));
  assert.equal(r.code, 1);
  assert.match(r.out, /node "Up" has no fixture data/);
});

await step("run: $env is empty by default, inherits process.env only with --allow-env", async () => {
  const rd = path.join(TMP, "runtest-env");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "Env.js"), "return [{ json: { key: $env.N8N_API_KEY ?? null } }];\n");
  // default: $env is empty — host secrets (N8N_API_KEY lives in the CLI env) never leak
  let r = await cli("node", "run", path.join("runtest-env", "Env.js"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { key: null } }]);
  // --allow-env opts back into the full process env
  r = await cli("node", "run", path.join("runtest-env", "Env.js"), "--allow-env");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { key: "test-key" } }]);
  // a fixture env wins regardless of the flag
  writeFileSync(path.join(rd, "fx.json"), JSON.stringify({ env: { N8N_API_KEY: "from-fixture" } }));
  r = await cli("node", "run", path.join("runtest-env", "Env.js"), path.join("runtest-env", "fx.json"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { key: "from-fixture" } }]);
});

await step("guard: dangling connection blocks check and push", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const wfJson = read(dir2, "workflow.json");
  const wf = JSON.parse(wfJson);
  wf.connections.Ghost = { main: [[{ node: "Nowhere", type: "main", index: 0 }]] };
  writeFileSync(path.join(dir2, "workflow.json"), JSON.stringify(wf, null, 2));
  let r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on dangling connections: " + r.out);
  assert.match(r.out, /source "Ghost" is not a node/);
  assert.match(r.out, /targets missing node "Nowhere"/);
  r = await cli("push");
  assert.equal(r.code, 1, "push must abort on dangling connections");
  assert.match(r.out, /does not comply/);
  writeFileSync(path.join(dir2, "workflow.json"), wfJson);
});

await step("guard: duplicate node names/ids block check", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const wfJson = read(dir2, "workflow.json");
  const wf = JSON.parse(wfJson);
  const set = wf.nodes.find((n: any) => n.id === "n4");
  set.name = "Webhook";
  set.id = "n1";
  writeFileSync(path.join(dir2, "workflow.json"), JSON.stringify(wf, null, 2));
  const r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on duplicates: " + r.out);
  assert.match(r.out, /duplicate node name "Webhook"/);
  assert.match(r.out, /duplicate node id "n1"/);
  writeFileSync(path.join(dir2, "workflow.json"), wfJson);
});

await step("guard: orphan code files error; reserved subdirs and .d.ts ignored", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  writeFileSync(path.join(dir2, "code", "orphan.js"), "return [];\n");
  writeFileSync(path.join(dir2, "stray.ts"), "export {};\n");
  // future artifact dirs (plans 3/7: executions/, fixtures/, mocks/) must not trip the guard
  mkdirSync(path.join(dir2, "executions"), { recursive: true });
  writeFileSync(path.join(dir2, "executions", "not-code.js"), "// captured\n");
  mkdirSync(path.join(dir2, "mocks"), { recursive: true });
  writeFileSync(path.join(dir2, "mocks", "also-not-code.js"), "// mock\n");
  writeFileSync(path.join(dir2, "code", "types.d.ts"), "type Row = { id: number };\n");
  const r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on orphans: " + r.out);
  assert.match(r.out, /orphan code file code\/orphan\.js/);
  assert.match(r.out, /orphan code file stray\.ts/);
  assert.ok(!r.out.includes("not-code.js"), "files under executions/ must be ignored: " + r.out);
  assert.ok(!r.out.includes("also-not-code.js"), "files under mocks/ must be ignored: " + r.out);
  assert.ok(!r.out.includes("types.d.ts"), ".d.ts files are not orphans: " + r.out);
  unlinkSync(path.join(dir2, "code", "orphan.js"));
  unlinkSync(path.join(dir2, "stray.ts"));
  unlinkSync(path.join(dir2, "code", "types.d.ts"));
  rmSync(path.join(dir2, "executions"), { recursive: true });
  rmSync(path.join(dir2, "mocks"), { recursive: true });
  const r2 = await cli("check", "--no-typecheck");
  assert.equal(r2.code, 0, r2.out);
});

await step("guard: dangling $('…') in code and parameters blocks check", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  const codeFile = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  writeFileSync(codeFile, "const gone = $('Deleted Node').all();\nconst dyn = $(someVar);\nreturn $input.all();\n");
  const wfJson = read(dir2, "workflow.json");
  const wf = JSON.parse(wfJson);
  wf.nodes.find((n: any) => n.id === "n4").parameters = { value: "={{ $('Also Gone').first().json.x }}" };
  writeFileSync(path.join(dir2, "workflow.json"), JSON.stringify(wf, null, 2));
  const r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on dangling refs: " + r.out);
  assert.match(r.out, /transform-eu-us\.js references \$\('Deleted Node'\) — no node by that name/);
  assert.match(r.out, /node "Set": a parameter references \$\('Also Gone'\)/);
  assert.ok(!r.out.includes("someVar"), "non-literal $(…) must be skipped: " + r.out);
  writeFileSync(codeFile, original);
  writeFileSync(path.join(dir2, "workflow.json"), wfJson);
});

await step("node rename: forwarded to n8n over MCP; refs and files follow via pull", async () => {
  const dir2 = dir1; // sticky folder (order-sync); the workflow's display name is now "Order Sync v2"
  // remote-side wiring that must follow the rename: a connection targeting the
  // node, a $('…') ref in another node's code, and an expression parameter —
  // all rewritten SERVER-side (n8n's renameNode contract), mirrored by the mock
  const wf = db.get("wf123");
  wf.connections["Transform: EU/US"] = { main: [[{ node: "Amazon Feed", type: "main", index: 0 }]] };
  wf.nodes.find((n: any) => n.id === "n4").parameters = { value: "={{ $('Amazon Feed').first().json.sku }}" };
  wf.nodes.find((n: any) => n.id === "n2").parameters.jsCode = "const feed = $('Amazon Feed').all();\nreturn feed;\n";
  let r = await cli("pull");
  assert.equal(r.code, 0, r.out);

  r = await cli("node", "rename", "wf123", "Amazon Feed", "Amazon Export");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /renamed node "Amazon Feed" -> "Amazon Export" in n8n/);
  // remote followed (name, connections, expression params, code refs) — and the id survived
  assert.ok(wf.nodes.some((n: any) => n.name === "Amazon Export" && n.id === "n3"), "node renamed remotely, id stable");
  assert.equal(wf.connections["Transform: EU/US"].main[0][0].node, "Amazon Export", "connection target follows");
  assert.equal(wf.nodes.find((n: any) => n.id === "n4").parameters.value, "={{ $('Amazon Export').first().json.sku }}", "expression parameter follows");
  // local followed via the rename's own pull: file renamed, refs arrive rewritten
  assert.match(read(dir2, "code", "transform-eu-us.js"), /\$\('Amazon Export'\)/);
  assert.ok(existsSync(path.join(dir2, "code", "amazon-export.ts")), "file renamed");
  assert.ok(!existsSync(path.join(dir2, "code", "amazon-feed.ts")), "old file gone");
  assert.equal(state(dir2).nodes.n3.file, "code/amazon-export.ts");
  assert.match(read(dir2, "workflow.json"), /"\/\/@file:code\/amazon-export\.ts"/);

  const rCheck = await cli("check", "--no-typecheck");
  assert.equal(rCheck.code, 0, rCheck.out);
  // the rewritten code still runs, with fixture data keyed by the NEW name
  writeFileSync(path.join(TMP, "fx-rename.json"), JSON.stringify({ nodes: { "Amazon Export": [{ json: { sku: "a-1" } }] } }));
  const rRun = await cli("node", "run", path.join("workflows", "order-sync", "code", "transform-eu-us.js"), "fx-rename.json");
  assert.equal(rRun.code, 0, rRun.out);
  assert.match(rRun.out, /returned 1 item/);
});

await step("node rename: guards refuse unknown, colliding, and same names", async () => {
  let r = await cli("node", "rename", "wf123", "Nope", "X");
  assert.equal(r.code, 1);
  assert.match(r.out, /no node named "Nope"/);
  r = await cli("node", "rename", "wf123", "Webhook", "Amazon Export");
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists/);
  r = await cli("node", "rename", "wf123", "Webhook", "Webhook");
  assert.equal(r.code, 1);
  assert.match(r.out, /already named/);
  r = await cli("node", "rename", "wf123", "Webhook");
  assert.equal(r.code, 1);
  assert.match(r.out, /old and new node name/);
});

await step("rename: workflow renamed in n8n immediately; folder stays put", async () => {
  const r = await cli("rename", "wf123", "Order Sync Final");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /renamed workflow "Order Sync v2" -> "Order Sync Final" in n8n/);
  assert.equal(db.get("wf123").name, "Order Sync Final", "remote renamed via MCP — no push needed");
  assert.equal(JSON.parse(read(dir1, "workflow.json")).name, "Order Sync Final");
  assert.equal(state(dir1).name, "Order Sync Final", "cached name updated by rename");
  const r2 = await cli("pull");
  assert.equal(r2.code, 0, r2.out);
  assert.ok(existsSync(dir1), "folder unchanged by rename");
  assert.ok(!existsSync(wfDir("Order Sync Final")), "no renamed folder appears");
});

const dirF = dir1; // wf123's sticky folder; display name is now "Order Sync Final"

await step("ts conflict: both sides changed → warned (no .remote.js), .ts kept; push overwrites by design", async () => {
  const tsFile = path.join(dirF, "code", "amazon-export.ts");
  writeFileSync(tsFile, read(dirF, "code", "amazon-export.ts").replace("return rows.map", "const extra = 1;\nreturn rows.map"));
  const node = remoteNode("wf123", "n3");
  node.parameters.jsCode = node.parameters.jsCode.replace("rows.map", "rows.slice(0, 1).map");
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CONFLICT — both code\/amazon-export\.ts and the remote code changed since last sync/);
  assert.match(r.out, /status --diff/);
  assert.ok(!existsSync(path.join(dirF, "code", "amazon-export.remote.js")), "no conflict artifact since Plan 32");
  assert.match(read(dirF, "code", "amazon-export.ts"), /const extra = 1/); // .ts never clobbered
  // pull re-baselined lastPushedHash: the next push overwrites the remote edit by design
  const r2 = await cli("push");
  assert.equal(r2.code, 0, r2.out);
  assert.ok(!remoteNode("wf123", "n3").parameters.jsCode.includes("slice(0, 1)"), "push restored the TS-compiled version");
});

await step("bundle: shared/ value import inlines on push, drifts on shared edit, runs offline", async () => {
  // the typecheck-gate step left a tsconfig in TMP — extend it with shared/
  const tsc = JSON.parse(read(TMP, "tsconfig.json"));
  tsc.include.push("shared/**/*.ts");
  tsc.compilerOptions.esModuleInterop = true;
  writeFileSync(path.join(TMP, "tsconfig.json"), JSON.stringify(tsc, null, 2));
  mkdirSync(path.join(TMP, "shared"), { recursive: true });
  writeFileSync(path.join(TMP, "shared", "money.ts"),
    "export interface Line { qty: number; price: number }\nexport function total(lines: Line[]): number {\n  return lines.reduce((s, l) => s + l.qty * l.price, 0);\n}\n");
  const tsFile = path.join(dirF, "code", "amazon-export.ts");
  const originalTs = read(dirF, "code", "amazon-export.ts");
  writeFileSync(tsFile,
    'import { total, type Line } from "../../../shared/money";\nconst lines: Line[] = $input.all().map((i) => ({ qty: Number(i.json.qty), price: Number(i.json.price) }));\nreturn [{ json: { total: total(lines) } }];\n');
  // full pipeline — including the typecheck wrapper handling the import block
  let r = await cli("push");
  assert.equal(r.code, 0, r.out);
  const code = remoteNode("wf123", "n3").parameters.jsCode;
  assert.match(code, /function total/, "helper inlined into the pushed node");
  assert.match(code, /shared\/money\.ts/, "sync-root-relative module label");
  assert.match(code, /return __n8n_node\.default\(\);\n\/\/ @ts-n8n sha256:/, "re-enter footer + marker");
  // pull: confirming-read hash matches the compiled local → in sync, no warnings
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("CONFLICT"), "in sync after push: " + r.out);
  // shared edit → importing node drifts as push-pending; --diff shows the inlined change
  writeFileSync(path.join(TMP, "shared", "money.ts"),
    read(TMP, "shared", "money.ts").replace("s + l.qty * l.price", "s + l.qty * l.price + 1"));
  r = await cli("status", "--diff");
  assert.equal(r.code, 0, "shared edit is local-only drift: " + r.out);
  assert.match(r.out, /Amazon Export: local changes in code\/amazon-export\.ts — push pending/);
  assert.match(r.out, /\+.*l\.price \+ 1/, "diff shows the inlined shared change");
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  assert.match(remoteNode("wf123", "n3").parameters.jsCode, /l\.price \+ 1/, "push propagates the shared edit");
  // run executes the importing node offline: (2*10+1) + (1*5+1) = 27
  writeFileSync(path.join(TMP, "fx-bundle.json"),
    JSON.stringify({ input: [{ json: { qty: 2, price: 10 } }, { json: { qty: 1, price: 5 } }] }));
  r = await cli("node", "run", path.join("workflows", "order-sync", "code", "amazon-export.ts"), "fx-bundle.json");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { total: 27 } }]);
  // restore the import-free node for the steps that follow
  writeFileSync(tsFile, originalTs);
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
});

await step("bundle: builtins and unlisted npm packages error; bundleDependencies opts in", async () => {
  const tsFile = path.join(dirF, "code", "amazon-export.ts");
  const originalTs = read(dirF, "code", "amazon-export.ts");
  const cfg = read(TMP, "decanter.config.json");
  try {
    // Node builtin → compliance guard refuses offline, push refuses too
    writeFileSync(tsFile, 'import { createHash } from "node:crypto";\nreturn [{ json: { h: String(createHash) } }];\n');
    let r = await cli("check", "--no-typecheck");
    assert.equal(r.code, 1, "check must flag a builtin import: " + r.out);
    assert.match(r.out, /Node builtin "node:crypto"/);
    r = await cli("push", "--no-typecheck");
    assert.equal(r.code, 1, "push must refuse a builtin import");
    // unlisted npm package → error names the opt-in key
    writeFileSync(tsFile, 'import { add } from "tiny-add";\nreturn [{ json: { n: add(1, 2) } }];\n');
    r = await cli("check", "--no-typecheck");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /bundleDependencies/);
    // opt in (config) + install (fake node_modules) → bundles and runs
    const pkg = path.join(TMP, "node_modules", "tiny-add");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "tiny-add", version: "1.0.0", main: "index.js" }));
    writeFileSync(path.join(pkg, "index.js"), "exports.add = (a, b) => a + b;\n");
    writeFileSync(path.join(TMP, "decanter.config.json"),
      JSON.stringify({ ...JSON.parse(cfg), bundleDependencies: ["tiny-add"] }, null, 2));
    r = await cli("push", "--no-typecheck"); // untyped fake package — skip the type gate
    assert.equal(r.code, 0, r.out);
    assert.match(remoteNode("wf123", "n3").parameters.jsCode, /a \+ b/, "package code inlined");
  } finally {
    writeFileSync(path.join(TMP, "decanter.config.json"), cfg);
    writeFileSync(tsFile, originalTs);
  }
  const r = await cli("push");
  assert.equal(r.code, 0, r.out);
});

await step("status: remote-drift, CONFLICT, and missing-file branches", async () => {
  const js = path.join(dirF, "code", "transform-eu-us.js");
  const original = read(dirF, "code", "transform-eu-us.js");
  const node = remoteNode("wf123", "n2");
  const remoteOriginal = node.parameters.jsCode;
  // remote-only edit → pull hint, and remote drift exits 1
  node.parameters.jsCode = remoteOriginal + "// remote edit\n";
  let r = await cli("status");
  assert.equal(r.code, 1, "remote drift must exit 1: " + r.out);
  assert.match(r.out, /Transform: EU\/US: changed remotely — pull/);
  // both sides changed → CONFLICT, exits 1
  writeFileSync(js, original + "// local edit\n");
  r = await cli("status");
  assert.equal(r.code, 1, "CONFLICT must exit 1: " + r.out);
  assert.match(r.out, /Transform: EU\/US: CONFLICT — changed both locally and remotely/);
  // local file missing → warning (a local problem, not remote drift)
  renameSync(js, js + ".away");
  r = await cli("status");
  assert.match(r.out, /Transform: EU\/US: local file code\/transform-eu-us\.js missing/);
  renameSync(js + ".away", js);
  // restore both sides to the synced state
  writeFileSync(js, original);
  node.parameters.jsCode = remoteOriginal;
  r = await cli("status");
  assert.equal(r.code, 0, "in sync must exit 0: " + r.out);
  assert.match(r.out, /Transform: EU\/US: in sync/);
});

await step("status --diff: line diffs for drifted nodes only", async () => {
  const js = path.join(dirF, "code", "transform-eu-us.js");
  const original = read(dirF, "code", "transform-eu-us.js");
  const node = remoteNode("wf123", "n2");
  const remoteOriginal = node.parameters.jsCode;
  // local-only edit → "+" lines under the push-pending node, exit stays 0
  writeFileSync(js, original + "// diff me\n");
  let r = await cli("status", "--diff");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /--- remote \(n8n\)/);
  assert.match(r.out, /\+\+\+ local \(code\/transform-eu-us\.js\)/);
  assert.match(r.out, /@@ /);
  assert.match(r.out, /^\s+\+\/\/ diff me$/m);
  writeFileSync(js, original);
  // remote-only edit → "-" lines, and the drift still exits 1
  node.parameters.jsCode = remoteOriginal + "// remote extra\n";
  r = await cli("status", "--diff");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^\s+-\/\/ remote extra$/m);
  node.parameters.jsCode = remoteOriginal;
  // in sync again → no diff blocks at all
  r = await cli("status", "--diff");
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("--- remote"), "no diff for in-sync nodes: " + r.out);
});

await step("push: an untracked remote Code node is an info line, not an abort (pull extracts it)", async () => {
  db.get("wf123").nodes.push({ id: "n5", name: "Report", type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 0], parameters: { jsCode: "return $input.all();\n" } });
  let r = await cli("push");
  assert.equal(r.code, 0, "an untracked remote node must not abort a code push: " + r.out);
  assert.match(r.out, /remote Code node "Report" isn't tracked locally — pull to extract it/);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dirF, "code", "report.js"), "return $input.all();\n");
  assert.equal(state(dirF).nodes.n5.file, "code/report.js");
});

await step("pull: kebab-name collision gets the -<id8> suffix", async () => {
  db.get("wf123").nodes.push({ id: "n6collide", name: "Report!", type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 200], parameters: { jsCode: "return [];\n" } });
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(state(dirF).nodes.n6collide.file, "code/report-n6collid.js");
  assert.equal(read(dirF, "code", "report-n6collid.js"), "return [];\n");
  assert.match(read(dirF, "workflow.json"), /"\/\/@file:code\/report-n6collid\.js"/);
});

await step("node rename: kebab collision falls back to -<id8>; freed bases are re-claimed deterministically", async () => {
  // "Transform EU US" kebabs to the same base as "Transform: EU/US" (n2's file)
  const r = await cli("node", "rename", "wf123", "Report", "Transform EU US");
  assert.equal(r.code, 0, r.out);
  assert.equal(remoteNode("wf123", "n5").name, "Transform EU US", "renamed in n8n");
  assert.ok(existsSync(path.join(dirF, "code", "transform-eu-us-n5.js")), "collision suffix used");
  assert.equal(state(dirF).nodes.n5.file, "code/transform-eu-us-n5.js");
  // with n5 off the "report" base, the rename's pull re-slugs n6collide
  // ("Report!") onto the now-free plain base — per-pull collision handling
  // is deterministic, not sticky
  assert.equal(state(dirF).nodes.n6collide.file, "code/report.js");
  assert.ok(existsSync(path.join(dirF, "code", "report.js")), "freed base re-claimed");
  assert.ok(!existsSync(path.join(dirF, "code", "report-n6collid.js")), "suffixed file renamed away");
});

await step("node deleted remotely: status warns, pull drops state, file kept", async () => {
  const wf = db.get("wf123");
  wf.nodes = wf.nodes.filter((n: any) => n.id !== "n6collide");
  let r = await cli("status");
  assert.equal(r.code, 1, "remotely deleted node counts as remote drift: " + r.out);
  assert.match(r.out, /code\/report\.js: node n6collide deleted remotely/);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /node n6collide \("code\/report\.js"\) no longer exists remotely — removing from state/);
  assert.ok(existsSync(path.join(dirF, "code", "report.js")), "file kept — git is the safety net");
  assert.equal(state(dirF).nodes.n6collide, undefined);
  // the kept file is an orphan now; the guard flags it until it's removed
  r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1);
  assert.match(r.out, /orphan code file code\/report\.js/);
  unlinkSync(path.join(dirF, "code", "report.js"));
});

await step("pull: two new workflows kebabbing to the same slug get <slug> and <slug>-<id8> + warn (Plan 27)", async () => {
  db.set("wfC1", { ...structuredClone(db.get("wf123")), id: "wfC1", name: "Sync Report" });
  db.set("wfC2", { ...structuredClone(db.get("wf123")), id: "wfC2", name: "Sync: Report!" }); // also kebabs to sync-report
  try {
    let r = await cli("pull", "wfC1");
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(path.join(ROOT, "sync-report")), "first claims the plain slug");
    r = await cli("pull", "wfC2");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already taken — using "sync-report-wfC2\//, "collision warned: " + r.out);
    assert.ok(existsSync(path.join(ROOT, "sync-report-wfC2")), "second gets the -<id8> suffix");
    // both still resolve as refs
    r = await cli("status", "wfC2");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /: in sync/);
  } finally {
    rmSync(path.join(ROOT, "sync-report"), { recursive: true, force: true });
    rmSync(path.join(ROOT, "sync-report-wfC2"), { recursive: true, force: true });
    db.delete("wfC1");
    db.delete("wfC2");
  }
});

await step("corrupt .decanter.json: scoped guard error, other workflows unaffected", async () => {
  const dirC = wfDir("Corrupted");
  mkdirSync(path.join(dirC, "code"), { recursive: true });
  writeFileSync(path.join(dirC, ".decanter.json"), "{ definitely not json");
  writeFileSync(path.join(dirC, "workflow.json"), JSON.stringify({ nodes: [], connections: {} }));
  // check: a scoped error for the broken folder; the healthy workflow still passes
  let r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on the corrupt state file: " + r.out);
  // corrupt state → check falls back to the folder basename for the label
  assert.match(r.out, /corrupted: corrupt \.decanter\.json \(/);
  assert.match(r.out, /Order Sync Final: OK/);
  // status/pull/push of the healthy workflow keep working
  r = await cli("status");
  assert.equal(r.code, 0, "status must survive a corrupt neighbor: " + r.out);
  assert.match(r.out, /skipping this folder/);
  r = await cli("pull");
  assert.equal(r.code, 0, "pull must survive a corrupt neighbor: " + r.out);
  r = await cli("push");
  assert.equal(r.code, 0, "push must survive a corrupt neighbor: " + r.out);
  // a scoped check of the healthy workflow warns about the skipped folder but
  // reports no guard error ("x …" line) for it and stays green
  r = await cli("check", "wf123", "--no-typecheck");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /skipping this folder/);
  const errorLines = r.out.split("\n").filter((l) => l.startsWith("✗ "));
  assert.deepEqual(errorLines, [], "corrupt neighbor's guard error leaked into scoped output: " + r.out);
  rmSync(dirC, { recursive: true, force: true });
});

await step("executions: fetches run JSON into a self-gitignored dir; filters pass through", async () => {
  const exDir = path.join(dirF, "executions");
  let r = await cli("executions", "wf123");
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(path.join(exDir, "201.json")));
  assert.ok(existsSync(path.join(exDir, "202.json")));
  // self-ignoring dir: run data may hold credentials/PII and must never
  // reach git, even in sync dirs whose root .gitignore predates the verb
  assert.equal(read(exDir, ".gitignore"), "*\n");
  const captured = JSON.parse(read(exDir, "201.json"));
  assert.equal(captured.data.resultData.runData.Transform[0].data.main[0][0].json.total, 9.5);
  assert.match(r.out, /2 executions -> .*executions \(gitignored/);

  // --status narrows (= form); the other-workflow execution never leaks in
  rmSync(exDir, { recursive: true, force: true });
  r = await cli("executions", "Order Sync Final", "--status=error");
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(path.join(exDir, "202.json")));
  assert.ok(!existsSync(path.join(exDir, "201.json")));

  // --limit caps the page (space form); newest-first means 202 only
  rmSync(exDir, { recursive: true, force: true });
  r = await cli("executions", "wf123", "--limit", "1");
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(path.join(exDir, "202.json")));
  assert.ok(!existsSync(path.join(exDir, "201.json")));
  r = await cli("executions", "wf123", "--limit", "0");
  assert.equal(r.code, 1);
  assert.match(r.out, /--limit must be an integer between 1 and 250/);
  r = await cli("executions", "wf123", "--limit", "251"); // upper bound of the executions API page cap
  assert.equal(r.code, 1);
  assert.match(r.out, /--limit must be an integer between 1 and 250/);

  // a numeric argument fetches that one execution, routed by its workflowId
  rmSync(exDir, { recursive: true, force: true });
  r = await cli("executions", "201");
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(path.join(exDir, "201.json")));
  // an execution of a not-pulled workflow errors with guidance, exit 1
  r = await cli("executions", "100");
  assert.equal(r.code, 1);
  assert.match(r.out, /belongs to workflow wf-other, which is not pulled/);
  r = await cli("executions", "999");
  assert.equal(r.code, 1, "unknown execution id must fail");
});

await step("mock create/check: named scenario into committed mocks/, validated offline", async () => {
  const exDir = path.join(dirF, "executions");
  const mockDir = path.join(dirF, "mocks");
  assert.ok(existsSync(path.join(exDir, "201.json")), "previous step left capture 201");
  // offline: no credentials needed (reads a capture, writes a committed mock)
  const savedEnv = env;
  env = { ...savedEnv };
  delete env.N8N_HOST;
  delete env.N8N_API_KEY;
  delete env.N8N_MCP_TOKEN;
  try {
    // slug is a positional; kebab-slugged on disk
    let r = await cli("mock", "create", "wf123", "Happy Path", "--execution", "201");
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(path.join(mockDir, "happy-path.json")), "mock file written: " + r.out);
    const mock = JSON.parse(read(mockDir, "happy-path.json"));
    // full copy of the capture (real runData preserved) + a guidance block
    assert.equal(mock.data.resultData.runData.Transform[0].data.main[0][0].json.total, 9.5);
    assert.equal(mock._decanterMock.sourceExecution, "201");
    assert.ok(Array.isArray(mock._decanterMock.fill), "fill list present");
    assert.match(r.out, /credentials\/PII/); // PII review warning
    // refuses to clobber (protects hand-filled data)
    r = await cli("mock", "create", "wf123", "Happy Path", "--execution", "201");
    assert.equal(r.code, 1);
    assert.match(r.out, /already exists/);
    // mock check validates the committed mock offline (no Docker)
    r = await cli("mock", "check", "wf123", "happy-path");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /valid/);
    // a structurally broken mock fails check with exit 1
    writeFileSync(path.join(mockDir, "broken.json"), JSON.stringify({ _decanterMock: { fill: [] }, data: { resultData: { runData: { X: [{ data: { main: [[42]] } }] } } } }));
    r = await cli("mock", "check", "wf123", "broken");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /invalid|must be an object/);
    // check-all also fails while a broken mock is present
    r = await cli("mock", "check", "wf123");
    assert.equal(r.code, 1, r.out);
  } finally {
    env = savedEnv;
    rmSync(mockDir, { recursive: true, force: true });
  }
});

await step("executions clean: removes the dirs, credentials-free", async () => {
  const exDir = path.join(dirF, "executions");
  assert.ok(existsSync(exDir), "previous step left fetched data");
  const savedEnv = env;
  env = { ...savedEnv };
  delete env.N8N_HOST;
  delete env.N8N_API_KEY;
  delete env.N8N_MCP_TOKEN;
  try {
    let r = await cli("executions", "clean", "order sync final"); // name ref, case-insensitive
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(exDir));
    r = await cli("executions", "clean");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no executions\/ dirs to clean/);
  } finally {
    env = savedEnv;
  }
});

const dtDir = path.join(TMP, "data-tables");

await step("data-tables: fetches schema + rows into a self-gitignored top-level dir; filters narrow server-side", async () => {
  rmSync(dtDir, { recursive: true, force: true });
  let r = await cli("data-tables");
  assert.equal(r.code, 0, r.out);
  // project-scoped: a single top-level data-tables/ dir, one folder per table
  const ordersDir = path.join(dtDir, "orders-1");
  const customersDir = path.join(dtDir, "customers-2");
  for (const f of ["meta.json", "columns.json", "rows.json"]) {
    assert.ok(existsSync(path.join(ordersDir, f)), `missing orders/${f}`);
    assert.ok(existsSync(path.join(customersDir, f)), `missing customers/${f}`);
  }
  // self-ignored — data tables may hold PII, must never reach git
  assert.equal(read(dtDir, ".gitignore"), "*\n");
  const cols = JSON.parse(read(ordersDir, "columns.json"));
  assert.deepEqual(cols.map((c: any) => c.name), ["status", "total"]);
  let rows = JSON.parse(read(ordersDir, "rows.json"));
  assert.equal(rows.length, 3);
  let meta = JSON.parse(read(ordersDir, "meta.json"));
  assert.equal(meta.rowCount, 3);
  assert.equal(meta.name, "Orders");
  assert.equal(meta.projectId, "proj-1");
  assert.equal(meta.filter, null, "unfiltered fetch records filter: null");
  assert.match(r.out, /2 data tables -> .*data-tables \(gitignored/);

  // a table ref scopes to one table (by exact name, case-insensitive)
  rmSync(dtDir, { recursive: true, force: true });
  r = await cli("data-tables", "orders");
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(ordersDir) && !existsSync(customersDir), "ref must scope to one table: " + r.out);
  r = await cli("data-tables", "no-such-table");
  assert.equal(r.code, 1);
  assert.match(r.out, /no data table matches "no-such-table"/);

  // --filter narrows rows server-side, and meta.json records the applied filter
  rmSync(dtDir, { recursive: true, force: true });
  r = await cli("data-tables", "Orders", "--filter", '{"type":"and","filters":[{"columnName":"status","condition":"eq","value":"active"}]}');
  assert.equal(r.code, 0, r.out);
  rows = JSON.parse(read(ordersDir, "rows.json"));
  assert.deepEqual(rows.map((x: any) => x.id), [1, 3], "filter kept only active rows: " + r.out);
  meta = JSON.parse(read(ordersDir, "meta.json"));
  assert.equal(meta.rowCount, 2);
  assert.match(meta.filter, /"status"/, "meta records the applied filter");
  assert.match(r.out, /\[filter /, "summary names the filter");

  // --sort orders rows; --search filters string columns
  rmSync(dtDir, { recursive: true, force: true });
  r = await cli("data-tables", "Orders", "--sort", "total:desc");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(read(ordersDir, "rows.json")).map((x: any) => x.total), [30, 20, 10]);
  rmSync(dtDir, { recursive: true, force: true });
  r = await cli("data-tables", "Customers", "--search", "a@example");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(read(dtDir, "customers-2", "rows.json")).map((x: any) => x.id), [1]);

  // --limit caps a page; --all follows the cursor to exhaust the result
  rmSync(dtDir, { recursive: true, force: true });
  r = await cli("data-tables", "Orders", "--limit", "1");
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(read(ordersDir, "rows.json")).length, 1, "one page only");
  rmSync(dtDir, { recursive: true, force: true });
  r = await cli("data-tables", "Orders", "--limit", "1", "--all");
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(read(ordersDir, "rows.json")).length, 3, "--all paginates through every row");
  r = await cli("data-tables", "--limit", "251");
  assert.equal(r.code, 1);
  assert.match(r.out, /--limit must be an integer between 1 and 250/);
});

await step("data-tables clean: removes the dir, credentials-free", async () => {
  assert.ok(existsSync(dtDir), "previous step left fetched data");
  const savedEnv = env;
  env = { ...savedEnv };
  delete env.N8N_HOST;
  delete env.N8N_API_KEY;
  delete env.N8N_MCP_TOKEN;
  try {
    let r = await cli("data-tables", "clean");
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(dtDir));
    r = await cli("data-tables", "clean");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no data-tables\/ dir to clean/);
  } finally {
    env = savedEnv;
  }
});

await step('data-tables: "dataTables": false refuses the fetch but still cleans', async () => {
  const configFile = path.join(TMP, "decanter.config.json");
  const saved = read(configFile);
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(saved), dataTables: false }, null, 2));
  try {
    let r = await cli("data-tables");
    assert.equal(r.code, 1);
    assert.match(r.out, /data-table reads are disabled — set "dataTables": true/);
    assert.ok(!existsSync(dtDir), "refused fetch must write nothing");
    // clean stays available regardless of the gate
    r = await cli("data-tables", "clean");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no data-tables\/ dir to clean/);
  } finally {
    writeFileSync(configFile, saved);
  }
});

await step("create: blank workflow born in n8n over MCP (auto-available), then pulled into the layout", async () => {
  let r = await cli("create", "Fresh Flow");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /created "Fresh Flow" \(wf-new-[^)]+\) on the server — unpublished draft/);
  const created = [...db.values()].find((w) => w.name === "Fresh Flow");
  assert.ok(created, "workflow created in the mock db");
  assert.equal(created.active, false, "born unpublished");
  assert.equal(created.availableInMCP, true, "MCP-created workflows are born available");
  const dir = wfDir("Fresh Flow");
  assert.ok(existsSync(path.join(dir, ".decanter.json")), "pulled: state file exists");
  assert.ok(existsSync(path.join(dir, "workflow.json")), "pulled: workflow.json exists");
  assert.equal(state(dir).workflowId, created.id, "state points at the new id");
  assert.match(r.out, /wrote fresh-flow[/\\]workflow\.json/);
  // create needs exactly one name
  r = await cli("create");
  assert.equal(r.code, 1);
  assert.match(r.out, /create needs exactly one name/);
});

await step("publish/unpublish: toggle live state over MCP; already-in-state is a no-op note", async () => {
  const id = [...db.values()].find((w) => w.name === "Fresh Flow")!.id;
  let r = await cli("publish", id);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /published "Fresh Flow" \([^)]+\) — code is live now/);
  assert.equal(db.get(id).active, true);
  assert.equal(db.get(id).activeVersionId, db.get(id).versionId, "activeVersionId set to the draft on publish");
  // publish again → no-op note, still published
  r = await cli("publish", id);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is already published/);
  assert.equal(db.get(id).active, true);
  // unpublish → back to draft-only
  r = await cli("unpublish", id);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unpublished "Fresh Flow" \([^)]+\) — draft only/);
  assert.equal(db.get(id).active, false);
  assert.equal(db.get(id).activeVersionId, null);
  // unpublish again → no-op note
  r = await cli("unpublish", id);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is already unpublished/);
  // resolves by name too, leaving it published for the status step
  r = await cli("publish", "Fresh Flow");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /published "Fresh Flow"/);
});

await step("publish: a diverged draft publishes (not a no-op); the gate error surfaces in-band", async () => {
  const created = [...db.values()].find((w) => w.name === "Fresh Flow")!;
  const prevVersion = created.versionId;
  created.versionId = "draft-ahead"; // draft newer than the live version
  try {
    let r = await cli("publish", created.id);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /published "Fresh Flow"/, "diverged draft must re-publish, not no-op: " + r.out);
    assert.equal(created.activeVersionId, "draft-ahead");
    // publish of an MCP-unavailable workflow → the in-band success:false error
    created.availableInMCP = false;
    r = await cli("publish", created.id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not available in MCP/i);
  } finally {
    created.availableInMCP = true;
    created.versionId = prevVersion;
    created.activeVersionId = prevVersion;
  }
});

await step("status: version-aware — a live version older than the draft prints the lag note", async () => {
  const created = [...db.values()].find((w) => w.name === "Fresh Flow")!;
  const prevVersion = created.versionId;
  created.versionId = "draft-ahead"; // simulate a UI draft edit the live version now lags
  try {
    let r = await cli("status", created.id);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /published — live version is older than the draft \("publish" to go live\)/);
    // an in-sync published workflow stays plain (wf123: activeVersionId == versionId)
    r = await cli("status", "wf123");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\] {2}published/);
    assert.ok(!r.out.includes("older than the draft"), "in-sync published stays plain: " + r.out);
  } finally {
    created.versionId = prevVersion;
  }
});

await step("executions: warns when a captured run's version differs from the local draft", async () => {
  const exDir = path.join(dirF, "executions");
  const exec202 = EXECUTIONS.find((e) => e.id === 202)!;
  const prev = exec202.workflowVersionId;
  exec202.workflowVersionId = "old-live-ver"; // wf123 draft is "aaa"
  try {
    let r = await cli("executions", "wf123", "--status=error"); // exec 202 only
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /captured executions ran published version old-live-ver; your draft is aaa — the data may not match the code you're editing/);
    rmSync(exDir, { recursive: true, force: true });
    r = await cli("executions", "wf123", "--status=success"); // exec 201, version "aaa" == draft
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes("may not match the code"), "matching version is silent: " + r.out);
  } finally {
    exec202.workflowVersionId = prev;
    rmSync(exDir, { recursive: true, force: true });
  }
});

await step("delete: refuses without --force non-interactively; --force deletes via the REST API, local folder kept", async () => {
  const id = [...db.values()].find((w) => w.name === "Fresh Flow")!.id;
  const dir = wfDir("Fresh Flow");
  // non-interactive without --force → refuse, remote intact
  let r = await cli("delete", id);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refusing to delete "Fresh Flow" \([^)]+\) without confirmation — re-run with --force/);
  assert.ok(db.has(id), "workflow not deleted without consent");
  // no ref (non-TTY) → error, never falls back to config.workflows or the picker
  r = await cli("delete");
  assert.equal(r.code, 1);
  assert.match(r.out, /delete needs a workflow ref/);
  assert.ok(db.has("wf123"), "config workflow untouched by a ref-less delete");
  // --force deletes even a published workflow; the local folder is left as the git record
  r = await cli("delete", id, "--force");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /deleted "Fresh Flow" \([^)]+\) from the server/);
  assert.match(r.out, /left untouched/);
  assert.ok(!db.has(id), "workflow gone from the server");
  assert.ok(existsSync(path.join(dir, ".decanter.json")), "local folder kept as the git-tracked record");
});

await step("node create: Code node born in n8n over MCP (addNode), landed by pull; --ts converts in place", async () => {
  // self-contained: a fresh workflow so the authoring steps don't perturb others
  let r = await cli("create", "Authoring Demo");
  assert.equal(r.code, 0, r.out);
  const id = [...db.values()].find((w) => w.name === "Authoring Demo")!.id;
  const dir = wfDir("Authoring Demo");
  const before = JSON.parse(read(dir, "workflow.json")).nodes.length;

  r = await cli("node", "create", id, "Parse Order");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /added Code node "Parse Order" \([0-9a-f]+\) -> code[/\\]parse-order\.js — disconnected; wire it in the n8n editor/);
  // the node was born REMOTELY (the mock even re-mints the id) and landed via pull
  const remote = db.get(id).nodes.find((n: any) => n.name === "Parse Order");
  assert.ok(remote, "node exists in n8n");
  assert.equal(remote.type, "n8n-nodes-base.code");
  assert.equal(remote.parameters.mode, "runOnceForAllItems");
  assert.match(remote.parameters.jsCode, /New Code node/, "starter source on the server");
  const wf = JSON.parse(read(dir, "workflow.json"));
  assert.equal(wf.nodes.length, before + 1, "node landed in the snapshot");
  const node = wf.nodes.find((n: any) => n.name === "Parse Order");
  assert.equal(node.parameters.jsCode, "//@file:code/parse-order.js");
  assert.equal(node.id, remote.id, "snapshot carries the server-minted id");
  assert.ok(existsSync(path.join(dir, "code", "parse-order.js")), "source file extracted");
  assert.equal(state(dir).nodes[remote.id].file, "code/parse-order.js", "registered in state under the server id");
  assert.ok(!wf.connections["Parse Order"], "lands disconnected");

  r = await cli("check", id);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Authoring Demo: OK/);

  // colliding kebab name → -<id8> suffix (a distinct node name that kebabs the same)
  r = await cli("node", "create", id, "Parse-Order");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /-> code[/\\]parse-order-[0-9a-f]{8}\.js/);

  // --ts converts the pulled .js to .ts in place; the marker lands on first push
  r = await cli("node", "create", id, "Typed Step", "--ts");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /-> code[/\\]typed-step\.ts/);
  assert.ok(existsSync(path.join(dir, "code", "typed-step.ts")));
  assert.match(read(dir, "workflow.json"), /"\/\/@file:code\/typed-step\.ts"/);
  r = await cli("push", id);
  assert.equal(r.code, 0, r.out);
  const typedRemote = db.get(id).nodes.find((n: any) => n.name === "Typed Step");
  assert.match(typedRemote.parameters.jsCode, /\/\/ @ts-n8n sha256:/, "first push TS-marks the node");

  // duplicate node name refused
  r = await cli("node", "create", id, "Parse Order");
  assert.equal(r.code, 1);
  assert.match(r.out, /a node named "Parse Order" already exists/);
  // no node name → usage error
  r = await cli("node", "create", id);
  assert.equal(r.code, 1);
  assert.match(r.out, /node create needs exactly one node name/);

  assert.equal(db.get(id).nodes.filter((n: any) => n.type === "n8n-nodes-base.code").length, 3, "three code nodes live in n8n");
});

await step("duplicate: API-born clone (lossless POST); MCP pull gated until enabled in n8n", async () => {
  const id = [...db.values()].find((w) => w.name === "Authoring Demo")!.id;
  const sourceNodeCount = db.get(id).nodes.length;

  let r = await cli("duplicate", id, "Authoring Clone");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /duplicated "Authoring Demo" -> "Authoring Clone" \(wf-new-[^)]+\) on the server — unpublished draft/);
  assert.match(r.out, /not yet available in MCP/, "API-born clone is MCP-gated: " + r.out);
  const clone = [...db.values()].find((w) => w.name === "Authoring Clone");
  assert.ok(clone, "clone created in the mock db");
  assert.equal(clone.active, false, "born unpublished");
  assert.equal(clone.availableInMCP, false, "API-born → not available in MCP");
  assert.notEqual(clone.id, id, "distinct new id");
  assert.equal(clone.nodes.length, sourceNodeCount, "carries the source's nodes");
  assert.ok(!existsSync(wfDir("Authoring Clone")), "no folder while the pull is gated");
  // source folder + remote left untouched
  assert.ok(db.has(id), "source remote intact");
  assert.equal(db.get(id).name, "Authoring Demo", "source name unchanged");
  assert.ok(existsSync(path.join(wfDir("Authoring Demo"), ".decanter.json")), "source folder intact");

  // enable MCP access (the user's n8n-side act) → pull lands the clone
  clone.availableInMCP = true;
  r = await cli("pull", clone.id);
  assert.equal(r.code, 0, r.out);
  const cloneDir = wfDir("Authoring Clone");
  assert.ok(existsSync(path.join(cloneDir, ".decanter.json")), "clone pulled into a folder");
  assert.equal(state(cloneDir).workflowId, clone.id, "state points at the new id");
  // the plain .js node round-trips byte-clean into the clone
  assert.equal(read(cloneDir, "code", "parse-order.js"), read(wfDir("Authoring Demo"), "code", "parse-order.js"));

  // no name → "<name> (copy)"
  r = await cli("duplicate", id);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /-> "Authoring Demo \(copy\)"/);
  assert.ok([...db.values()].find((w) => w.name === "Authoring Demo (copy)"), "default copy-named clone");

  // duplicate needs a ref
  r = await cli("duplicate");
  assert.equal(r.code, 1);
  assert.match(r.out, /duplicate needs a workflow ref/);
});

if (!hasFailed()) {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passedCount()} steps passed`);
