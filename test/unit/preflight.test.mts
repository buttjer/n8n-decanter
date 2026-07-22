// Unit tests for the `preflight` verb (lib/preflight.mts, Plan 36): the pure
// scorer/verdict/coverage/require functions, the line renderer, and the
// orchestrator itself driven against a stubbed McpClient + a seeded capture —
// asserting the ladder runs, scores, and NEVER mutates.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { McpClient } from "../../lib/mcp.mts";
import {
  applyRequire, type CheckFinding, coverageOf, exitCodeOf, formatCheckLine,
  type PreflightContext, profileSpec, renderPreflightSummary, runPreflight, scoreFindings, verdictOf,
} from "../../lib/preflight.mts";
import type { DecanterConfig, Log, Workflow } from "../../lib/types.mts";
import { sha256 } from "../../lib/util.mts";

const finding = (over: Partial<CheckFinding>): CheckFinding => ({ id: "layout", tier: "static", status: "pass", message: "", durationMs: 0, ...over });

describe("preflight scoring (pure)", () => {
  it("starts at 100 and floors at 0", () => {
    assert.equal(scoreFindings([]), 100);
    assert.equal(scoreFindings([finding({ status: "pass" }), finding({ status: "info" }), finding({ status: "skip" })]), 100);
    assert.equal(scoreFindings(Array.from({ length: 5 }, () => finding({ id: "types", status: "fail" }))), 0, "5×−40 floors at 0");
  });
  it("weights fails −40, a CONFLICT drift −30, warns −10", () => {
    assert.equal(scoreFindings([finding({ id: "types", status: "fail" })]), 60);
    assert.equal(scoreFindings([finding({ id: "drift", status: "fail" })]), 70, "drift fail is −30, not −40");
    assert.equal(scoreFindings([finding({ status: "warn" }), finding({ status: "warn" })]), 80);
  });
});

describe("preflight verdict + exit code (pure)", () => {
  it("any fail → not ready; else any warn → caution; else ready", () => {
    assert.equal(verdictOf([finding({ status: "pass" })]), "ready");
    assert.equal(verdictOf([finding({ status: "warn" }), finding({ status: "pass" })]), "caution");
    assert.equal(verdictOf([finding({ status: "warn" }), finding({ status: "fail" })]), "not ready");
  });
  it("exit code: not-ready→1, caution→1 only with --fail-on=warn, ready→0", () => {
    assert.equal(exitCodeOf("not ready"), 1);
    assert.equal(exitCodeOf("caution"), 0);
    assert.equal(exitCodeOf("caution", { failOnWarn: true }), 1);
    assert.equal(exitCodeOf("ready", { failOnWarn: true }), 0);
  });
});

describe("preflight coverage + require (pure)", () => {
  it("coverage splits ran vs skipped with reasons", () => {
    const cov = coverageOf([finding({ id: "layout", status: "pass" }), finding({ id: "test", status: "skip", reason: "no capture", unlock: "run executions" })]);
    assert.deepEqual(cov.ran, ["layout"]);
    assert.deepEqual(cov.skipped, [{ id: "test", reason: "no capture", unlock: "run executions" }]);
  });
  it("--require promotes a skip of a named check to a fail; a ran check is untouched", () => {
    const promoted = applyRequire([finding({ id: "test", status: "skip", reason: "no capture", unlock: "run executions" }), finding({ id: "layout", status: "pass" })], ["test", "layout"]);
    assert.equal(promoted[0].status, "fail");
    assert.match(promoted[0].message, /required check "test" did not run/);
    assert.equal(promoted[1].status, "pass", "a required check that ran is left alone");
  });
});

describe("preflight profiles (pure)", () => {
  it("maps each profile to its active tiers", () => {
    assert.deepEqual(profileSpec("quick"), { sync: true, test: false, simulate: false });
    assert.deepEqual(profileSpec("default"), { sync: true, test: true, simulate: false });
    assert.deepEqual(profileSpec("full"), { sync: true, test: true, simulate: true });
    assert.deepEqual(profileSpec("offline"), { sync: false, test: false, simulate: true });
  });
});

describe("formatCheckLine", () => {
  it("shows a glyph, the id, and the message", () => {
    const line = formatCheckLine(finding({ id: "parity", status: "warn", message: "local differs" }));
    assert.match(line, /!/);
    assert.match(line, /parity/);
    assert.match(line, /local differs/);
  });
});

// ---------- orchestrator against stubs ----------

const runData = (items: Array<Record<string, unknown>>) => [{ data: { main: [items.map((json) => ({ json }))] } }];

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  id: "wf1", name: "Order Sync", connections: {}, active: false, versionId: "v1", activeVersionId: null,
  nodes: [
    { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
    { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0], parameters: { jsCode: "return [{json:{x:1}}];\n" } },
  ],
  ...over,
});

