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
import { createStepRunner } from "./harness.mts";

const execFile = promisify(execFileCb);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");
const TMP = path.join(os.tmpdir(), `n8n-decanter-e2e-${process.pid}`);
const ROOT = path.join(TMP, "workflows");

// ---------- mock n8n ----------
const ALLOWED_PUT = ["name", "nodes", "connections", "settings", "staticData"];
const db = new Map<string, any>();
let putCount = 0; // total PUTs served — watch steps assert deltas
let slowPutMs = 0; // when > 0, PUT responses are delayed (queued-push test)
const server = http.createServer((req, res) => {
  if (req.headers["x-n8n-api-key"] !== "test-key") return void res.writeHead(401).end("unauthorized");
  if (req.url === "/api/v1/workflows/wf-hang") return; // never responds (timeout step)
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
      putCount++;
      const respond = () => {
        Object.assign(wf, sent, { updatedAt: new Date().toISOString() });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(wf));
      };
      if (slowPutMs > 0) setTimeout(respond, slowPutMs);
      else respond();
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
const wfDir = (name: string) => path.join(ROOT, name);
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");
const state = (dir: string) => JSON.parse(read(dir, ".decanter.json"));
const remoteNode = (id: string, nid: string) => db.get(id).nodes.find((n: any) => n.id === nid);
const { step, passedCount } = createStepRunner({
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
  // piped init prints a plain version line instead of the TTY logo
  assert.match(stdout + stderr, /n8n-decanter v\d+\.\d+\.\d+/);
  assert.ok(!(stdout + stderr).includes("\x1b"), "init must not emit ANSI when piped");
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
  assert.match(r.out, /pushed "Order Sync" \(wf123\) — published: code is live now/);
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
  assert.match(r.out, /Order Sync \(wf123\).*published/);
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
  const log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };
  await pushSingleNode(api, dir2, "n2", {}, log);
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
  const { N8nApi } = await import(pathToFileURL(path.join(PROJECT, "lib/api.mts")).href);
  const dir2 = wfDir("Order Sync v2");
  const js = path.join(dir2, "code", "transform-eu-us.js");
  const original = read(dir2, "code", "transform-eu-us.js");
  const api = new N8nApi({ host: env.N8N_HOST!, apiKey: "test-key" });
  const config = {
    configDir: TMP, root: ROOT, workflows: ["wf123"], commitOnPush: false, commitOnPull: false,
    browserReload: "off" as const, proxyPort: 0, requestTimeoutMs: 30_000, host: env.N8N_HOST!, apiKey: "test-key",
  };
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), ok: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(`E ${m}`) };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // TMP is not a git repo yet at this point — watch skips the startup pull
  const handle = await watchWorkflow(api, config, "wf123", {}, log);
  const before = putCount;
  try {
    // two rapid saves coalesce into a single push of the final content
    writeFileSync(js, "return $input.all(); // debounce-1\n");
    await sleep(30);
    writeFileSync(js, "return $input.all(); // debounce-2\n");
    await sleep(900);
    assert.equal(putCount - before, 1, "rapid saves must coalesce into one push:\n" + logs.join("\n"));
    assert.match(remoteNode("wf123", "n2").parameters.jsCode, /debounce-2/);
    // a save landing while a push is in flight is queued and re-pushed
    slowPutMs = 300;
    writeFileSync(js, "return $input.all(); // queued-1\n");
    await sleep(320); // debounce fired, PUT held open
    writeFileSync(js, "return $input.all(); // queued-2\n");
    await sleep(1500);
    slowPutMs = 0;
    assert.equal(putCount - before, 3, "queued save must trigger a follow-up push:\n" + logs.join("\n"));
    assert.match(remoteNode("wf123", "n2").parameters.jsCode, /queued-2/);
    // restore the synced content through watch itself, then stop
    writeFileSync(js, original);
    await sleep(900);
    assert.equal(putCount - before, 4, "restore push:\n" + logs.join("\n"));
  } finally {
    slowPutMs = 0;
    await handle.close();
  }
  writeFileSync(js, original + "// after-close\n");
  await sleep(600);
  assert.equal(putCount - before, 4, "no push after close()");
  writeFileSync(js, original); // silent restore — the watcher is closed
  assert.equal(remoteNode("wf123", "n2").parameters.jsCode, original);
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

