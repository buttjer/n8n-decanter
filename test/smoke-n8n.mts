// Dev-only integration smoke against a real n8n in Docker (plans/15).
// Opt-in: `npm run test:smoke` — never part of `npm test`. Needs a running
// Docker daemon; fails fast with a clear message otherwise.
//
// Black-box by design: drives the CLI as a subprocess and talks to n8n with
// plain fetch — no lib/ imports, so nothing here can accidentally share a
// bug with the code under test.
//
// Env knobs: SMOKE_N8N_TAG overrides the pinned image tag (version-bump
// testing); SMOKE_KEEP=1 keeps the container alive after the run.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createStepRunner } from "./harness.mts";

const execFile = promisify(execFileCb);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");

// Pinned tag = the version this suite last passed against (n8n 2.x line).
const IMAGE = process.env.SMOKE_N8N_TAG ?? "n8nio/n8n:2.30.7";
const CONTAINER = `decanter-smoke-${process.pid}`;
const OWNER = { email: "smoke@decanter.test", firstName: "Smoke", lastName: "Test", password: "Sm0ke-Test-Pass!" };

const docker = (...args: string[]) => execFile("docker", args, { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- preflight ----------
try {
  await docker("version", "--format", "{{.Server.Version}}");
} catch {
  console.error("docker daemon not reachable — start Docker Desktop (or the docker service) and re-run `npm run test:smoke`");
  process.exit(2);
}

// ---------- container ----------
console.log(`booting ${IMAGE} …`);
await docker(
  "run", "-d", "--name", CONTAINER, "-p", "127.0.0.1::5678",
  "-e", "N8N_SECURE_COOKIE=false",
  "-e", "N8N_DIAGNOSTICS_ENABLED=false",
  "-e", "N8N_PERSONALIZATION_ENABLED=false",
  IMAGE,
);
const teardown = async (): Promise<void> => {
  if (process.env.SMOKE_KEEP === "1") {
    console.error(`SMOKE_KEEP=1 — container ${CONTAINER} left running`);
    return;
  }
  await docker("rm", "-f", CONTAINER).catch(() => {});
};
process.on("SIGINT", () => void teardown().then(() => process.exit(130)));

let HOST = "";
let KEY = "";
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-smoke-"));
const ROOT = path.join(TMP, "workflows");

const { step, passedCount } = createStepRunner({
  onFail: () => {
    console.error(`work dir kept: ${TMP}`);
    void teardown();
  },
});

// ---------- helpers ----------
/** Public-API request against the container (the "second client" in drift tests). */
async function api(method: string, pathname: string, body?: unknown, key: string = KEY): Promise<any> {
  const res = await fetch(HOST + pathname, {
    method,
    headers: { "X-N8N-API-KEY": key, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

let env: NodeJS.ProcessEnv;
async function cli(...args: string[]) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...args], { cwd: TMP, env, encoding: "utf8" });
    return { out: stdout + stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.code ?? 1 };
  }
}
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");
const webhook = async (payload: unknown): Promise<any> => {
  let last = "";
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${HOST}/webhook/smoke-hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    last = `${res.status}: ${text.slice(0, 400)}`;
    if (res.ok && text) return JSON.parse(text);
    await sleep(1500); // webhook registration lags activation
  }
  let execInfo = "";
  try {
    const page = await api("GET", "/api/v1/executions?includeData=true&limit=1");
    const e = page.data?.[0];
    execInfo = JSON.stringify({ status: e?.status, error: e?.data?.resultData?.error?.message ?? e?.data?.resultData?.error }).slice(0, 600);
  } catch { /* diagnostics only */ }
  throw new Error(`webhook gave no usable response; last: ${last}; lastExec: ${execInfo}`);
};

/** The seeded workflow: Webhook -> Compute (Code) -> Respond. */
const seedWorkflow = () => ({
  name: "Smoke WF",
  nodes: [
    { id: "w1", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0],
      parameters: { httpMethod: "POST", path: "smoke-hook", responseMode: "responseNode" } },
    { id: "c1", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0],
      parameters: { jsCode: "const n = Number($input.first().json.body.n ?? 0);\nreturn [{ json: { doubled: n * 2 } }];\n" } },
    { id: "r1", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [440, 0],
      parameters: { respondWith: "allIncomingItems" } },
  ],
  connections: {
    Webhook: { main: [[{ node: "Compute", type: "main", index: 0 }]] },
    Compute: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
  },
  settings: { executionOrder: "v1" },
});

let wfId = "";
let wfDir = ""; // resolved after the first pull
let computeFile = "compute.js"; // tracked across rename/convert steps

