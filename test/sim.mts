// Plan 7 task 5 — opt-in engine simulation suite (`npm run test:sim`). Needs a
// real n8n engine (Docker), so it is NEVER part of `npm test` and is separate
// from the smoke suite. Skips cleanly (exit 0) when no Docker daemon is up.
//
// Unlike the black-box smoke suite, this deliberately drives lib/simulate.mts +
// lib/engine.mts in-process — the engine integration is exactly what it checks.
// It boots one n8n container to *capture* a real execution, then lets
// runSimulation() spin its own throwaway engine containers for the replay.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_N8N_VERSION, dockerAvailable } from "../lib/engine.mts";
import { pinFixtures, runSimulation } from "../lib/simulate.mts";
import { createStepRunner } from "./harness.mts";

const execFile = promisify(execFileCb);
const IMAGE_TAG = process.env.SIM_N8N_TAG ?? DEFAULT_N8N_VERSION;
const IMAGE = `n8nio/n8n:${IMAGE_TAG}`;
const CONTAINER = `decanter-sim-server-${process.pid}`;
const OWNER = { email: "sim@decanter.test", firstName: "S", lastName: "M", password: "S1m-Test-Pass!" };
const docker = (...a: string[]) => execFile("docker", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = { info() {}, ok() {}, warn() {}, error() {} };

if (!(await dockerAvailable())) {
  console.log("skip test:sim — no Docker daemon (the engine backend); this suite is opt-in and needs Docker");
  process.exit(0);
}

let HOST = "", KEY = "";
async function api(method: string, p: string, body?: unknown): Promise<any> {
  const res = await fetch(HOST + p, { method, headers: { "X-N8N-API-KEY": KEY, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : undefined;
}
const teardown = async () => { if (process.env.SIM_KEEP !== "1") await docker("rm", "-f", CONTAINER).catch(() => {}); };
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-simtest-"));
const { step, passedCount, hasFailed } = createStepRunner({ onFail: () => { console.error(`work dir kept: ${TMP}`); } });

try {
  console.log(`booting ${IMAGE} …`);
  await docker("run", "-d", "--name", CONTAINER, "-p", "127.0.0.1::5678", "-e", "N8N_SECURE_COOKIE=false", "-e", "N8N_DIAGNOSTICS_ENABLED=false", "-e", "N8N_PERSONALIZATION_ENABLED=false", IMAGE);

  await step("boot: n8n ready + capture a real execution", async () => {
    HOST = `http://${(await docker("port", CONTAINER, "5678")).stdout.trim().split("\n")[0]}`;
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) { ready = await fetch(`${HOST}/rest/settings`).then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("json")).catch(() => false); if (!ready) await sleep(2000); }
    assert.ok(ready, "n8n never became ready");
    const authCookie = (r: Response) => r.headers.getSetCookie().join("; ").match(/n8n-auth=[^;]+/)?.[0];
    const setup = await fetch(`${HOST}/rest/owner/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(OWNER) });
    let cookie = authCookie(setup);
    for (let i = 0; i < 5 && !cookie; i++) { const l = await fetch(`${HOST}/rest/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emailOrLdapLoginId: OWNER.email, password: OWNER.password }) }); cookie = authCookie(l); if (!cookie) await sleep(1500); }
    assert.ok(cookie, "no auth cookie");
    KEY = (await (await fetch(`${HOST}/rest/api-keys`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie! }, body: JSON.stringify({ label: "sim", scopes: ["workflow:create", "workflow:read", "workflow:update", "workflow:activate", "execution:read", "execution:list"], expiresAt: null }) })).json()).data.rawApiKey;

    const wf = { name: "Sim Test WF", nodes: [
      { id: "w1", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { httpMethod: "POST", path: "sim-hook", responseMode: "lastNode" } },
      { id: "c1", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0], parameters: { jsCode: "const n = Number($input.first().json.body.n ?? 0);\nreturn [{ json: { doubled: n * 2 } }];\n" } },
      { id: "s1", name: "Tag", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [440, 0], parameters: { mode: "manual", assignments: { assignments: [{ id: "a", name: "tagged", type: "boolean", value: true }] } } },
      { id: "h1", name: "Fetch", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [660, 0], parameters: { url: "http://localhost:5678/healthz", method: "GET" } },
    ], connections: { Webhook: { main: [[{ node: "Compute", type: "main", index: 0 }]] }, Compute: { main: [[{ node: "Tag", type: "main", index: 0 }]] }, Tag: { main: [[{ node: "Fetch", type: "main", index: 0 }]] } }, settings: { executionOrder: "v1" } };
    const created = await api("POST", "/api/v1/workflows", wf);
    await api("POST", `/api/v1/workflows/${created.id}/activate`);
    for (let i = 0; i < 15; i++) { const r = await fetch(`${HOST}/webhook/sim-hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 21 }) }); if (r.ok) break; await sleep(750); }
    await sleep(1500);
    const exec = (await api("GET", `/api/v1/executions?includeData=true&limit=1&workflowId=${created.id}`)).data[0];

    // materialize a decanter workflow dir with Compute as a //@file placeholder
    mkdirSync(path.join(TMP, "code"), { recursive: true });
    const local = structuredClone(wf) as any;
    local.id = "wf1"; local.versionId = exec.workflowVersionId ?? "v1";
    local.nodes.find((n: any) => n.name === "Compute").parameters.jsCode = "//@file:code/compute.js";
    writeFileSync(path.join(TMP, "workflow.json"), JSON.stringify(local));
    writeFileSync(path.join(TMP, ".decanter.json"), JSON.stringify({ workflowId: "wf1", nodes: { c1: { file: "code/compute.js" } } }));
    writeFileSync(path.join(TMP, "code", "compute.js"), "const n = Number($input.first().json.body.n ?? 0);\nreturn [{ json: { doubled: n * 2 } }];\n");
    mkdirSync(path.join(TMP, "executions"), { recursive: true });
    writeFileSync(path.join(TMP, "executions", `${exec.id}.json`), JSON.stringify(exec));
  });

  await step("simulate: unedited workflow replays engine-true, exits ok", async () => {
    const report = await runSimulation(TMP, "1", { version: IMAGE_TAG }, log as any);
    assert.equal(report.engineOk, true, `engine error: ${report.engineError}`);
    assert.equal(report.ok, true, `unexpected divergence: ${report.divergent.join(", ")}`);
    assert.deepEqual(report.pinned.sort(), ["Fetch", "Webhook"]);
    const compute = report.diffs.find((d) => d.node === "Compute")!;
    assert.deepEqual(compute.actual, [{ doubled: 42 }], "Compute must execute for real and match capture");
  });

  await step("simulate: a broken Code node diverges and fails", async () => {
    writeFileSync(path.join(TMP, "code", "compute.js"), "return [{ json: { doubled: -1 } }];\n"); // wrong output
    const report = await runSimulation(TMP, "1", { version: IMAGE_TAG }, log as any);
    assert.equal(report.ok, false, "a broken Code node must fail the simulation");
    assert.ok(report.divergent.includes("Compute"), `expected Compute divergent, got ${report.divergent.join(",")}`);
    const compute = report.diffs.find((d) => d.node === "Compute")!;
    assert.deepEqual(compute.expected, [{ doubled: 42 }]);
    assert.deepEqual(compute.actual, [{ doubled: -1 }]);
  });

  await step("simulate --network-none: hard-isolation replay still passes", async () => {
    writeFileSync(path.join(TMP, "code", "compute.js"), "const n = Number($input.first().json.body.n ?? 0);\nreturn [{ json: { doubled: n * 2 } }];\n");
    const report = await runSimulation(TMP, "1", { version: IMAGE_TAG, networkNone: true }, log as any);
    assert.equal(report.ok, true, `network-none run diverged/failed: ${report.engineError ?? report.divergent.join(",")}`);
  });

  await step("simulate --pin: writes committed fixtures from the capture", async () => {
    pinFixtures(TMP, "1", log as any);
    assert.ok(existsSync(path.join(TMP, "fixtures", "webhook.json")));
    assert.ok(existsSync(path.join(TMP, "fixtures", "fetch.json")));
    // pinned fixtures replay identically
    const report = await runSimulation(TMP, "1", { version: IMAGE_TAG }, log as any);
    assert.equal(report.ok, true, "pinned replay must still match");
  });

  console.log(`\n${passedCount()} sim steps passed against ${IMAGE}`);
} finally {
  await teardown();
}
if (hasFailed()) process.exitCode = 1;