await step("name refs: exact name and case-insensitive prefix resolve; unknown name lists candidates", async () => {
  let r = await cli("Order Sync v2", "status");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /structure: in sync/);
  r = await cli("order sy", "check", "--no-typecheck"); // unique case-insensitive prefix
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2: OK/);
  r = await cli("Order Sync v2", "push", "--no-typecheck"); // name push ≡ id push
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pushed "Order Sync v2" \(wf123\)/);
  // name-shaped ref with no match must error with the candidate list — no prompt
  r = await cli("No Such Flow", "status");
  assert.equal(r.code, 1);
  assert.match(r.out, /no workflow matches "No Such Flow"/);
  assert.match(r.out, /"Order Sync v2"/);
});

await step("list: name, id, and folder per pulled workflow; --remote adds unpulled ones", async () => {
  let r = await cli("list");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Order Sync v2  wf123  workflows[/\\]Order Sync v2/);
  db.set("wf777", { ...structuredClone(db.get("wf123")), id: "wf777", name: "Unpulled Flow" });
  try {
    r = await cli("list", "--remote");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Unpulled Flow  wf777  \(not pulled\)/);
    assert.match(r.out, /Order Sync v2  wf123/);
  } finally {
    db.delete("wf777");
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
  for (const w of ["pull", "push", "watch", "list", "--force", "wf123", "Order Sync v2"]) {
    assert.ok(words.includes(w), `__complete must emit "${w}": ${r.out}`);
  }
  assert.ok(!words.includes("__complete"), "__complete must not advertise itself");
});

await step("api timeout: a hung instance aborts with a clear error", async () => {
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
  let r = await cli("definitely-not-a-verb");
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes("    at "), "no stack without DEBUG: " + r.out);
  try {
    await execFile(process.execPath, [CLI, "definitely-not-a-verb"], { cwd: TMP, env: { ...env, DEBUG: "1" }, encoding: "utf8" });
    assert.fail("must exit non-zero");
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    assert.match((e.stdout ?? "") + (e.stderr ?? ""), /    at /, "DEBUG=1 must include the stack");
  }
});

const runOutput = (out: string) => {
  // The printed items are the last JSON array on stdout; cli() appends stderr
  // (e.g. warnings) afterwards, so bound the slice by the final closing bracket.
  const start = out.indexOf("[", out.indexOf("returned"));
  return JSON.parse(out.slice(start, out.lastIndexOf("]") + 1));
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
  let r = await cli("run", path.join("runtest-static", "SD.js"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { counter: 41, seen: ["a"] } }]);
  // fixture overrides per slice; the untouched slice keeps the workflow seed
  writeFileSync(path.join(rd, "fx.json"), JSON.stringify({ staticData: { global: { counter: 99 } } }));
  r = await cli("run", path.join("runtest-static", "SD.js"), path.join("runtest-static", "fx.json"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { counter: 99, seen: ["a"] } }]);
  // a bare file without workflow.json gets empty objects, not a ReferenceError
  const bare = path.join(TMP, "runtest-bare");
  mkdirSync(bare, { recursive: true });
  writeFileSync(path.join(bare, "bare.js"),
    "return [{ json: { empty: Object.keys($getWorkflowStaticData('global')).length === 0 } }];\n");
  r = await cli("run", path.join("runtest-bare", "bare.js"));
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(runOutput(r.out), [{ json: { empty: true } }]);
  // invalid scope errors clearly
  writeFileSync(path.join(bare, "badscope.js"), "return $getWorkflowStaticData('nope');\n");
  r = await cli("run", path.join("runtest-bare", "badscope.js"));
  assert.equal(r.code, 1);
  assert.match(r.out, /type must be "global" or "node"/);
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

const dirF = wfDir("Order Sync Final");

await step("ts conflict: local .ts and remote both changed → CONFLICT + .remote.js", async () => {
  const tsFile = path.join(dirF, "code", "amazon-export.ts");
  writeFileSync(tsFile, read(dirF, "code", "amazon-export.ts").replace("return rows.map", "const extra = 1;\nreturn rows.map"));
  const node = remoteNode("wf123", "n3");
  node.parameters.jsCode = node.parameters.jsCode.replace("rows.map", "rows.slice(0, 1).map");
  const r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CONFLICT — both code\/amazon-export\.ts and the remote code changed since last sync/);
  assert.match(read(dirF, "code", "amazon-export.remote.js"), /slice\(0, 1\)/);
  assert.match(read(dirF, "code", "amazon-export.ts"), /const extra = 1/); // .ts never clobbered
  // pull re-baselined lastPushedHash: the next push overwrites the remote edit by design
  let r2 = await cli("push");
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /unresolved remote copy/);
  assert.ok(!remoteNode("wf123", "n3").parameters.jsCode.includes("slice(0, 1)"), "push restored the TS-compiled version");
  r2 = await cli("pull"); // resync removes the now-stale .remote.js
  assert.equal(r2.code, 0, r2.out);
  assert.ok(!existsSync(path.join(dirF, "code", "amazon-export.remote.js")));
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

