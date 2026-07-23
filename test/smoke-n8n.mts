// Dev-only integration smoke against a real n8n in Docker (plans/15).
// Opt-in: `npm run test:smoke` — never part of `npm test`. Needs a running
// Docker daemon; fails fast with a clear message otherwise.
//
// Black-box by design: drives the CLI as a subprocess and talks to n8n with
// plain fetch — no lib/ imports, so nothing here can accidentally share a
// bug with the code under test. One deliberate exception: the watch step
// drives lib/watch.mts in-process (same as the e2e watch step) — watch is
// interactive and long-running, unscriptable as a subprocess without a pty,
// and in-process log capture is what the asserts need.
//
// Plan 32: the workflow code path rides n8n's built-in MCP server — the
// bootstrap enables MCP + mints the rotatable MCP token via the owner cookie
// (undocumented /rest routes, fine for a throwaway container; see AGENTS.md
// "Driving a real n8n in Docker"), and the seed step exercises the
// per-workflow availableInMCP gate before toggling it on.
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
  // The default MCP rate limit is 100 requests / IP / 5 min (mcp.config.ts)
  // — this suite's CLI bursts cross it mid-run, and the client then honors
  // a minutes-long Retry-After (correct, but it turns the suite into a
  // sleep-athon). Raise the cap; the 429 handling itself is unit-tested.
  "-e", "N8N_MCP_SERVER_RATE_LIMIT=10000",
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
let MCP = ""; // rotatable MCP bearer token (the sync backend's credential)
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
    // Plan 32: enable the built-in MCP server + mint the rotatable MCP token.
    // The env flag does NOT flip the DB setting (verified on 2.30.7) — the
    // cookie-authed PATCH does; rotate returns the only readable raw token.
    const mcpEnable = await fetch(`${HOST}/rest/mcp/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ mcpAccessEnabled: true }),
    });
    assert.ok(mcpEnable.ok, `enabling MCP failed ${versionNote}: ${mcpEnable.status} ${await mcpEnable.text()}`);
    const rotate = await fetch(`${HOST}/rest/mcp/api-key/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
    });
    const rotateText = await rotate.text();
    assert.ok(rotate.ok, `MCP token rotate failed ${versionNote}: ${rotate.status} ${rotateText}`);
    MCP = JSON.parse(rotateText).data.apiKey;
    assert.ok(MCP, `no MCP apiKey in rotate response ${versionNote}`);
  });

  /** Per-workflow MCP opt-in — API-born workflows start gated (Plan 32). */
  const enableMcpAccess = async (...ids: string[]): Promise<void> => {
    const res = await fetch(`${HOST}/rest/mcp/workflows/toggle-access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ availableInMCP: true, workflowIds: ids }),
    });
    assert.ok(res.ok, `toggle-access failed: ${res.status} ${await res.text()}`);
  };

  await step("seed: workflow created via the public API (2.x has POST /workflows)", async () => {
    const created = await api("POST", "/api/v1/workflows", seedWorkflow());
    wfId = created.id;
    assert.ok(wfId, "no id on created workflow");
    writeFileSync(path.join(TMP, ".env"), `N8N_HOST=${HOST}\nN8N_API_KEY=${KEY}\nN8N_MCP_TOKEN=${MCP}\n`);
    writeFileSync(path.join(TMP, "decanter.config.json"),
      JSON.stringify({ root: "./workflows", workflows: [wfId], commitOnPush: false, commitOnPull: false }, null, 2));
    env = { ...process.env, N8N_HOST: HOST, N8N_API_KEY: KEY, N8N_MCP_TOKEN: MCP };
  });

  await step("MCP gate: pull refuses an un-opted-in workflow with guidance; toggling admits it", async () => {
    // API-born workflows are NOT availableInMCP — the real per-workflow gate
    const r = await cli("pull");
    assert.equal(r.code, 1, "pull must refuse before the opt-in: " + r.out);
    assert.match(r.out, /not available in MCP/i, r.out);
    assert.match(r.out, /workflow card|workflow settings/i, "enable guidance surfaced: " + r.out);
    await enableMcpAccess(wfId);
  });

  await step("pull: real workflow lands in the decanter layout (over MCP)", async () => {
    const r = await cli("pull");
    assert.equal(r.code, 0, r.out);
    wfDir = path.join(ROOT, "smoke-wf");
    assert.ok(existsSync(path.join(wfDir, "code", "compute.js")), "code/compute.js extracted");
    assert.match(read(wfDir, "workflow.json"), /"\/\/@file:code\/compute\.js"/);
    assert.match(read(wfDir, "code", "compute.js"), /doubled: n \* 2/);
  });

  await step("no false drift: pull→push→status stays in sync against the real MCP round-trip", async () => {
    let r = await cli("push");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /code already in sync — nothing to push/, "fresh pull must be a no-op push: " + r.out);
    r = await cli("status");
    assert.equal(r.code, 0, "status must be in sync after pull: " + r.out);
    assert.match(r.out, /Compute: in sync/);
    assert.ok(!r.out.includes("push pending"), "no false local drift: " + r.out);
    // a real edit round-trips byte-exact (the Plan 32 invariant)
    writeFileSync(path.join(wfDir, "code", "compute.js"),
      read(wfDir, "code", "compute.js").replace("n * 2", "n * 2 + 0"));
    r = await cli("push");
    assert.equal(r.code, 0, r.out);
    r = await cli("status");
    assert.equal(r.code, 0, "in sync after push: " + r.out);
    assert.match(r.out, /Compute: in sync/);
    r = await cli("pull");
    assert.equal(r.code, 0, r.out);
    assert.match(read(wfDir, "code", "compute.js"), /n \* 2 \+ 0/, "byte-exact round-trip");
    // restore the seed body for later steps
    writeFileSync(path.join(wfDir, "code", "compute.js"),
      read(wfDir, "code", "compute.js").replace("n * 2 + 0", "n * 2"));
    r = await cli("push");
    assert.equal(r.code, 0, r.out);
  });

  await step("marker survival: TS push round-trips the @ts-n8n line byte-intact", async () => {
    unlinkSync(path.join(wfDir, "code", "compute.js"));
    writeFileSync(path.join(wfDir, "code", "compute.ts"),
      "interface Payload { n?: number }\nconst body = $input.first().json.body as Payload;\nconst n = Number(body.n ?? 0);\nreturn [{ json: { doubled: n * 2 } }];\n");
    writeFileSync(path.join(wfDir, "workflow.json"),
      read(wfDir, "workflow.json").replace("//@file:code/compute.js", "//@file:code/compute.ts"));
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
    // pushes are draft-only now — the deliberate publish takes it live
    r = await cli("publish", wfId);
    assert.equal(r.code, 0, r.out);
    const out = await webhook({ n: 21 }); // its own bounded poll covers webhook registration lag
    assert.deepEqual(out, [{ doubled: 42, plus: 121 }], `bundled node must compute through shared/ AND the npm package: ${JSON.stringify(out)}`);
  });

  await step("each-item mode: structure set by a second client, code + --publish by decanter", async () => {
    // the node's `mode` is structure now (Plan 32) — n8n's side owns it; the
    // public API PUT plays the second client here, then pull mirrors it
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    await api("PUT", `/api/v1/workflows/${wfId}`, {
      name: remote.name,
      nodes: remote.nodes.map((n: any) => (n.id === "c1" ? { ...n, parameters: { ...n.parameters, mode: "runOnceForEachItem" } } : n)),
      connections: remote.connections,
      settings: remote.settings ?? {},
    });
    let r = await cli("pull");
    assert.equal(r.code, 0, r.out);
    assert.match(read(wfDir, "workflow.json"), /"runOnceForEachItem"/, "snapshot mirrors the structure change");
    writeFileSync(path.join(wfDir, "code", "compute.ts"), [
      'import { double } from "../../../shared/math";',
      "const n = Number(($json.body as { n?: number }).n ?? 0);",
      "return { json: { doubled: double(n), mode: 'each' } };",
      "",
    ].join("\n"));
    // draft-first: the live version must NOT change until --publish
    const liveBefore = (await api("GET", `/api/v1/workflows/${wfId}`)).activeVersionId;
    r = await cli("push");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /draft updated; the live version is unchanged/, "push is draft-only: " + r.out);
    const between = await api("GET", `/api/v1/workflows/${wfId}`);
    assert.equal(between.activeVersionId, liveBefore, "activeVersionId untouched by a push");
    assert.notEqual(between.versionId, between.activeVersionId, "the draft diverged from the live version");
    r = await cli("push", "--publish"); // no code change left — publish still runs
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /code is live now/, r.out);
    const out = await webhook({ n: 5 });
    assert.deepEqual(out, [{ doubled: 10, mode: "each" }], JSON.stringify(out));
  });

  await step("publish semantics: every push stays a draft; unpublished stays unpublished", async () => {
    const second = await api("POST", "/api/v1/workflows", {
      ...seedWorkflow(),
      name: "Smoke Draft",
      nodes: seedWorkflow().nodes.map((n: any) => (n.id === "w1" ? { ...n, parameters: { ...n.parameters, path: "smoke-draft" } } : n)),
    });
    await enableMcpAccess(second.id);
    const cfg = JSON.parse(read(TMP, "decanter.config.json"));
    writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ ...cfg, workflows: [wfId, second.id] }, null, 2));
    let r = await cli("pull", second.id);
    assert.equal(r.code, 0, r.out);
    const draftDir = path.join(ROOT, "smoke-draft");
    writeFileSync(path.join(draftDir, "code", "compute.js"), "return [{ json: { draft: true } }];\n");
    r = await cli("push", second.id);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /unpublished draft/, "inactive workflow must stay a draft: " + r.out);
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
    assert.match(r.out, /remote code changed since last sync/, r.out);
    r = await cli("push", wfId, "--force", "--publish");
    assert.equal(r.code, 0, "--force must override the per-node drift guard: " + r.out);
    r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    r = await cli("status", wfId);
    assert.equal(r.code, 0, "in sync after force push + pull: " + r.out);
    const out = await webhook({ n: 2 });
    assert.deepEqual(out, [{ doubled: 4, mode: "forced" }], JSON.stringify(out));
  });

  await step("remote node rename (unicode, over raw MCP — the new-world path): pull reconciles, id stable, executes after publish", async () => {
    // The rename verbs are retired: structure acts go through n8n's MCP
    // (agent/skills side) and `pull` reconciles the local mirror. Do exactly
    // that against the real instance.
    const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib", "mcp.mts")).href);
    const mcpClient = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP } });
    await mcpClient.callTool("update_workflow", { workflowId: wfId, operations: [{ type: "renameNode", oldName: "Compute", newName: "Ümläut Nödé" }] });
    let r = await cli("pull", wfId);
    assert.equal(r.code, 0, r.out);
    const renamed = JSON.parse(read(TMP, "decanter.config.json")); // config untouched by the reconcile
    assert.ok(renamed.workflows.includes(wfId));
    assert.match(read(wfDir, "workflow.json"), /"Ümläut Nödé"/, "pull refreshed the snapshot");
    const remote = await api("GET", `/api/v1/workflows/${wfId}`);
    const c1 = remote.nodes.find((n: any) => n.id === "c1");
    assert.equal(c1.name, "Ümläut Nödé", "real n8n accepted the MCP rename — and the node id survived");
    assert.ok(remote.connections["Ümläut Nödé"], "n8n rewrote the connections server-side");
    // the rename landed on the draft — publish takes it live for the webhook
    r = await cli("publish", wfId);
    assert.equal(r.code, 0, r.out);
    const out = await webhook({ n: 3 });
    assert.deepEqual(out, [{ doubled: 6, mode: "forced" }], "workflow still executes after rename: " + JSON.stringify(out));
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

  // The Code node's current source path, read from its live placeholder — the
  // rename step moved it to code/ümläut-nödé.ts, so nothing here may hardcode it.
  const computeSrc = (): string => {
    const node = JSON.parse(read(wfDir, "workflow.json")).nodes.find((n: any) => n.id === "c1");
    const rel = String(node?.parameters?.jsCode ?? "").match(/^\/\/@file:(.+)$/)?.[1];
    assert.ok(rel, `no //@file: placeholder on the Code node: ${node?.parameters?.jsCode}`);
    return path.join(wfDir, rel);
  };

  await step("watch (code-only): a save pushes the node to the DRAFT; workflow.json saves warn, never push", async () => {
    const { watchWorkflow } = await import(pathToFileURL(path.join(PROJECT, "lib", "watch.mts")).href);
    const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib", "mcp.mts")).href);
    const mcpClient = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP } });
    const config = {
      configDir: TMP, root: ROOT, workflows: [wfId], commitOnPush: false, commitOnPull: false,
      requestTimeoutMs: 30_000, dataTables: true, host: HOST, apiKey: KEY,
    };
    const logs: string[] = [];
    const capture = (m: string) => logs.push(m);
    const log = { info: capture, ok: capture, warn: capture, error: capture };
    const srcFile = computeSrc();
    const original = read(srcFile);
    const liveBefore = (await api("GET", `/api/v1/workflows/${wfId}`)).activeVersionId;
    const handle = await watchWorkflow(mcpClient, config, wfId, {}, log);
    try {
      // TMP is not a git repo — watch must warn and skip the startup pull
      assert.ok(logs.some((m) => m.includes("no git safety net")), logs.join("\n"));
      // a code save reaches the DRAFT on the real instance…
      writeFileSync(srcFile, original.replace("mode: 'forced'", "mode: 'watched'"));
      let pushed = false;
      for (let i = 0; i < 20 && !pushed; i++) {
        await sleep(500);
        pushed = logs.some((m) => m.includes("pushed node"));
      }
      assert.ok(pushed, "watch pushed the code save:\n" + logs.join("\n"));
      const remote = await api("GET", `/api/v1/workflows/${wfId}`);
      // the node is TS-managed — the draft carries the COMPILED body (esbuild
      // normalizes quotes), so match the value, not the source spelling
      assert.match(remote.nodes.find((n: any) => n.id === "c1").parameters.jsCode, /watched/, "draft carries the save");
      assert.equal(remote.activeVersionId, liveBefore, "…and the LIVE version is untouched (draft-only)");
      // a workflow.json save warns once and pushes nothing — assert the
      // no-push half on the REAL server too (Plan 33): the draft versionId
      // must not move, proving no update_workflow was issued
      const wfJson = path.join(wfDir, "workflow.json");
      const draftBefore = (await api("GET", `/api/v1/workflows/${wfId}`)).versionId;
      const logCount = logs.length;
      writeFileSync(wfJson, read(wfJson));
      await sleep(1500);
      assert.ok(logs.slice(logCount).some((m) => m.includes("read-only structure snapshot")), "snapshot warning:\n" + logs.join("\n"));
      assert.equal((await api("GET", `/api/v1/workflows/${wfId}`)).versionId, draftBefore, "workflow.json save pushed nothing — draft versionId unchanged");
    } finally {
      await handle.close();
    }
    // restore + take live so later webhook steps see the expected code
    writeFileSync(srcFile, original);
    let r = await cli("push", wfId, "--publish");
    assert.equal(r.code, 0, r.out);
    r = await cli("status", wfId);
    assert.equal(r.code, 0, "in sync after watch session: " + r.out);
  });

  await step("error surfaces: bad MCP token -> clean 401 guidance, unknown id -> clean not-found", async () => {
    const badEnv = { ...env, N8N_MCP_TOKEN: "definitely-wrong" };
    try {
      await execFile(process.execPath, [CLI, "status", wfId], { cwd: TMP, env: badEnv, encoding: "utf8" });
      assert.fail("must exit non-zero with a bad MCP token");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      assert.match(out, /MCP token was rejected \(401\)/, "401 guidance surfaced: " + out);
      assert.ok(!out.includes("    at "), "no stack trace without DEBUG: " + out);
    }
    const r = await cli("status", "aaaaaaaaaaaaaaaa");
    assert.equal(r.code, 1);
    assert.match(r.out, /not found|permission/i, r.out);
  });

  await step("mcp serve: guard-proxy against the REAL instance — reads pass, a jsCode write is blocked (Plan 33)", async () => {
    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, [CLI, "mcp", "serve", "--port", "0"], { cwd: TMP, env });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (out += c.toString()));
    try {
      for (let i = 0; i < 40 && !out.includes("listening on"); i++) await sleep(250);
      const url = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/mcp-server\/http)/)?.[1];
      const secret = out.match(/"Authorization": "Bearer ([^"]+)"/)?.[1];
      assert.ok(url && secret, "serve printed the endpoint + session secret:\n" + out);

      const rpc = async (body: unknown, session?: string) => {
        const res = await fetch(url!, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session !== undefined && { "mcp-session-id": session }),
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, text, session: res.headers.get("mcp-session-id") ?? session };
      };
      const parseResult = (text: string) => {
        // plain JSON or SSE data: lines — take the last data: payload
        const line = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
          ? text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5)
          : text;
        return JSON.parse(line.trim());
      };

      // handshake THROUGH the proxy — session tracking mirrors the CLI's own
      // client: adopt the mcp-session-id header from WHICHEVER response
      // carries it (the real 2.30.7 doesn't guarantee it on initialize)
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke-agent", version: "0" } } });
      assert.equal(init.status, 200, init.text);
      let session = init.session ?? undefined;
      const notified = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
      session = notified.session ?? session;

      // a read passes through and returns the real workflow (with jsCode)
      const details = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_workflow_details", arguments: { workflowId: wfId } } }, session);
      assert.equal(details.status, 200, details.text);
      const detailsMsg = parseResult(details.text);
      assert.ok(JSON.stringify(detailsMsg).includes("jsCode"), "read passed through to the real instance");

      // a jsCode write is blocked in-band, and the instance never sees it
      const before = (await api("GET", `/api/v1/workflows/${wfId}`)).nodes.find((n: any) => n.name === "Ümläut Nödé").parameters.jsCode;
      const write = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "update_workflow", arguments: { workflowId: wfId, operations: [{ type: "updateNodeParameters", nodeName: "Ümläut Nödé", parameters: { jsCode: "return [{json:{hacked:true}}]" } }] } } }, session);
      assert.equal(write.status, 200, write.text);
      const writeMsg = parseResult(write.text);
      assert.equal(writeMsg.result?.isError, true, "blocked in-band: " + write.text);
      assert.match(JSON.stringify(writeMsg), /guard-proxy/, "instructive block text");
      const after = (await api("GET", `/api/v1/workflows/${wfId}`)).nodes.find((n: any) => n.name === "Ümläut Nödé").parameters.jsCode;
      assert.equal(after, before, "the write never reached n8n");

      // a structure op (rename there and back) passes through to the real instance
      const rename = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_workflow", arguments: { workflowId: wfId, operations: [{ type: "renameNode", oldName: "Ümläut Nödé", newName: "Proxy Renamed" }] } } }, session);
      assert.equal(parseResult(rename.text).result?.isError ?? false, false, "structure op passed: " + rename.text);
      assert.ok((await api("GET", `/api/v1/workflows/${wfId}`)).nodes.some((n: any) => n.name === "Proxy Renamed"), "rename landed via the proxy");
      await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "update_workflow", arguments: { workflowId: wfId, operations: [{ type: "renameNode", oldName: "Proxy Renamed", newName: "Ümläut Nödé" }] } } }, session);
      assert.ok((await api("GET", `/api/v1/workflows/${wfId}`)).nodes.some((n: any) => n.name === "Ümläut Nödé"), "rename reverted");
      // the local .ts source references the old name — refresh the snapshot/state
      let r = await cli("pull", wfId);
      assert.equal(r.code, 0, r.out);
      // the two renames bumped the DRAFT versionId; re-publish so the suite's
      // "published & in sync" precondition holds for the steps after this one
      r = await cli("publish", wfId);
      assert.equal(r.code, 0, r.out);
    } finally {
      proc.kill("SIGTERM");
    }
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

  await step("lifecycle: workflow born over raw MCP → pull → publish → unpublish → archive round-trip", async () => {
    // The create verb is retired — the agent path: create over n8n's MCP
    // (validate_workflow gate is the skills' discipline), then pull the id.
    const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib", "mcp.mts")).href);
    const mcpRaw = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP } });
    const created0 = (await mcpRaw.callTool("create_workflow_from_code", { code: 'workflow("smoke-lifecycle", "Smoke Lifecycle")' })) as { workflowId: string };
    const lifeId = created0.workflowId;
    assert.ok(lifeId, "create_workflow_from_code returned the new id: " + JSON.stringify(created0));
    let r = await cli("pull", lifeId);
    assert.equal(r.code, 0, r.out);
    const lifeDir = path.join(ROOT, "smoke-lifecycle");
    assert.ok(existsSync(path.join(lifeDir, ".decanter.json")), "pull created the folder");
    let remote = await api("GET", `/api/v1/workflows/${lifeId}`);
    assert.equal(remote.active, false, "born unpublished");
    assert.equal(remote.activeVersionId, null, "unpublished → no active version");

    // give it a trigger so it can go live — structure is n8n's job now, the
    // public API PUT plays the second client; pull mirrors it
    await api("PUT", `/api/v1/workflows/${lifeId}`, {
      name: "Smoke Lifecycle",
      nodes: [{ id: "lh1", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { httpMethod: "POST", path: "smoke-life-hook" } }],
      connections: {},
      settings: {},
    });
    r = await cli("pull", lifeId);
    assert.equal(r.code, 0, r.out);
    r = await cli("push", lifeId);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /code already in sync|unpublished draft/, "push to an unpublished workflow stays draft: " + r.out);

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
    // Plan 33: assert the AFTER-unpublish shape too (only the born-unpublished
    // case was pinned before) — the real server nulls activeVersionId
    assert.equal(remote.activeVersionId, null, "unpublish clears activeVersionId on the real server");

    // archive is n8n's act now (agent/UI): raw MCP archive_workflow; the
    // workflow survives on the server (isArchived), NOT hard-deleted
    await mcpRaw.callTool("archive_workflow", { workflowId: lifeId });
    remote = await api("GET", `/api/v1/workflows/${lifeId}`);
    assert.equal(remote.isArchived, true, "archived on the server");
    assert.equal(remote.active, false, "stays unpublished");
    assert.ok(existsSync(path.join(lifeDir, ".decanter.json")), "local folder left untouched as the git record");
    // archived workflows refuse MCP access (archived-first gate, real server text)
    r = await cli("pull", lifeId);
    assert.equal(r.code, 1);
    assert.match(r.out, /is archived and cannot be accessed/);
    // tidy up: the public API hard delete still works for cleanup (not a CLI surface)
    await api("DELETE", `/api/v1/workflows/${lifeId}`);
    const gone = await fetch(`${HOST}/api/v1/workflows/${lifeId}`, { headers: { "X-N8N-API-KEY": KEY } });
    assert.equal(gone.status, 404, "cleanup delete succeeded");
  });

  // Plan 21 authoring verbs against real n8n. A dedicated workflow (not the
  // heavily-mutated Smoke WF) so the assertions stay clean, torn down at the
  // end of the step. (The duplicate verb died in Plan 33 — no clone step.)
  let authId = "";
  let authDir = "";

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
    await enableMcpAccess(authId); // API-born → gated until opted in
    let r = await cli("pull", authId);
    assert.equal(r.code, 0, r.out);

    // the guarded authoring loop: the agent adds a Code node over raw MCP
    // WITHOUT jsCode (the guard blocks code in addNode); pull lands it as an
    // empty file; the code itself rides the file + push flow
    const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib", "mcp.mts")).href);
    const mcpRaw = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP } });
    await mcpRaw.callTool("update_workflow", { workflowId: authId, operations: [{ type: "addNode", node: { name: "Enrich", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0], parameters: { mode: "runOnceForAllItems" } } }] });
    r = await cli("pull", authId);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(path.join(authDir, "code", "enrich.js")), "jsCode-less node landed as a file");
    const born = await api("GET", `/api/v1/workflows/${authId}`);
    assert.ok(born.nodes.some((n: any) => n.name === "Enrich"), "the scaffold exists in n8n already");

    // wire it into the chain: Webhook -> Enrich -> Respond — wiring is
    // structure, so the second client (API PUT) does it; pull mirrors
    await api("PUT", `/api/v1/workflows/${authId}`, {
      name: born.name,
      nodes: born.nodes,
      connections: {
        Webhook: { main: [[{ node: "Enrich", type: "main", index: 0 }]] },
        Enrich: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
      },
      settings: born.settings ?? {},
    });
    r = await cli("pull", authId);
    assert.equal(r.code, 0, r.out);
    r = await cli("check", authId);
    assert.equal(r.code, 0, "wired scaffold must stay compliant: " + r.out);

    // the code itself rides the file + push flow (seeding the born-empty node)
    writeFileSync(path.join(authDir, "code", "enrich.js"), "for (const item of $input.all()) {\n  item.json.myNewField = 1;\n}\nreturn $input.all();\n");
    r = await cli("push", authId);
    assert.equal(r.code, 0, "push seeds the born-empty node: " + r.out);
    r = await cli("publish", authId); // make the webhook live
    assert.equal(r.code, 0, r.out);

    // trigger it: the seeded body (item.json.myNewField = 1) must run in
    // n8n's real Code-node sandbox on the webhook item
    const out = await webhook({ n: 21 }, "smoke-auth-hook");
    assert.equal(out[0]?.myNewField, 1, "seeded body executed in the sandbox: " + JSON.stringify(out).slice(0, 300));
    assert.equal(out[0]?.body?.n, 21, "scaffold was correctly wired between Webhook and Respond");

    // tidy up the authoring workflow (the container is ephemeral, but keep it clean)
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
    r = await cli("push", wfId, "--publish"); // draft-first: publish takes it live
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
    const input = runData.Webhook[0].data.main[0];              // what the Code node received
    const recordedOut = runData["Ümläut Nödé"][0].data.main[0]; // what it produced live
    const n = Number(input[0].json.body.n ?? 0);
    const fixture = path.join(TMP, "captured.fixture.json");
    writeFileSync(fixture, JSON.stringify({ input }, null, 2));
    const r = await cli("node", "run", computeSrc(), fixture);
    assert.equal(r.code, 0, r.out);
    assert.equal(recordedOut[0].json.doubled, n * 2, "sanity: recorded live output is 2×input");
    assert.match(r.out, new RegExp(`"doubled":\\s*${n * 2}\\b`), `offline run reproduces the live output: ${r.out}`);
  });

  await step("test verb: pinned run on the REAL instance — draft tested, pure node diffed clean (Plan 33)", async () => {
    // captures from the previous steps are still on disk; local == draft ==
    // published, so the non-TTY run tests the draft as-is and the
    // deterministic Code node must reproduce its captured output exactly
    const draftBefore = (await api("GET", `/api/v1/workflows/${wfId}`)).versionId;
    const r = await cli("test", wfId);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pinned from capture/, "pins sourced from the newest capture: " + r.out);
    assert.match(r.out, /Ümläut Nödé: matches capture/, "the real instance rerun matches the capture: " + r.out);
    assert.match(r.out, /instance test matches the capture/);
    assert.match(r.out, /live \(published\) version was never affected/);
    assert.ok(!r.out.includes("tested the draft, NOT your local code"), "local == draft — no divergence note: " + r.out);
    assert.equal((await api("GET", `/api/v1/workflows/${wfId}`)).versionId, draftBefore, "non-TTY test mutated nothing");
  });

  await step("preflight: the scored ladder against the REAL instance; search_executions live-shape holds (Plan 36)", async () => {
    // Task 3 spike: assert the recorded search_executions response shape against
    // the LIVE instance (the `history` health signal depends on it) — metadata
    // only, no run data. Version-fragile fact, pinned here.
    const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib", "mcp.mts")).href);
    const mcpRaw = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP } });
    const res = await mcpRaw.callTool("search_executions", { workflowId: wfId, limit: 5 }) as {
      data: Array<{ id: string; workflowId: string; status: string; mode: string; startedAt: string | null; stoppedAt: string | null }>;
      count: number; estimated: boolean;
    };
    assert.ok(Array.isArray(res.data), "search_executions returns data[]: " + JSON.stringify(res).slice(0, 300));
    assert.equal(typeof res.count, "number", "count is a number");
    assert.equal(typeof res.estimated, "boolean", "estimated is a boolean");
    if (res.data.length > 0) {
      const row = res.data[0];
      assert.equal(typeof row.id, "string", "row.id is a string");
      assert.equal(typeof row.status, "string", "row.status is a string");
      assert.equal(String(row.workflowId), String(wfId), "workflowId filter applied server-side");
      assert.ok("startedAt" in row && "stoppedAt" in row, "rows carry startedAt/stoppedAt timing");
    }

    // the verb itself: default profile (static + sync + test) against the real
    // instance, as JSON. Read-only — the draft version must not move.
    const draftBefore = (await api("GET", `/api/v1/workflows/${wfId}`)).versionId;
    const r = await cli("preflight", wfId, "--json");
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(r.out.slice(r.out.indexOf("{")));
    assert.equal(report.profile, "default");
    assert.ok(["ready", "caution"].includes(report.verdict), "a healthy in-sync workflow is ready/caution: " + report.verdict);
    for (const id of ["connect", "access", "parity", "test"]) {
      assert.ok(report.checks.find((c: any) => c.id === id && c.status === "pass"), `${id} passed: ` + JSON.stringify(report.checks.find((c: any) => c.id === id)));
    }
    assert.equal((await api("GET", `/api/v1/workflows/${wfId}`)).versionId, draftBefore, "preflight mutated nothing");
  });

  await step("scenario --scaffold: prepare_test_pin_data live-shape holds; a scaffolded scenario writes schemas, not data (Plan 37)", async () => {
    // Assert the recorded prepare_test_pin_data response shape against the LIVE
    // instance (the schema-oracle this feature depends on) — the version-fragile
    // fact this step pins. Schemas only, never data.
    const { McpClient } = await import(pathToFileURL(path.join(PROJECT, "lib", "mcp.mts")).href);
    const mcpRaw = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP } });
    const pin = await mcpRaw.callTool("prepare_test_pin_data", { workflowId: wfId }) as {
      nodeSchemasToGenerate: Record<string, unknown>; nodesWithoutSchema: string[]; nodesSkipped: string[];
      coverage: { withSchemaFromExecution: number; withSchemaFromDefinition: number; withoutSchema: number; skipped: number; total: number };
    };
    assert.ok(pin.nodeSchemasToGenerate && typeof pin.nodeSchemasToGenerate === "object", "nodeSchemasToGenerate is a node→schema map: " + JSON.stringify(pin).slice(0, 300));
    assert.ok(Array.isArray(pin.nodesWithoutSchema) && Array.isArray(pin.nodesSkipped), "nodesWithoutSchema/nodesSkipped are arrays");
    for (const k of ["withSchemaFromExecution", "withSchemaFromDefinition", "withoutSchema", "skipped", "total"] as const) {
      assert.equal(typeof pin.coverage[k], "number", `coverage.${k} is a number`);
    }
    // and through the CLI: a bare --scaffold writes schema-annotated fills, no data
    const r = await cli("scenario", "create", wfId, "scaffolded", "--scaffold");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /scaffold coverage/, r.out);
    const scenario = JSON.parse(readFileSync(path.join(wfDir, "scenarios", "scaffolded.json"), "utf8"));
    assert.equal(scenario._decanterScenario.source, "scaffold");
    assert.deepEqual(scenario.data.resultData.runData, {}, "scaffold invents no runData");
    rmSync(path.join(wfDir, "scenarios"), { recursive: true, force: true });
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
