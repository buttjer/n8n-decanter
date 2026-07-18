// End-to-end test: mock n8n API + the real CLI as a subprocess.
// Needs to bind a localhost port — sandboxed environments may block this.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");
const TMP = path.join(os.tmpdir(), `n8n-decanter-e2e-${process.pid}`);
const ROOT = path.join(TMP, "workflows");

// ---------- mock n8n ----------
const ALLOWED_PUT = ["name", "nodes", "connections", "settings", "staticData"];
const db = new Map<string, any>();
const server = http.createServer((req, res) => {
  if (req.headers["x-n8n-api-key"] !== "test-key") return void res.writeHead(401).end("unauthorized");
  if (req.method === "GET" && req.url!.startsWith("/api/v1/workflows?")) {
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [...db.values()], nextCursor: null }));
  }
  const m = req.url!.match(/^\/api\/v1\/workflows\/([^/]+)$/);
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
let env: NodeJS.ProcessEnv;
async function cli(...args: string[]) {
  // async on purpose: the mock server lives in this process, a sync exec would deadlock
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...args], { cwd: TMP, env, encoding: "utf8" });
    return { out: stdout + stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.code ?? 1 };
  }
}
const wfDir = (name: string) => path.join(ROOT, name);
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");
const state = (dir: string) => JSON.parse(read(dir, ".decanter.json"));
const remoteNode = (id: string, nid: string) => db.get(id).nodes.find((n: any) => n.id === nid);
let passed = 0;
function step(name: string, fn: () => unknown) {
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
// commitOnPush/commitOnPull off for the base scenario; a dedicated step tests them explicitly
writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: ["wf123"], commitOnPush: false, commitOnPull: false }, null, 2));

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
env = { ...process.env, N8N_HOST: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, N8N_API_KEY: "test-key" };

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

await step("init: writes .env, copies whole template, scaffolds config", async () => {
  const target = path.join(TMP, "init-target");
  const pending = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  pending.child.stdin!.write(`${env.N8N_HOST}\ntest-key\n`);
  pending.child.stdin!.end();
  const { stdout, stderr } = await pending;
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\n`);
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
  assert.match(stdout + stderr, /credentials verified/);
  // re-init must not clobber user edits to template-provided files
  const probe = materialize(templateFiles.find((f) => materialize(f) !== ".env")!);
  writeFileSync(path.join(target, probe), "user content\n");
  const again = execFile(process.execPath, [CLI, "init", target], { encoding: "utf8" });
  again.child.stdin!.write("\n\n"); // keep existing host + key
  again.child.stdin!.end();
  await again;
  assert.equal(read(target, probe), "user content\n");
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\n`);
  // init --force re-copies template files over existing ones (.env protected)
  const forced = execFile(process.execPath, [CLI, "init", target, "--force"], { encoding: "utf8" });
  forced.child.stdin!.write("\n\n"); // keep existing host + key
  forced.child.stdin!.end();
  const forcedResult = await forced;
  assert.match(forcedResult.stdout + forcedResult.stderr, /using existing \.env/, "re-init must not prompt when .env is complete");
  assert.match(forcedResult.stdout + forcedResult.stderr, /--force: overwrote/);
  const probeTemplateRel = templateFiles.find((f) => materialize(f) === probe)!;
  assert.equal(read(target, probe), read(templateDir, probeTemplateRel), "--force must restore the template version");
  assert.equal(read(target, ".env"), `N8N_HOST=${env.N8N_HOST}\nN8N_API_KEY=test-key\n`, ".env must survive --force");
});

await step("pull: creates folder, kebab-case files in code/, placeholders, state", async () => {
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir1, "code", "transform.js"), JS_CODE);
  assert.equal(read(dir1, "code", "amazon-feed.js"), "return $input.all();\n");
  const wfJson = read(dir1, "workflow.json");
  assert.match(wfJson, /"\/\/@file:code\/transform\.js"/);
  assert.match(wfJson, /"\/\/@file:code\/amazon-feed\.js"/);
  const s = state(dir1);
  assert.equal(s.workflowId, "wf123");
  assert.equal(s.nodes.n2.file, "code/transform.js");
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