describe("runPreflight (stubbed)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const config = (root: string): DecanterConfig => ({
    configDir: root, root, workflows: [], commitOnPush: false, commitOnPull: false,
    browserReload: "off", proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, host: "http://x", apiKey: "k",
  });

  /** Seed a pulled workflow folder in sync with a draft + a fresh capture. */
  function seed(root: string, jsCode = "return [{json:{x:1}}];\n"): string {
    const dir = path.join(root, "order-sync");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    mkdirSync(path.join(dir, "executions"), { recursive: true });
    writeFileSync(path.join(dir, "code", "compute.js"), jsCode);
    // lastPushedHash = the draft body, so a differing local file reads as
    // "push-pending" (local ahead of the draft), not a manufactured conflict.
    const draftHash = sha256("return [{json:{x:1}}];\n");
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "wf1", name: "Order Sync", nodes: { c: { file: "code/compute.js", lastPushedHash: draftHash, name: "Compute" } } }));
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({ ...wf(), nodes: wf().nodes.map((n) => n.id === "c" ? { ...n, parameters: { jsCode: "//@file:code/compute.js" } } : n) }));
    writeFileSync(path.join(dir, "executions", "301.json"), JSON.stringify({ id: 301, workflowId: "wf1", data: { resultData: { runData: { Hook: runData([{ n: 1 }]), Compute: runData([{ x: 1 }]) } } } }));
    return dir;
  }

  function stub(remote: Workflow, ranData: Record<string, unknown>, opts: { history?: Array<{ id: string; status: string }>; testStatus?: string } = {}) {
    const calls: string[] = [];
    const mcp = {
      callTool: async (name: string, _args: any) => {
        calls.push(name);
        if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
        if (name === "test_workflow") return { executionId: opts.testStatus === "error" ? null : "exec-1", status: opts.testStatus ?? "success" };
        if (name === "get_execution") return { execution: {}, data: { resultData: { runData: ranData } } };
        if (name === "search_executions") return { data: opts.history ?? [{ id: "9", status: "success" }], count: (opts.history ?? []).length, estimated: false };
        throw new Error("unexpected tool " + name);
      },
    } as unknown as McpClient;
    return { mcp, calls };
  }

  const baseCtx = (dir: string, root: string, mcp: McpClient, over: Partial<PreflightContext> = {}): PreflightContext => ({
    config: config(root), dir, id: "wf1", name: "Order Sync", profile: "default",
    noFetch: true, failFast: false, simVersion: "1.100.0", hasApiKey: false,
    mcp: () => mcp, testMcp: () => mcp, api: () => { throw new Error("no api in this test"); },
    dockerAvailable: async () => false, ...over,
  });

  it("default profile: runs the full ladder, passes, and NEVER mutates", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("layout")?.status, "pass");
    assert.equal(byId.get("connect")?.status, "pass");
    assert.equal(byId.get("access")?.status, "pass");
    assert.equal(byId.get("parity")?.status, "pass");
    assert.equal(byId.get("drift")?.status, "pass");
    assert.equal(byId.get("test")?.status, "pass", "instance test matched the capture");
    assert.equal(byId.get("simulate")?.status, "skip", "simulate not in default profile");
    assert.equal(report.verdict, "ready");
    assert.equal(report.subject.parity, "match");
    assert.ok(!calls.some((c) => /update_workflow|publish|restore/.test(c)), "preflight issued no writes: " + calls.join(","));
  });

  it("parity warns and test still runs when local differs from the draft (never pushes)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp, "return [{json:{x:999}}];\n"); // local ahead of the draft
    const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("parity")?.status, "warn");
    assert.equal(report.subject.parity, "local-ahead");
    assert.equal(byId.get("test")?.status, "pass", "tests the draft as-is");
    assert.ok(!calls.some((c) => /update_workflow|publish/.test(c)), "never pushed local: " + calls.join(","));
    assert.equal(report.verdict, "caution");
  });

  it("test divergence fails the gate", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 42 }]) }); // instance produced something else
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    assert.equal(report.checks.find((c) => c.id === "test")?.status, "fail");
    assert.equal(report.verdict, "not ready");
  });

  it("history warns when recent production runs failed", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) }, { history: [{ id: "1", status: "success" }, { id: "2", status: "error" }] });
    const report = await runPreflight(baseCtx(dir, tmp, mcp));
    const hist = report.checks.find((c) => c.id === "history");
    assert.equal(hist?.status, "warn");
    assert.match(hist!.message, /1 of 2 recent runs failed/);
  });

  it("offline profile skips the whole sync tier and test; runs simulate (skipped without Docker)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp, calls } = stub(wf(), {});
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { profile: "offline" }));
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("layout")?.status, "pass", "static tier still runs offline");
    for (const id of ["connect", "access", "parity", "drift", "history"] as const) assert.equal(byId.get(id)?.status, "skip", `${id} skipped offline`);
    assert.equal(byId.get("test")?.status, "skip", "test skipped offline");
    assert.equal(byId.get("simulate")?.status, "skip", "simulate skipped without Docker");
    assert.equal(calls.length, 0, "offline made no MCP calls");
  });

  it("--require promotes a skipped required check to a fail", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { profile: "quick", requireIds: ["test"] }));
    const test = report.checks.find((c) => c.id === "test");
    assert.equal(test?.status, "fail", "test was skipped by --quick then promoted by --require");
    assert.equal(report.verdict, "not ready");
  });

  it("streams each finding via onCheck as it completes", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-preflight-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const streamed: string[] = [];
    const report = await runPreflight(baseCtx(dir, tmp, mcp, { onCheck: (f) => streamed.push(f.id) }));
    assert.deepEqual(streamed, report.checks.map((c) => c.id), "every check streamed once, in order");
    // a summary render must not throw
    const lines: string[] = [];
    const log: Log = { info: (m) => lines.push(m), ok() {}, warn() {}, error() {} };
    renderPreflightSummary(report, log);
    assert.ok(lines.some((l) => /verdict:/.test(l)));
  });
});