// ---------- run ----------
try {
  await step("boot: n8n healthy AND ready in docker", async () => {
    const { stdout } = await docker("port", CONTAINER, "5678");
    HOST = `http://${stdout.trim().split("\n")[0]}`;
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i++) {
      healthy = await fetch(`${HOST}/healthz`).then((r) => r.ok).catch(() => false);
      if (!healthy) await sleep(2000);
    }
    assert.ok(healthy, `n8n did not become healthy at ${HOST}`);
    // /healthz is liveness only, and warm-up mode answers EVERY route with a
    // 200 "n8n is starting up" placeholder — readiness means /rest/settings
    // returns actual JSON, nothing less.
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      ready = await fetch(`${HOST}/rest/settings`)
        .then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("application/json"))
        .catch(() => false);
      if (!ready) await sleep(2000);
    }
    assert.ok(ready, "REST routes never served real JSON (still in warm-up?)");
  });

  await step("bootstrap: owner setup, login, API key (the version-fragile part)", async () => {
    // Set-Cookie is special-cased in fetch — getSetCookie(), not headers.get()
    const authCookie = (r: Response) => r.headers.getSetCookie().join("; ").match(/n8n-auth=[^;]+/)?.[0];
    const setup = await fetch(`${HOST}/rest/owner/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OWNER),
    });
    assert.ok(setup.ok, `owner setup failed: ${setup.status} ${await setup.text()}`);
    let cookie = authCookie(setup);
    const attempts: string[] = [`setup ${setup.status} cookies=${JSON.stringify(setup.headers.getSetCookie())}`];
    // a cold instance can accept the setup but lag on issuing auth cookies — retry login briefly
    for (let i = 0; i < 5 && !cookie; i++) {
      const login = await fetch(`${HOST}/rest/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailOrLdapLoginId: OWNER.email, password: OWNER.password }),
      });
      attempts.push(`login ${login.status} cookies=${JSON.stringify(login.headers.getSetCookie())} body=${(await login.text()).slice(0, 120)}`);
      cookie = authCookie(login);
      if (!cookie) await sleep(2000);
    }
    assert.ok(cookie, `no n8n-auth cookie from setup or login:\n  ${attempts.join("\n  ")}`);
    const keyRes = await fetch(`${HOST}/rest/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        label: "decanter-smoke",
        scopes: ["workflow:create", "workflow:read", "workflow:update", "workflow:list", "workflow:activate", "execution:read", "execution:list", "tag:create", "tag:read", "workflowTags:update", "workflowTags:list"],
        expiresAt: null,
      }),
    });
    const keyText = await keyRes.text();
    assert.ok(keyRes.ok, `api key creation failed: ${keyRes.status} ${keyText}`);
    KEY = JSON.parse(keyText).data.rawApiKey;
    assert.ok(KEY, "no rawApiKey in response");
  });

  await step("seed: workflow created via the public API (2.x has POST /workflows)", async () => {
    const created = await api("POST", "/api/v1/workflows", seedWorkflow());
    wfId = created.id;
    assert.ok(wfId, "no id on created workflow");
    writeFileSync(path.join(TMP, ".env"), `N8N_HOST=${HOST}\nN8N_API_KEY=${KEY}\n`);
    writeFileSync(path.join(TMP, "decanter.config.json"),
      JSON.stringify({ root: "./workflows", workflows: [wfId], commitOnPush: false, commitOnPull: false }, null, 2));
    env = { ...process.env, N8N_HOST: HOST, N8N_API_KEY: KEY };
  });

  await step("pull: real workflow lands in the decanter layout", async () => {
    const r = await cli("pull");
    assert.equal(r.code, 0, r.out);
    wfDir = path.join(ROOT, "Smoke WF");
    assert.ok(existsSync(path.join(wfDir, "code", "compute.js")), "code/compute.js extracted");
    assert.match(read(wfDir, "workflow.json"), /"\/\/@file:code\/compute\.js"/);
    assert.match(read(wfDir, "code", "compute.js"), /doubled: n \* 2/);
  });

  await step("no false drift: pull→push→status stays in sync against real PUT normalization", async () => {
    let r = await cli("push");
    assert.equal(r.code, 0, r.out);
    r = await cli("status");
    assert.equal(r.code, 0, "status must be in sync after push: " + r.out);
    assert.match(r.out, /structure: in sync/);
    assert.match(r.out, /Compute: in sync/);
    assert.ok(!r.out.includes("push pending"), "no false local drift: " + r.out);
    r = await cli("push");
    assert.equal(r.code, 0, r.out);
    r = await cli("status");
    assert.equal(r.code, 0, "still in sync after second push: " + r.out);
    r = await cli("pull");
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(path.join(wfDir, "code", "compute.remote.js")), "no conflict artifact from normalization");
  });

  await step("marker survival: TS push round-trips the @ts-n8n line byte-intact", async () => {
    unlinkSync(path.join(wfDir, "code", "compute.js"));
    writeFileSync(path.join(wfDir, "code", "compute.ts"),
      "interface Payload { n?: number }\nconst body = $input.first().json.body as Payload;\nconst n = Number(body.n ?? 0);\nreturn [{ json: { doubled: n * 2 } }];\n");
    writeFileSync(path.join(wfDir, "workflow.json"),
      read(wfDir, "workflow.json").replace("//@file:code/compute.js", "//@file:code/compute.ts"));
    computeFile = "compute.ts";
    let r = await cli("push");
    assert.equal(r.code, 0, r.out);
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    const jsCode: string = remote.nodes.find((n: any) => n.id === "c1").parameters.jsCode;
    assert.match(jsCode, /\n\/\/ @ts-n8n sha256:[0-9a-f]{64}$/, "marker must come back byte-intact — TS-managed detection depends on it");
    r = await cli("pull");
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(path.join(wfDir, "code", "compute.remote.js")), "TS round-trip in sync");
    assert.match(read(wfDir, "code", "compute.ts"), /interface Payload/, ".ts never touched by pull");
  });

  await step("bundled imports execute in the real Code-node sandbox", async () => {
    mkdirSync(path.join(TMP, "shared"), { recursive: true });
    writeFileSync(path.join(TMP, "shared", "math.ts"),
      "export function double(n: number): number {\n  return n * 2;\n}\n");
    const pkg = path.join(TMP, "node_modules", "tiny-add");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "tiny-add", version: "1.0.0", main: "index.js" }));
    writeFileSync(path.join(pkg, "index.js"), "exports.add = (a, b) => a + b;\n");
    const cfg = JSON.parse(read(TMP, "decanter.config.json"));
    writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ ...cfg, bundleDependencies: ["tiny-add"] }, null, 2));
    writeFileSync(path.join(wfDir, "code", "compute.ts"), [
      'import { double } from "../../../shared/math";',
      'import { add } from "tiny-add";',
      "const n = Number(($input.first().json.body as { n?: number }).n ?? 0);",
      "return [{ json: { doubled: double(n), plus: add(n, 100) } }];",
      "",
    ].join("\n"));
    let r = await cli("push");
    assert.equal(r.code, 0, r.out);
    await api("POST", `/api/v1/workflows/${wfId}/activate`);
    await sleep(1500); // webhook registration
    const out = await webhook({ n: 21 });
    assert.deepEqual(out, [{ doubled: 42, plus: 121 }], `bundled node must compute through shared/ AND the npm package: ${JSON.stringify(out)}`);
  });

  await step("each-item mode: bundled node under runOnceForEachItem", async () => {
    const wf = JSON.parse(read(wfDir, "workflow.json"));
    const compute = wf.nodes.find((n: any) => n.id === "c1");
    compute.parameters.mode = "runOnceForEachItem";
    writeFileSync(path.join(wfDir, "workflow.json"), JSON.stringify(wf, null, 2));
    writeFileSync(path.join(wfDir, "code", "compute.ts"), [
      'import { double } from "../../../shared/math";',
      "const n = Number(($json.body as { n?: number }).n ?? 0);",
      "return { json: { doubled: double(n), mode: 'each' } };",
      "",
    ].join("\n"));
    const r = await cli("push"); // structural + code change; workflow is active -> goes live
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /published: code is live now/, "active 2.x workflow auto-publishes on push: " + r.out);
    await sleep(1000);
    const out = await webhook({ n: 5 });
    assert.deepEqual(out, [{ doubled: 10, mode: "each" }], JSON.stringify(out));
  });

  await step("publish semantics: draft push stays draft, active push goes live", async () => {
    const second = await api("POST", "/api/v1/workflows", {
      ...seedWorkflow(),
      name: "Smoke Draft",
      nodes: seedWorkflow().nodes.map((n: any) => (n.id === "w1" ? { ...n, parameters: { ...n.parameters, path: "smoke-draft" } } : n)),
    });
    const cfg = JSON.parse(read(TMP, "decanter.config.json"));
    writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ ...cfg, workflows: [wfId, second.id] }, null, 2));
    let r = await cli(second.id, "pull");
    assert.equal(r.code, 0, r.out);
    const draftDir = path.join(ROOT, "Smoke Draft");
    writeFileSync(path.join(draftDir, "code", "compute.js"), "return [{ json: { draft: true } }];\n");
    r = await cli(second.id, "push");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /unpublished: draft only/, "inactive workflow must stay a draft: " + r.out);
    const remote = await api("GET", `/api/v1/workflows/${second.id}`);
    assert.equal(remote.active, false, "push must not activate an inactive workflow");
  });

  await step("drift guard vs a real second client; --force wins; pull re-baselines", async () => {
    // second client: raw public-API PUT bumping the Compute code
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    const put = {
      name: remote.name,
      nodes: remote.nodes.map((n: any) => (n.id === "c1"
        ? { ...n, parameters: { ...n.parameters, jsCode: n.parameters.jsCode.replace("return", "// ui edit\nreturn") } }
        : n)),
      connections: remote.connections,
      settings: remote.settings ?? {},
    };
    await api("PUT", `/api/v1/workflows/${wfId}`, put);
    // local edit too -> conflict
    writeFileSync(path.join(wfDir, "code", "compute.ts"),
      read(wfDir, "code", "compute.ts").replace("mode: 'each'", "mode: 'forced'"));
    let r = await cli(wfId, "push");
    assert.equal(r.code, 1, "push must abort on real remote drift: " + r.out);
    assert.match(r.out, /pull first|--force/, r.out);
    r = await cli(wfId, "push", "--force");
    assert.equal(r.code, 0, "--force must override the drift guard: " + r.out);
    r = await cli(wfId, "pull");
    assert.equal(r.code, 0, r.out);
    r = await cli(wfId, "status");
    assert.equal(r.code, 0, "in sync after force push + pull: " + r.out);
    await sleep(1000);
    const out = await webhook({ n: 2 });
    assert.deepEqual(out, [{ doubled: 4, mode: "forced" }], JSON.stringify(out));
  });

  await step("rename with a unicode name propagates and keeps executing", async () => {
    let r = await cli("rename", wfId, "Compute", "Ümläut Nödé");
    assert.equal(r.code, 0, r.out);
    const renamed = JSON.parse(read(TMP, "decanter.config.json")); // config untouched by rename
    assert.ok(renamed.workflows.includes(wfId));
    const files = read(wfDir, "workflow.json");
    assert.match(files, /"Ümläut Nödé"/);
    r = await cli(wfId, "push");
    assert.equal(r.code, 0, r.out);
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    assert.equal(remote.nodes.find((n: any) => n.id === "c1").name, "Ümläut Nödé", "real n8n accepted the rename");
    assert.ok(remote.connections["Ümläut Nödé"], "rewritten connections accepted");
    await sleep(1000);
    const out = await webhook({ n: 3 });
    assert.deepEqual(out, [{ doubled: 6, mode: "forced" }], "workflow still executes after rename: " + JSON.stringify(out));
    r = await cli(wfId, "pull");
    assert.equal(r.code, 0, r.out);
    r = await cli(wfId, "status");
    assert.equal(r.code, 0, "in sync after rename round-trip: " + r.out);
  });

  await step("tags survive an untouched pull→push round-trip", async () => {
    const tag = await api("POST", "/api/v1/tags", { name: "smoke-tag" });
    await api("PUT", `/api/v1/workflows/${wfId}/tags`, [{ id: tag.id }]);
    let r = await cli(wfId, "pull");
    assert.equal(r.code, 0, r.out);
    r = await cli(wfId, "push");
    assert.equal(r.code, 0, r.out);
    const tags = await api("GET", `/api/v1/workflows/${wfId}/tags`);
    assert.ok(Array.isArray(tags) && tags.some((t: any) => t.name === "smoke-tag"), `tags survived: ${JSON.stringify(tags)}`);
  });

  await step("error surfaces: bad key -> clean 401, unknown id -> clean 404", async () => {
    const badEnv = { ...env, N8N_API_KEY: "definitely-wrong" };
    try {
      await execFile(process.execPath, [CLI, "status", wfId], { cwd: TMP, env: badEnv, encoding: "utf8" });
      assert.fail("must exit non-zero with a bad key");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      assert.match(out, /401/, "401 surfaced: " + out);
      assert.ok(!out.includes("    at "), "no stack trace without DEBUG: " + out);
    }
    const r = await cli("status", "aaaaaaaaaaaaaaaa");
    assert.equal(r.code, 1);
    assert.match(r.out, /404/, r.out);
  });

  await step("executions API: shape matches what Plan 3 C designs against", async () => {
    const page = await api("GET", "/api/v1/executions?includeData=true&limit=5");
    assert.ok(Array.isArray(page.data) && page.data.length > 0, "executions recorded");
    const exec = page.data.find((e: any) => e.workflowId === wfId && e.status === "success");
    assert.ok(exec, "a successful execution of the smoke workflow exists");
    const runData = exec.data?.resultData?.runData;
    assert.ok(runData?.Webhook && runData?.["Ümläut Nödé"], `runData keyed by node name: ${runData && Object.keys(runData).join(",")}`);
    const items = runData["Ümläut Nödé"][0]?.data?.main?.[0];
    assert.ok(Array.isArray(items) && items[0]?.json, "items under data.main[0][] with .json");
    assert.equal(typeof exec.workflowVersionId, "string", "2.x records workflowVersionId per execution");
  });
} finally {
  await teardown();
  if (process.exitCode !== 1) rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passedCount()} smoke steps passed against ${IMAGE}`);
process.exit(0);