await step("convert node to .ts + push: compiles, appends marker", async () => {
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

await step("pull after ts push: in sync, .ts untouched, no .remote.js", async () => {
  const before = read(dir1, "code", "amazon-feed.ts");
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.equal(read(dir1, "code", "amazon-feed.ts"), before);
  assert.ok(!existsSync(path.join(dir1, "code", "amazon-feed.remote.js")));
  assert.match(read(dir1, "workflow.json"), /"\/\/@file:code\/amazon-feed\.ts"/);
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
  assert.match(read(dir1, "code", "amazon-feed.remote.js"), /hotfix from UI/);
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
  assert.equal(read(dir1, "code", "amazon-feed.remote.js"), "return [];");
  assert.equal(read(dir1, "code", "amazon-feed.ts"), TS_SOURCE);
  const r2 = await cli("push");
  assert.equal(r2.code, 0, r2.out);
  assert.match(remoteNode("wf123", "n3").parameters.jsCode, /\/\/ @ts-n8n sha256:/);
  await cli("pull"); // resync, removes stale .remote.js
  assert.ok(!existsSync(path.join(dir1, "code", "amazon-feed.remote.js")));
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
  const js = path.join(dir1, "code", "transform.js");
  writeFileSync(js, read(dir1, "code", "transform.js") + "// local tweak\n");
  let r = await cli("status");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Transform: local changes in code\/transform\.js — push pending/);
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
  wf.nodes.find((n: any) => n.id === "n2").name = "Transform: EU/US";
  // n8n rewrites connections on rename; the mock must mirror that
  wf.connections.Webhook.main[0][0].node = "Transform: EU/US";
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  const dir2 = wfDir("Order Sync v2");
  assert.ok(existsSync(dir2), "folder renamed");
  assert.ok(!existsSync(dir1), "old folder gone");
  assert.ok(existsSync(path.join(dir2, "code", "transform-eu-us.js")), "file renamed with kebab-case name");
  assert.ok(!existsSync(path.join(dir2, "code", "transform.js")));
  assert.equal(state(dir2).nodes.n2.file, "code/transform-eu-us.js");
  assert.match(read(dir2, "workflow.json"), /"\/\/@file:code\/transform-eu-us\.js"/);
});

await step("watch path: pushSingleNode round-trip", async () => {
  const { pushSingleNode } = await import(pathToFileURL(path.join(PROJECT, "lib/push.mts")).href);
  const { N8nApi } = await import(pathToFileURL(path.join(PROJECT, "lib/api.mts")).href);
  const dir2 = wfDir("Order Sync v2");
  writeFileSync(path.join(dir2, "code", "transform-eu-us.js"), "return $input.all(); // watched\n");
  const api = new N8nApi({ host: env.N8N_HOST, apiKey: "test-key" });
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  await pushSingleNode(api, dir2, "n2", {}, log);
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, "return $input.all(); // watched\n");
});

await step("check: clean tree passes, typecheck skipped without tsconfig", async () => {
  const r = await cli("check");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  assert.match(r.out, /no tsconfig\.json found — skipping typecheck/);
});

await step("guard: inline code in workflow.json blocks push", async () => {
  const dir2 = wfDir("Order Sync v2");
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
  const dir2 = wfDir("Order Sync v2");
  const file = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  writeFileSync(file, original + "// @ts-n8n sha256:" + "0".repeat(64) + "\n");
  const r = await cli("push");
  assert.equal(r.code, 1, "push must abort on marker in .js");
  assert.match(r.out, /@ts-n8n marker/);
  writeFileSync(file, original);
});

await step("guard: .remote.js leftovers warn but don't block", async () => {
  const dir2 = wfDir("Order Sync v2");
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
  const dir2 = wfDir("Order Sync v2");
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
  const dir2 = wfDir("Order Sync v2");
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
  const dir2 = wfDir("Order Sync v2");
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
    assert.match(file, /^workflows\/Order Sync v2\//, `commit must only contain the workflow folder, found: ${file}`);
  }
  const { stdout: status } = await execFile("git", ["-C", TMP, "status", "--porcelain", "--", "unrelated.txt"], { encoding: "utf8" });
  assert.match(status, /^\?\? unrelated\.txt/m, "unrelated file must stay uncommitted and unstaged");
  // pushing without changes must not create an empty commit
  r = await cli("push");
  assert.equal(r.code, 0, r.out);
  const { stdout: count } = await execFile("git", ["-C", TMP, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  assert.equal(count.trim(), "1", "no empty follow-up commit");
  // pull commits too (commitOnPull); a rename must also commit the old-path deletions
  db.get("wf123").name = "Order Sync v3";
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /committed: decanter: pulled "Order Sync v3" \(wf123\)/);
  assert.ok(existsSync(wfDir("Order Sync v3")) && !existsSync(wfDir("Order Sync v2")), "folder renamed");
  let { stdout: dirty } = await execFile("git", ["-C", TMP, "status", "--porcelain", "--", "workflows"], { encoding: "utf8" });
  assert.equal(dirty.trim(), "", "rename pull must leave no uncommitted changes under workflows/");
  // rename back so later steps keep their folder; must stay clean too
  db.get("wf123").name = "Order Sync v2";
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  ({ stdout: dirty } = await execFile("git", ["-C", TMP, "status", "--porcelain", "--", "workflows"], { encoding: "utf8" }));
  assert.equal(dirty.trim(), "", "rename-back pull must leave a clean tree");
});

await step("id-first argument order: `<id> <verb>` == `<verb> <id>`", async () => {
  let r = await cli("wf123", "status");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /structure: in sync/);
  // flags may sit anywhere among the arguments too
  r = await cli("--no-typecheck", "wf123", "check");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  // no verb anywhere still reports an unknown command
  r = await cli("wf123");
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown command: wf123/);
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const runOutput = (out: string) => {
  // The printed items are the last JSON array on stdout; cli() appends stderr
  // (e.g. warnings) afterwards, so bound the slice by the final closing bracket.
  const clean = stripAnsi(out);
  const start = clean.indexOf("[", clean.indexOf("returned"));
  return JSON.parse(clean.slice(start, clean.lastIndexOf("]") + 1));
};

await step("uuid: prints lowercase v4 uuids", async () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let r = await cli("uuid");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim(), V4);
  r = await cli("uuid", "3");
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, V4);
  r = await cli("uuid", "0");
  assert.equal(r.code, 1, "uuid 0 must fail");
});

