// Dev-only integration smoke against a real n8n in Docker (plans/15).
// Opt-in: `npm run test:smoke` — never part of `npm test`. Needs a running
// Docker daemon; fails fast with a clear message otherwise.
//
// Black-box by design: drives the CLI as a subprocess and talks to n8n with
// plain fetch — no lib/ imports, so nothing here can accidentally share a
// bug with the code under test. One deliberate exception: the structural-
// watch step drives lib/watch.mts in-process (same as the e2e watch step) —
// watch is interactive and long-running, unscriptable as a subprocess
// without a pty, and in-process log capture is what the asserts need.
//
// Env knobs: SMOKE_N8N_TAG overrides the pinned image tag (version-bump
// testing); SMOKE_KEEP=1 keeps the container alive after the run.
//
// Version matrix (Plan 22): the CI `smoke` job (cron + manual dispatch only)
// runs this suite against a small, named set of 2.x tags via SMOKE_N8N_TAG —
// oldest-supported, a middle release, and latest — so the "n8n 2.x" contract
// (PLAN.md) is asserted across the line, not just one pinned point release.
// Passing set, last verified 2026-07-20: n8nio/n8n:2.30.7 (oldest supported —
// the floor Plan 18's pinData seeding needs), 2.31.0 (middle), 2.31.4
// (latest at verification time). Keep this list and .github/workflows/ci.yml's
// `smoke` matrix in sync.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
let COOKIE = ""; // owner session cookie — kept so a step can mint a scoped-down key
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-smoke-"));
const ROOT = path.join(TMP, "workflows");