await step("push: aborts when a remote Code node is unknown locally", async () => {
  db.get("wf123").nodes.push({ id: "n5", name: "Report", type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 0], parameters: { jsCode: "return $input.all();\n" } });
  let r = await cli("push");
  assert.equal(r.code, 1, "push must abort on an unknown remote Code node: " + r.out);
  assert.match(r.out, /node "Report" exists remotely but is unknown locally/);
  assert.match(r.out, /pull first/);
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

await step("rename: kebab collision falls back to -<id8>; .remote.js content untouched", async () => {
  // "Transform EU US" kebabs to the same base as "Transform: EU/US" (n2's file)
  writeFileSync(path.join(dirF, "code", "report.remote.js"), "const x = $('Report');\n");
  const r = await cli("rename", "wf123", "Report", "Transform EU US");
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(path.join(dirF, "code", "transform-eu-us-n5.js")), "collision suffix used");
  assert.ok(!existsSync(path.join(dirF, "code", "report.js")), "old file gone");
  assert.equal(state(dirF).nodes.n5.file, "code/transform-eu-us-n5.js");
  // the sibling followed the rename, but its content is a remote snapshot — never rewritten
  assert.equal(read(dirF, "code", "transform-eu-us-n5.remote.js"), "const x = $('Report');\n");
  unlinkSync(path.join(dirF, "code", "transform-eu-us-n5.remote.js"));
  const rPush = await cli("push");
  assert.equal(rPush.code, 0, rPush.out);
  assert.equal(remoteNode("wf123", "n5").name, "Transform EU US");
});

await step("node deleted remotely: status warns, pull drops state, file kept", async () => {
  const wf = db.get("wf123");
  wf.nodes = wf.nodes.filter((n: any) => n.id !== "n6collide");
  let r = await cli("status");
  assert.equal(r.code, 1, "remotely deleted node counts as remote drift: " + r.out);
  assert.match(r.out, /code\/report-n6collid\.js: node n6collide deleted remotely/);
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /node n6collide \("code\/report-n6collid\.js"\) no longer exists remotely — removing from state/);
  assert.ok(existsSync(path.join(dirF, "code", "report-n6collid.js")), "file kept — git is the safety net");
  assert.equal(state(dirF).nodes.n6collide, undefined);
  // the kept file is an orphan now; the guard flags it until it's removed
  r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1);
  assert.match(r.out, /orphan code file code\/report-n6collid\.js/);
  unlinkSync(path.join(dirF, "code", "report-n6collid.js"));
});

await step("pull: workflow rename to an occupied folder name warns, keeps the folder", async () => {
  mkdirSync(wfDir("Occupied"), { recursive: true });
  writeFileSync(path.join(wfDir("Occupied"), "note.txt"), "not a workflow\n");
  db.get("wf123").name = "Occupied";
  let r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /workflow renamed to "Occupied" but .* already exists — keeping/);
  assert.ok(existsSync(dirF), "old folder kept");
  db.get("wf123").name = "Order Sync Final";
  r = await cli("pull");
  assert.equal(r.code, 0, r.out);
  rmSync(wfDir("Occupied"), { recursive: true, force: true });
});

await step("corrupt .decanter.json: scoped guard error, other workflows unaffected", async () => {
  const dirC = wfDir("Corrupted");
  mkdirSync(path.join(dirC, "code"), { recursive: true });
  writeFileSync(path.join(dirC, ".decanter.json"), "{ definitely not json");
  writeFileSync(path.join(dirC, "workflow.json"), JSON.stringify({ nodes: [], connections: {} }));
  // check: a scoped error for the broken folder; the healthy workflow still passes
  let r = await cli("check", "--no-typecheck");
  assert.equal(r.code, 1, "check must fail on the corrupt state file: " + r.out);
  assert.match(r.out, /Corrupted: corrupt \.decanter\.json \(/);
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

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passedCount()} steps passed`);