await step("run: executes a .ts node against a fixture (all-items)", async () => {
  const rd = path.join(TMP, "runtest");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "Gen.ts"),
    "interface Row { id: number }\nconst rows: Row[] = $input.all().map((i) => ({ id: Number(i.json.id) }));\nreturn rows.map((r) => ({ json: r }));\n");
  writeFileSync(path.join(rd, "fx.json"), JSON.stringify({ input: [{ json: { id: 5 } }, { json: { id: 9 } }] }));
  const r = await cli("run", path.join("runtest", "Gen.ts"), path.join("runtest", "fx.json"));
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
  const r = await cli("run", path.join("runtest2", "Dbl.js"), path.join("runtest2", "fx.json"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /runOnceForEachItem/);
  assert.deepEqual(runOutput(r.out), [{ json: { n: 4, i: 0 } }, { json: { n: 10, i: 1 } }]);
});

await step("run: resolves workflow.json from the parent of code/", async () => {
  writeFileSync(path.join(TMP, "fx-run.json"), JSON.stringify({ input: [{ json: { a: 1 } }, { json: { a: 2 } }] }));
  const r = await cli("run", path.join("workflows", "Order Sync v2", "code", "transform-eu-us.js"), "fx-run.json");
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("no workflow.json placeholder"), "must find the node via the parent workflow.json: " + r.out);
  assert.match(r.out, /returned 2 items/);
});

await step("run: missing $() fixture data errors clearly", async () => {
  const rd = path.join(TMP, "runtest3");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(rd, "Ref.js"), "return $('Up').all();\n");
  const r = await cli("run", path.join("runtest3", "Ref.js"));
  assert.equal(r.code, 1);
  assert.match(r.out, /node "Up" has no fixture data/);
});

await step("guard: dangling connection blocks check and push", async () => {
  const dir2 = wfDir("Order Sync v2");
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
  const dir2 = wfDir("Order Sync v2");
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
  const dir2 = wfDir("Order Sync v2");
  writeFileSync(path.join(dir2, "code", "orphan.js"), "return [];\n");
  writeFileSync(path.join(dir2, "stray.ts"), "export {};\n");
  // future artifact dirs (plans 3/7: executions/, fixtures/) must not trip the guard
  mkdirSync(path.join(dir2, "executions"), { recursive: true });
  writeFileSync(path.join(dir2, "executions", "not-code.js"), "// captured\n");
  writeFileSync(path.join(dir2, "code", "types.d.ts"), "type Row = { id: number };\n");
  const r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on orphans: " + r.out);
  assert.match(r.out, /orphan code file code\/orphan\.js/);
  assert.match(r.out, /orphan code file stray\.ts/);
  assert.ok(!r.out.includes("not-code.js"), "files under executions/ must be ignored: " + r.out);
  assert.ok(!r.out.includes("types.d.ts"), ".d.ts files are not orphans: " + r.out);
  unlinkSync(path.join(dir2, "code", "orphan.js"));
  unlinkSync(path.join(dir2, "stray.ts"));
  unlinkSync(path.join(dir2, "code", "types.d.ts"));
  rmSync(path.join(dir2, "executions"), { recursive: true });
  const r2 = await cli("check", "--no-typecheck");
  assert.equal(r2.code, 0, r2.out);
});