const { step, passedCount, hasFailed } = createStepRunner({
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
const webhook = async (payload: unknown, path = "smoke-hook"): Promise<any> => {
  let last = "";
  // bounded poll (12 x 750ms = 9s budget) for webhook registration lagging
  // activation/push — callers used to pad this with a fixed pre-sleep too;
  // polling here already covers the lag, on the fast path *and* the slow one
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${HOST}/webhook/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    last = `${res.status}: ${text.slice(0, 400)}`;
    if (res.ok && text) return JSON.parse(text);
    await sleep(750);
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
    // Every assertion here names IMAGE explicitly: this bootstrap sequence
    // (undocumented REST endpoints, not the public API) is what actually
    // changes shape between n8n versions — a failure here means "this
    // version's setup/login/api-key flow changed", not "decanter broke".
    const versionNote = `against ${IMAGE} — if this only fails on a version bump, the bootstrap sequence changed shape, not decanter`;
    // Set-Cookie is special-cased in fetch — getSetCookie(), not headers.get()
    const authCookie = (r: Response) => r.headers.getSetCookie().join("; ").match(/n8n-auth=[^;]+/)?.[0];
    const setup = await fetch(`${HOST}/rest/owner/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OWNER),
    });
    assert.ok(setup.ok, `owner setup failed ${versionNote}: ${setup.status} ${await setup.text()}`);
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
    assert.ok(cookie, `no n8n-auth cookie from setup or login ${versionNote}:\n  ${attempts.join("\n  ")}`);
    COOKIE = cookie;
    const keyRes = await fetch(`${HOST}/rest/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        // dataTable:* write scopes are for the data-tables step to *seed* a
        // table + rows; the CLI itself only ever reads (list/read/columns/rows).
        label: "decanter-smoke",
        scopes: ["workflow:create", "workflow:read", "workflow:update", "workflow:delete", "workflow:list", "workflow:activate", "workflow:deactivate", "execution:read", "execution:list", "tag:create", "tag:read", "workflowTags:update", "workflowTags:list", "dataTable:create", "dataTable:list", "dataTable:read", "dataTableColumn:create", "dataTableColumn:read", "dataTableRow:create", "dataTableRow:read"],
        expiresAt: null,
      }),
    });
    const keyText = await keyRes.text();
    assert.ok(keyRes.ok, `api key creation failed ${versionNote}: ${keyRes.status} ${keyText}`);
    KEY = JSON.parse(keyText).data.rawApiKey;
    assert.ok(KEY, `no rawApiKey in response ${versionNote}`);
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
    wfDir = path.join(ROOT, "smoke-wf");
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
    const out = await webhook({ n: 21 }); // its own bounded poll covers webhook registration lag
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
    let r = await cli("pull", second.id);
    assert.equal(r.code, 0, r.out);
    const draftDir = path.join(ROOT, "smoke-draft");
    writeFileSync(path.join(draftDir, "code", "compute.js"), "return [{ json: { draft: true } }];\n");
    r = await cli("push", second.id);
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
    let r = await cli("push", wfId);
    assert.equal(r.code, 1, "push must abort on real remote drift: " + r.out);
    assert.match(r.out, /pull first|--force/, r.out);
    r = await cli("push", wfId, "--force");
    assert.equal(r.code, 0, "--force must override the drift guard: " + r.out);
    r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    r = await cli("status", wfId);
    assert.equal(r.code, 0, "in sync after force push + pull: " + r.out);
    const out = await webhook({ n: 2 });
    assert.deepEqual(out, [{ doubled: 4, mode: "forced" }], JSON.stringify(out));
  });

  await step("rename with a unicode name propagates and keeps executing", async () => {
    let r = await cli("node", "rename", wfId, "Compute", "Ümläut Nödé");
    assert.equal(r.code, 0, r.out);
    const renamed = JSON.parse(read(TMP, "decanter.config.json")); // config untouched by rename
    assert.ok(renamed.workflows.includes(wfId));
    const files = read(wfDir, "workflow.json");
    assert.match(files, /"Ümläut Nödé"/);
    r = await cli("push", wfId);
    assert.equal(r.code, 0, r.out);
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    assert.equal(remote.nodes.find((n: any) => n.id === "c1").name, "Ümläut Nödé", "real n8n accepted the rename");
    assert.ok(remote.connections["Ümläut Nödé"], "rewritten connections accepted");
    const out = await webhook({ n: 3 });
    assert.deepEqual(out, [{ doubled: 6, mode: "forced" }], "workflow still executes after rename: " + JSON.stringify(out));
    r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    r = await cli("status", wfId);
    assert.equal(r.code, 0, "in sync after rename round-trip: " + r.out);
  });

  await step("tags survive an untouched pull→push round-trip", async () => {
    const tag = await api("POST", "/api/v1/tags", { name: "smoke-tag" });
    await api("PUT", `/api/v1/workflows/${wfId}/tags`, [{ id: tag.id }]);
    let r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    r = await cli("push", wfId);
    assert.equal(r.code, 0, r.out);
    const tags = await api("GET", `/api/v1/workflows/${wfId}/tags`);
    assert.ok(Array.isArray(tags) && tags.some((t: any) => t.name === "smoke-tag"), `tags survived: ${JSON.stringify(tags)}`);
  });

  await step("pinData: public-API seeding survives an untouched pull→push round-trip", async () => {
    // Plan 18's live probe: n8n >= 2.30.7 accepts pinData on the public-API
    // PUT (the recorded "cannot set it" was a 1.x-era claim); a failure here
    // throws with the server's status+body — that is the disproof signal.
    const seed = { Webhook: [{ json: { smoke: "pinned" } }] };
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    await api("PUT", `/api/v1/workflows/${wfId}`, {
      name: remote.name,
      nodes: remote.nodes,
      connections: remote.connections,
      settings: remote.settings ?? {},
      pinData: seed,
    });
    let got = await api("GET", `/api/v1/workflows/${wfId}`);
    assert.deepEqual(got.pinData, seed, `public API persists seeded pinData: ${JSON.stringify(got.pinData)}`);
    // decanter's PUT never sends pinData — the server must keep its stored copy
    let r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    r = await cli("push", wfId);
    assert.equal(r.code, 0, r.out);
    got = await api("GET", `/api/v1/workflows/${wfId}`);
    assert.deepEqual(got.pinData, seed, `pinData survives the round-trip: ${JSON.stringify(got.pinData)}`);
  });

  await step("structural watch: clean push, no phantom re-push, conflict detected", async () => {
    // Plan 12 residue: does the real PUT response's structure hash match the
    // local file (baseline = response hash — a mismatch means every no-op
    // save phantom-re-pushes), and does a real concurrent edit -> conflict?
    const { watchWorkflow } = await import(pathToFileURL(path.join(PROJECT, "lib", "watch.mts")).href);
    const { N8nApi } = await import(pathToFileURL(path.join(PROJECT, "lib", "api.mts")).href);
    const apiClient = new N8nApi({ host: HOST, apiKey: KEY });
    const config = {
      configDir: TMP, root: ROOT, workflows: [wfId], commitOnPush: false, commitOnPull: false,
      browserReload: "off" as const, proxyPort: 0, requestTimeoutMs: 30_000, host: HOST, apiKey: KEY,
    };
    const logs: string[] = [];
    const capture = (m: string) => logs.push(m);
    const log = { info: capture, ok: capture, warn: capture, error: capture };
    const wfJson = path.join(wfDir, "workflow.json");
    const setPosition = (pos: [number, number]): void => {
      const wf = JSON.parse(read(wfJson));
      wf.nodes.find((n: any) => n.id === "c1").position = pos;
      writeFileSync(wfJson, JSON.stringify(wf, null, 2));
    };
    // non-TTY stdin so the conflict prompt skips instead of hanging the suite
    const stdinWasTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    const handle = await watchWorkflow(apiClient, config, wfId, {}, log);
    try {
      // TMP is not a git repo — watch must warn and skip the startup pull
      assert.ok(logs.some((m) => m.includes("no git safety net")), logs.join("\n"));
      // clean structural push: a position move lands on the real instance
      setPosition([222, 2]);
      await sleep(2500);
      let remote = await api("GET", `/api/v1/workflows/${wfId}`);
      assert.deepEqual(remote.nodes.find((n: any) => n.id === "c1").position, [222, 2],
        "structural save must reach n8n:\n" + logs.join("\n"));
      // phantom re-push check: baseline is now the PUT *response* hash — if
      // real n8n normalized any PUT-accepted field, this no-op save would
      // GET+push again instead of staying silent (anti-loop branch)
      const updatedAt = remote.updatedAt;
      const logCount = logs.length;
      writeFileSync(wfJson, read(wfJson)); // same bytes, new fs event
      await sleep(2500);
      remote = await api("GET", `/api/v1/workflows/${wfId}`);
      assert.equal(remote.updatedAt, updatedAt, "no phantom re-push after a no-op save");
      assert.equal(logs.length, logCount, "anti-loop skip must be silent:\n" + logs.slice(logCount).join("\n"));
      // second client changes the structure remotely, local edit differs -> conflict
      await api("PUT", `/api/v1/workflows/${wfId}`, {
        name: remote.name,
        nodes: remote.nodes.map((n: any) => (n.id === "c1" ? { ...n, position: [444, 4] } : n)),
        connections: remote.connections,
        settings: remote.settings ?? {},
      });
      setPosition([333, 3]);
      await sleep(2500);
      assert.ok(logs.some((m) => m.includes("structural conflict")), "conflict detected:\n" + logs.join("\n"));
      assert.ok(logs.some((m) => m.includes("non-interactive session")), "non-TTY skips the prompt:\n" + logs.join("\n"));
      remote = await api("GET", `/api/v1/workflows/${wfId}`);
      assert.deepEqual(remote.nodes.find((n: any) => n.id === "c1").position, [444, 4],
        "skipped conflict must leave the remote untouched");
    } finally {
      process.stdin.isTTY = stdinWasTty;
      await handle.close();
    }
    // resolve like the prompt's [r] would, out-of-band: pull re-baselines
    let r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    r = await cli("status", wfId);
    assert.equal(r.code, 0, "in sync after conflict resolution: " + r.out);
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

  await step("version fields: GET carries versionId (draft) and activeVersionId (published)", async () => {
    // Plan 20 task 2 live gate: both fields present; activeVersionId == versionId
    // on an in-sync published workflow (wfId has been pushed while active).
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    assert.equal(typeof remote.versionId, "string", "2.x GET carries the draft versionId");
    assert.ok("activeVersionId" in remote, "2.x GET carries activeVersionId");
    assert.equal(remote.active, true, "wfId is published from earlier steps");
    assert.equal(remote.activeVersionId, remote.versionId, "published & in sync: live version == draft");
  });

  await step("lifecycle verbs: create → push → publish → unpublish → delete round-trip", async () => {
    // create a blank draft on the server via the CLI, born unpublished
    let r = await cli("create", "Smoke Lifecycle");
    assert.equal(r.code, 0, r.out);
    const lifeId = r.out.match(/created "Smoke Lifecycle" \(([^)]+)\)/)?.[1];
    assert.ok(lifeId, "create printed the new id: " + r.out);
    const lifeDir = path.join(ROOT, "smoke-lifecycle");
    assert.ok(existsSync(path.join(lifeDir, ".decanter.json")), "create pulled the folder");
    let remote = await api("GET", `/api/v1/workflows/${lifeId}`);
    assert.equal(remote.active, false, "born unpublished");
    assert.equal(remote.activeVersionId, null, "unpublished → no active version");

    // give it a trigger so it can go live, then push (stays draft while unpublished)
    const wf = JSON.parse(read(lifeDir, "workflow.json"));
    wf.nodes = [{ id: "lh1", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { httpMethod: "POST", path: "smoke-life-hook" } }];
    wf.connections = {};
    writeFileSync(path.join(lifeDir, "workflow.json"), JSON.stringify(wf, null, 2));
    r = await cli("push", lifeId);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /unpublished: draft only/, "push to an unpublished workflow stays draft: " + r.out);

    // publish → live; activeVersionId now matches the draft
    r = await cli("publish", lifeId);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /published "Smoke Lifecycle" \([^)]+\) — code is live now/);
    remote = await api("GET", `/api/v1/workflows/${lifeId}`);
    assert.equal(remote.active, true, "publish took it live");
    assert.equal(remote.activeVersionId, remote.versionId, "publish set activeVersionId to the draft");
    // publish again → no-op-with-a-note
    r = await cli("publish", lifeId);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /is already published/);

    // unpublish → draft only
    r = await cli("unpublish", lifeId);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /unpublished "Smoke Lifecycle" \([^)]+\) — draft only/);
    remote = await api("GET", `/api/v1/workflows/${lifeId}`);
    assert.equal(remote.active, false, "unpublish returned it to draft-only");

    // delete needs a ref (never touches config)
    r = await cli("delete");
    assert.equal(r.code, 1);
    assert.match(r.out, /delete needs a workflow ref/);
    // delete --force → hard delete even after publish/unpublish; local folder kept
    r = await cli("delete", lifeId, "--force");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /deleted "Smoke Lifecycle" \([^)]+\) from the server/);
    const gone = await fetch(`${HOST}/api/v1/workflows/${lifeId}`, { headers: { "X-N8N-API-KEY": KEY } });
    assert.equal(gone.status, 404, "hard delete: workflow gone from the server");
    assert.ok(existsSync(path.join(lifeDir, ".decanter.json")), "local folder left untouched as the git record");
  });

  // Plan 21 authoring verbs against real n8n. Dedicated workflows (not the
  // heavily-mutated Smoke WF) so the assertions stay clean, torn down at the
  // end. `authId`/`authDir`/`cloneId` thread from the add step into duplicate.
  let authId = "";
  let authDir = "";
  let cloneId = "";

  await step("add: a scaffolded Code node executes in the real n8n sandbox", async () => {
    // fresh Webhook -> Respond skeleton (no code node yet); add mints the node
    const created = await api("POST", "/api/v1/workflows", {
      name: "Smoke Authoring",
      nodes: [
        { id: "aw1", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0],
          parameters: { httpMethod: "POST", path: "smoke-auth-hook", responseMode: "responseNode" } },
        { id: "ar1", name: "Respond", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [440, 0],
          parameters: { respondWith: "allIncomingItems" } },
      ],
      connections: { Webhook: { main: [[{ node: "Respond", type: "main", index: 0 }]] } },
      settings: { executionOrder: "v1" },
    });
    authId = created.id;
    authDir = path.join(ROOT, "smoke-authoring");
    let r = await cli("pull", authId);
    assert.equal(r.code, 0, r.out);

    // add scaffolds a disconnected Code node with the default runnable body
    r = await cli("node", "create", authId, "Enrich");
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(path.join(authDir, "code", "enrich.js")), "add wrote the source file");

    // wire it into the chain: Webhook -> Enrich -> Respond (add never wires)
    const wf = JSON.parse(read(authDir, "workflow.json"));
    wf.connections = {
      Webhook: { main: [[{ node: "Enrich", type: "main", index: 0 }]] },
      Enrich: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
    };
    writeFileSync(path.join(authDir, "workflow.json"), JSON.stringify(wf, null, 2));
    r = await cli("check", authId);
    assert.equal(r.code, 0, "wired scaffold must stay compliant: " + r.out);
    r = await cli("push", authId);
    assert.equal(r.code, 0, r.out);
    r = await cli("publish", authId); // make the webhook live
    assert.equal(r.code, 0, r.out);

    // trigger it: the DEFAULT scaffold body (item.json.myNewField = 1) must run
    // in n8n's real Code-node sandbox on the webhook item
    const out = await webhook({ n: 21 }, "smoke-auth-hook");
    assert.equal(out[0]?.myNewField, 1, "default scaffold body executed in the sandbox: " + JSON.stringify(out).slice(0, 300));
    assert.equal(out[0]?.body?.n, 21, "scaffold was correctly wired between Webhook and Respond");
  });

  await step("duplicate: real POST clone — born unpublished from a published source, independent", async () => {
    const source = await api("GET", `/api/v1/workflows/${authId}`);
    assert.equal(source.active, true, "source is published from the add step's publish");

    let r = await cli("duplicate", authId, "Smoke Authoring Copy");
    assert.equal(r.code, 0, r.out);
    cloneId = r.out.match(/duplicated "Smoke Authoring" -> "Smoke Authoring Copy" \(([^)]+)\)/)?.[1] ?? "";
    assert.ok(cloneId, "duplicate printed the new id: " + r.out);
    assert.notEqual(cloneId, authId, "distinct new id");

    const clone = await api("GET", `/api/v1/workflows/${cloneId}`);
    assert.equal(clone.active, false, "clone born unpublished even though the source is published");
    assert.equal(clone.nodes.length, source.nodes.length, "clone carries the source's nodes");
    assert.deepEqual(clone.connections, source.connections, "clone preserves the connections");
    const cloneDir = path.join(ROOT, "smoke-authoring-copy");
    assert.ok(existsSync(path.join(cloneDir, ".decanter.json")), "clone pulled into a folder");
    // the .js Code node round-trips byte-clean into the clone
    assert.equal(read(cloneDir, "code", "enrich.js"), read(authDir, "code", "enrich.js"), "clone's enrich.js is byte-identical");

    // independence: edit + push the clone; the source's remote code is untouched
    const before = (await api("GET", `/api/v1/workflows/${authId}`)).nodes.find((n: any) => n.name === "Enrich").parameters.jsCode;
    writeFileSync(path.join(cloneDir, "code", "enrich.js"), "return [{ json: { cloneOnly: true } }];\n");
    r = await cli("push", cloneId);
    assert.equal(r.code, 0, r.out);
    const after = (await api("GET", `/api/v1/workflows/${authId}`)).nodes.find((n: any) => n.name === "Enrich").parameters.jsCode;
    assert.equal(after, before, "editing the clone must not change the source workflow");

    // tidy up both authoring workflows (the container is ephemeral, but keep it clean)
    await api("DELETE", `/api/v1/workflows/${cloneId}`);
    await api("DELETE", `/api/v1/workflows/${authId}`);
  });

  await step("executions stale-fixture warning: fires on a version mismatch, silent on a match", async () => {
    // Plan 20 task 5, against real execution data: read one real execution's
    // recorded (published) version, then drive the local draft versionId to a
    // mismatch and to a match.
    const page = await api("GET", `/api/v1/executions?includeData=true&limit=1&workflowId=${wfId}`);
    const ran: string = page.data[0]?.workflowVersionId;
    assert.equal(typeof ran, "string", "an execution with a recorded version exists");
    let r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    const wfJson = path.join(wfDir, "workflow.json");
    const setDraft = (v: string): void => {
      const wf = JSON.parse(read(wfJson));
      wf.versionId = v;
      writeFileSync(wfJson, JSON.stringify(wf, null, 2));
    };
    setDraft("stale-draft-marker");
    r = await cli("executions", wfId, "--limit", "1");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`captured executions ran published version ${ran}; your draft is stale-draft-marker`), r.out);
    setDraft(ran); // draft now matches the execution's version → silent
    r = await cli("executions", wfId, "--limit", "1");
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes("may not match the code"), "matching version is silent: " + r.out);
  });

  // ---------- richer execution roundtrips: the CLI executions verb end-to-end ----------
  // The steps above run wfId over the webhook and read the raw executions API;
  // these drive the `executions` verb itself — capture real run JSON to disk,
  // fetch by id, filter success vs. a genuine error run, and prove captured
  // data doubles as a `run` fixture (PLAN's "convenience data / fixtures").

  const execFiles = (dir: string): string[] => {
    const outDir = path.join(dir, "executions");
    return existsSync(outDir) ? readdirSync(outDir).filter((f) => /^\d+\.json$/.test(f)) : [];
  };
  // The Code node's current source path, read from its live placeholder — the
  // rename step moved it to code/ümläut-nödé.ts, so nothing here may hardcode it.
  const computeSrc = (): string => {
    const node = JSON.parse(read(wfDir, "workflow.json")).nodes.find((n: any) => n.id === "c1");
    const rel = String(node?.parameters?.jsCode ?? "").match(/^\/\/@file:(.+)$/)?.[1];
    assert.ok(rel, `no //@file: placeholder on the Code node: ${node?.parameters?.jsCode}`);
    return path.join(wfDir, rel);
  };
  // Tolerant POST: returns the status without demanding a usable response —
  // used to drive a *failing* run, where the Respond node is never reached.
  const fireHook = async (payload: unknown): Promise<number> => {
    const res = await fetch(`${HOST}/webhook/smoke-hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    await res.text();
    return res.status;
  };

  await step("executions pull: the CLI writes real run JSON into a self-ignoring dir", async () => {
    const r = await cli("executions", wfId, "--limit", "5");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /execution/, r.out);
    const files = execFiles(wfDir);
    assert.ok(files.length > 0, "at least one <id>.json landed: " + r.out);
    // the dir must self-ignore: execution JSON can carry credentials/PII and
    // sits inside the commit-on-pull/push pathspec
    assert.equal(read(wfDir, "executions", ".gitignore"), "*\n", "executions/.gitignore is '*'");
    assert.match(r.out, /gitignored/, "the CLI flags the data as gitignored temp: " + r.out);
    const one = JSON.parse(read(wfDir, "executions", files[0]));
    assert.equal(one.status, "success");
    // executions are historical snapshots — an old page entry may predate the
    // rename, so anchor on the never-renamed Webhook node, not the Code node
    const runData = one.data?.resultData?.runData;
    assert.ok(runData?.Webhook, `captured JSON keyed by node name: ${runData && Object.keys(runData).join(",")}`);
  });

  await step("executions by id: a numeric ref self-routes to its workflow folder", async () => {
    const page = await api("GET", `/api/v1/executions?limit=1&workflowId=${wfId}`);
    const id = String(page.data[0].id);
    let r = await cli("executions", wfId, "clean"); // pin the single fetched file
    assert.equal(r.code, 0, r.out);
    r = await cli("executions", id); // no workflow ref — the id decides the folder
    assert.equal(r.code, 0, r.out);
    const file = path.join(wfDir, "executions", `${id}.json`);
    assert.ok(existsSync(file), `execution ${id} landed by id: ` + r.out);
    assert.equal(String(JSON.parse(read(file)).id), id, "fetched the right execution");
  });

  await step("error executions: a throwing run is captured; --status filters success from error", async () => {
    // fresh baseline — the stale-fixture step left workflow.json's versionId edited
    let r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    // a Code node that fails on demand: `{ fail: true }` throws before Respond
    writeFileSync(computeSrc(), [
      'import { double } from "../../../shared/math";',
      "const body = ($json.body ?? {}) as { n?: number; fail?: boolean };",
      'if (body.fail) throw new Error("intentional smoke failure");',
      "return { json: { doubled: double(Number(body.n ?? 0)), mode: 'forced' } };",
      "",
    ].join("\n"));
    r = await cli("push", wfId); // active workflow → goes live
    assert.equal(r.code, 0, r.out);
    // one success (the polling helper also confirms webhook re-registration)…
    const ok = await webhook({ n: 9 });
    assert.deepEqual(ok, [{ doubled: 18, mode: "forced" }], JSON.stringify(ok));
    // …and one failure that records an error execution
    await fireHook({ fail: true });
    // error execution can lag the 500 — poll the API for it (9s budget)
    let errId = "";
    for (let i = 0; i < 12 && !errId; i++) {
      const page = await api("GET", `/api/v1/executions?status=error&limit=1&workflowId=${wfId}`);
      errId = page.data?.[0]?.id ? String(page.data[0].id) : "";
      if (!errId) await sleep(750);
    }
    assert.ok(errId, "an error execution was recorded for the throwing run");
    // --status=error captures only failures, thrown message intact
    r = await cli("executions", wfId, "clean");
    assert.equal(r.code, 0, r.out);
    r = await cli("executions", wfId, "--status", "error", "--limit", "5");
    assert.equal(r.code, 0, r.out);
    let files = execFiles(wfDir);
    assert.ok(files.length > 0, "an error execution file landed: " + r.out);
    for (const f of files) assert.equal(JSON.parse(read(wfDir, "executions", f)).status, "error", `--status=error only captures failures (${f})`);
    const message = JSON.parse(read(wfDir, "executions", `${errId}.json`)).data?.resultData?.error?.message ?? "";
    assert.match(message, /intentional smoke failure/, `thrown message survives into captured JSON: ${message}`);
    // --status=success is the complement: never the failure we just captured
    r = await cli("executions", wfId, "clean");
    assert.equal(r.code, 0, r.out);
    r = await cli("executions", wfId, "--status", "success", "--limit", "5");
    assert.equal(r.code, 0, r.out);
    files = execFiles(wfDir);
    assert.ok(files.length > 0 && !files.includes(`${errId}.json`), "success filter excludes the error run: " + files.join(","));
    for (const f of files) assert.equal(JSON.parse(read(wfDir, "executions", f)).status, "success", `--status=success only captures successes (${f})`);
  });

  await step("captured executions are valid run fixtures — the edit loop closes offline", async () => {
    // PLAN's promise: fetched execution data doubles as a `run` fixture. Feed a
    // real recorded run's *input* back through `run` and assert the offline
    // result matches the *recorded live output*.
    const page = await api("GET", `/api/v1/executions?includeData=true&status=success&limit=1&workflowId=${wfId}`);
    const runData = page.data[0].data.resultData.runData;
    const input = runData["Webhook"][0].data.main[0];           // what the Code node received
    const recordedOut = runData["Ümläut Nödé"][0].data.main[0]; // what it produced live
    const n = Number(input[0].json.body.n ?? 0);
    const fixture = path.join(TMP, "captured.fixture.json");
    writeFileSync(fixture, JSON.stringify({ input }, null, 2));
    const r = await cli("node", "run", computeSrc(), fixture);
    assert.equal(r.code, 0, r.out);
    assert.equal(recordedOut[0].json.doubled, n * 2, "sanity: recorded live output is 2×input");
    assert.match(r.out, new RegExp(`"doubled":\\s*${n * 2}\\b`), `offline run reproduces the live output: ${r.out}`);
  });

  await step("executions clean: fetched data is removed (offline)", async () => {
    assert.ok(existsSync(path.join(wfDir, "executions")), "executions dir present before clean");
    const r = await cli("executions", wfId, "clean");
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(path.join(wfDir, "executions")), "clean removed the executions dir: " + r.out);
  });

  await step("data-tables: read verb round-trips schema + rows; filter/sort narrow server-side; no-scope key 403s (Plan 25)", async () => {
    // Endpoints, field shapes, and the exact read scope names are the version-
    // fragile part this step pins against the real instance (memory:
    // plan25-datatables-api-facts). Seed a table + rows via the public API
    // (write scopes on the smoke key), then read it back only through the CLI.
    //
    // Feature-detect first: the data-tables public API is newer than the oldest
    // n8n the matrix boots. On a version without it the endpoint 404s — soft-skip
    // so the floor version stays green (verified present on 2.31.4).
    const probe = await fetch(`${HOST}/api/v1/data-tables`, { headers: { "X-N8N-API-KEY": KEY, accept: "application/json" } });
    if (probe.status === 404) {
      console.log(`  data-tables API not present on ${IMAGE} (404) — skipping (needs a newer n8n)`);
      return;
    }
    assert.ok(probe.ok, `data-tables API probe failed on ${IMAGE}: ${probe.status} ${(await probe.text()).slice(0, 200)}`);
    const table = await api("POST", "/api/v1/data-tables", {
      name: "Smoke DT",
      columns: [{ name: "status", type: "string" }, { name: "total", type: "number" }],
    });
    const tableId = table.id;
    assert.ok(tableId, "created data table has an id");
    // id is an alphanumeric token like a workflow id, not a number
    assert.match(String(tableId), /^[A-Za-z0-9]{8,}$/, "data-table id is an opaque token: " + tableId);
    const inserted = await api("POST", `/api/v1/data-tables/${tableId}/rows`, {
      data: [{ status: "active", total: 10 }, { status: "closed", total: 20 }, { status: "active", total: 30 }],
    });
    assert.ok(inserted.success !== false, "row seed did not fail: " + JSON.stringify(inserted));

    const dtRoot = path.join(TMP, "data-tables");
    rmSync(dtRoot, { recursive: true, force: true });
    let r = await cli("data-tables", "Smoke DT");
    assert.equal(r.code, 0, r.out);
    // one folder for the table; self-ignored so it can't reach git
    const slugDir = readdirSync(dtRoot).map((d) => path.join(dtRoot, d)).find((p) => existsSync(path.join(p, "rows.json")));
    assert.ok(slugDir, "a table folder with rows.json was written: " + r.out);
    assert.equal(read(dtRoot, ".gitignore"), "*\n");
    const cols = JSON.parse(read(slugDir!, "columns.json"));
    assert.deepEqual(cols.map((c: any) => c.name).sort(), ["status", "total"], "columns round-trip");
    let rows = JSON.parse(read(slugDir!, "rows.json"));
    assert.equal(rows.length, 3, "all rows fetched: " + JSON.stringify(rows));
    const meta = JSON.parse(read(slugDir!, "meta.json"));
    assert.equal(meta.rowCount, 3);
    assert.equal(meta.name, "Smoke DT");

    // --filter narrows rows SERVER-SIDE (the API applies it, not the CLI)
    rmSync(dtRoot, { recursive: true, force: true });
    r = await cli("data-tables", "Smoke DT", "--filter", '{"type":"and","filters":[{"columnName":"status","condition":"eq","value":"active"}]}');
    assert.equal(r.code, 0, r.out);
    rows = JSON.parse(read(readdirSync(dtRoot).map((d) => path.join(dtRoot, d)).find((p) => existsSync(path.join(p, "rows.json")))!, "rows.json"));
    assert.equal(rows.length, 2, "filter kept only the 2 active rows: " + JSON.stringify(rows));
    assert.ok(rows.every((x: any) => x.status === "active"), "filtered rows are all active");

    // --sort proves the colon-bearing sortBy value is URL-encoded correctly
    rmSync(dtRoot, { recursive: true, force: true });
    r = await cli("data-tables", "Smoke DT", "--sort", "total:desc");
    assert.equal(r.code, 0, r.out);
    rows = JSON.parse(read(readdirSync(dtRoot).map((d) => path.join(dtRoot, d)).find((p) => existsSync(path.join(p, "rows.json")))!, "rows.json"));
    assert.deepEqual(rows.map((x: any) => x.total), [30, 20, 10], "sort total:desc ordered rows server-side: " + r.out);

    // a key WITHOUT the data-table read scopes is refused by n8n (403)
    const noScopeKeyRes = await fetch(`${HOST}/rest/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ label: "decanter-smoke-noscope", scopes: ["workflow:read", "workflow:list"], expiresAt: null }),
    });
    const noScopeKey = JSON.parse(await noScopeKeyRes.text()).data.rawApiKey;
    const forbidden = await fetch(`${HOST}/api/v1/data-tables`, { headers: { "X-N8N-API-KEY": noScopeKey, accept: "application/json" } });
    assert.equal(forbidden.status, 403, "a key lacking dataTable:* read scopes must 403");

    // clean removes the whole dir (offline)
    r = await cli("data-tables", "clean");
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(dtRoot), "clean removed the data-tables dir: " + r.out);
  });
} finally {
  await teardown();
  if (!hasFailed()) rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passedCount()} smoke steps passed against ${IMAGE}`);