await step("guard: dangling $('…') in code and parameters blocks check", async () => {
  const dir2 = wfDir("Order Sync v2");
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

await step("rename: node update spans connections, $('…') refs, params, file, state", async () => {
  const dir2 = wfDir("Order Sync v2");
  // wire up everything that must follow the rename: a connection into the
  // node, a $('…') ref in another node's code, an expression parameter, and
  // a stale .remote.js sibling
  const wfBefore = JSON.parse(read(dir2, "workflow.json"));
  wfBefore.connections["Transform: EU/US"] = { main: [[{ node: "Amazon Feed", type: "main", index: 0 }]] };
  wfBefore.nodes.find((n: any) => n.id === "n4").parameters = { value: "={{ $('Amazon Feed').first().json.sku }}" };
  writeFileSync(path.join(dir2, "workflow.json"), JSON.stringify(wfBefore, null, 2));
  writeFileSync(path.join(dir2, "code", "transform-eu-us.js"), "const feed = $('Amazon Feed').all();\nreturn feed;\n");
  writeFileSync(path.join(dir2, "code", "amazon-feed.remote.js"), "// stale remote copy\n");

  const r = await cli("rename", "wf123", "Amazon Feed", "Amazon Export");
  assert.equal(r.code, 0, r.out);
  const wf = JSON.parse(read(dir2, "workflow.json"));
  assert.ok(wf.nodes.some((n: any) => n.name === "Amazon Export"), "node renamed");
  assert.equal(wf.connections["Transform: EU/US"].main[0][0].node, "Amazon Export", "connection target follows");
  assert.equal(wf.nodes.find((n: any) => n.id === "n4").parameters.value, "={{ $('Amazon Export').first().json.sku }}", "expression parameter follows");
  assert.match(read(dir2, "code", "transform-eu-us.js"), /\$\('Amazon Export'\)/);
  assert.ok(existsSync(path.join(dir2, "code", "amazon-export.ts")), "file renamed");
  assert.ok(!existsSync(path.join(dir2, "code", "amazon-feed.ts")), "old file gone");
  assert.ok(existsSync(path.join(dir2, "code", "amazon-export.remote.js")), ".remote.js sibling follows");
  assert.equal(state(dir2).nodes.n3.file, "code/amazon-export.ts");
  assert.match(read(dir2, "workflow.json"), /"\/\/@file:code\/amazon-export\.ts"/);
  unlinkSync(path.join(dir2, "code", "amazon-export.remote.js"));

  const rCheck = await cli("check", "--no-typecheck");
  assert.equal(rCheck.code, 0, rCheck.out);
  // the rewritten code still runs, with fixture data keyed by the NEW name
  writeFileSync(path.join(TMP, "fx-rename.json"), JSON.stringify({ nodes: { "Amazon Export": [{ json: { sku: "a-1" } }] } }));
  const rRun = await cli("run", path.join("workflows", "Order Sync v2", "code", "transform-eu-us.js"), "fx-rename.json");
  assert.equal(rRun.code, 0, rRun.out);
  assert.match(rRun.out, /returned 1 item/);
  // push propagates name + connections to the remote
  const rPush = await cli("push");
  assert.equal(rPush.code, 0, rPush.out);
  assert.equal(remoteNode("wf123", "n3").name, "Amazon Export");
  assert.equal(db.get("wf123").connections["Transform: EU/US"].main[0][0].node, "Amazon Export");
});

await step("rename: guards refuse unknown, colliding, and same names", async () => {
  let r = await cli("rename", "wf123", "Nope", "X");
  assert.equal(r.code, 1);
  assert.match(r.out, /no node named "Nope"/);
  r = await cli("rename", "wf123", "Webhook", "Amazon Export");
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists/);
  r = await cli("rename", "wf123", "Webhook", "Webhook");
  assert.equal(r.code, 1);
  assert.match(r.out, /already named/);
  r = await cli("rename", "wf123", "Webhook");
  assert.equal(r.code, 1);
  assert.match(r.out, /old and new node name/);
});

await step("rename --workflow: local name change, folder follows on pull", async () => {
  const r = await cli("rename", "wf123", "--workflow", "Order Sync Final");
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(read(wfDir("Order Sync v2"), "workflow.json")).name, "Order Sync Final");
  let r2 = await cli("push");
  assert.equal(r2.code, 0, r2.out);
  assert.equal(db.get("wf123").name, "Order Sync Final");
  r2 = await cli("pull");
  assert.equal(r2.code, 0, r2.out);
  assert.ok(existsSync(wfDir("Order Sync Final")), "folder renamed on pull");
  assert.ok(!existsSync(wfDir("Order Sync v2")), "old folder gone");
});

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} steps passed`);
