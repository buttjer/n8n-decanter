// Unit tests for the `test` verb core (lib/testrun.mts, Plan 33): the pin
// split, the pin-BEFORE-push gap abort, the non-TTY read-only guarantee, and
// the client-side diff — all against a stubbed McpClient + a seeded capture,
// no HTTP, no TTY.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { McpClient } from "../../lib/mcp.mts";
import type { DecanterConfig, Log, Workflow } from "../../lib/types.mts";
import { buildTestPins, runTest } from "../../lib/testrun.mts";

const capturingLog = (): { log: Log; lines: string[] } => {
  const lines: string[] = [];
  const push = (t: string) => (m: string) => lines.push(`${t} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
};

const runData = (items: Array<Record<string, unknown>>) => [{ data: { main: [items.map((json) => ({ json }))] } }];

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  id: "wf1", name: "T", connections: {},
  nodes: [
    { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
    { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0], parameters: { jsCode: "return [{json:{x:1}}];\n" } },
  ],
  ...over,
});

describe("buildTestPins", () => {
  const capture = { Hook: runData([{ n: 1 }]), Compute: runData([{ x: 1 }]) };

  it("pins trigger/network nodes only; pure and disabled nodes are not pinned", () => {
    const { pinData, pinned } = buildTestPins(wf(), capture as any, "301", "capture");
    assert.deepEqual(pinned, ["Hook"], "webhook pinned, Code node runs for real");
    assert.deepEqual(pinData.Hook.map((i: any) => i.json), [{ n: 1 }]);
    assert.equal(pinData.Compute, undefined);
  });

  it("aborts on a pin gap — a network node with no captured output", () => {
    const withHttp = wf();
    withHttp.nodes.push({ id: "f", name: "Fetch", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 0], parameters: { url: "http://x" } } as any);
    assert.throws(() => buildTestPins(withHttp, capture as any, "301", "capture"), /cannot pin "Fetch".*run for REAL.*scenario create/s);
  });

  it("skips a disabled network node (it won't execute)", () => {
    const withDisabled = wf();
    withDisabled.nodes.push({ id: "f", name: "Fetch", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 0], disabled: true, parameters: { url: "http://x" } } as any);
    const { pinned } = buildTestPins(withDisabled, capture as any, "301", "capture");
    assert.deepEqual(pinned, ["Hook"], "disabled node is neither pinned nor a gap");
  });
});

describe("runTest (non-TTY)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const config = (root: string): DecanterConfig => ({
    configDir: root, root, workflows: [], commitOnPush: false, commitOnPull: false,
    browserReload: "off", proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, liveMirror: true, backupLimit: 20, host: "http://x", apiKey: "k",
  });

  /** Seed a pulled workflow folder + a capture; return its dir. */
  function seed(root: string, jsCode = "return [{json:{x:1}}];\n"): string {
    const dir = path.join(root, "t");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    mkdirSync(path.join(dir, "executions"), { recursive: true });
    writeFileSync(path.join(dir, "code", "compute.js"), jsCode);
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js", lastPushedHash: null, name: "Compute" } } }));
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({ ...wf(), nodes: wf().nodes.map((n) => n.id === "c" ? { ...n, parameters: { jsCode: "//@file:code/compute.js" } } : n) }));
    writeFileSync(path.join(dir, "executions", "301.json"), JSON.stringify({ id: 301, workflowId: "wf1", data: { resultData: { runData: { Hook: runData([{ n: 1 }]), Compute: runData([{ x: 1 }]) } } } }));
    return dir;
  }

  /** A stub McpClient scripting the test_workflow flow; records every tool call. */
  function stub(remote: Workflow, ranData: Record<string, unknown>, opts: { status?: string } = {}) {
    const calls: string[] = [];
    const mcp = {
      callTool: async (name: string, _args: any) => {
        calls.push(name);
        if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
        if (name === "test_workflow") return { executionId: opts.status === "error" ? null : "exec-1", status: opts.status ?? "success" };
        if (name === "get_execution") return { execution: {}, data: { resultData: { runData: ranData } } };
        throw new Error("unexpected tool " + name);
      },
    } as unknown as McpClient;
    return { mcp, calls };
  }

  it("in sync: pins the trigger, diffs the pure node clean, mutates NOTHING", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-testrun-"));
    const dir = seed(tmp);
    const { mcp, calls } = stub(wf(), { Compute: runData([{ x: 1 }]) });
    const { log } = capturingLog();
    const report = await runTest(mcp, config(tmp), dir, "wf1", { ref: "301", source: "capture" }, log);
    assert.equal(report.ok, true);
    assert.deepEqual(report.pinned, ["Hook"]);
    assert.equal(report.tested, "draft as-is");
    assert.equal(report.diffs.find((d) => d.node === "Compute")?.equal, true);
    // never mutated: no update_workflow / publish / restore among the calls
    assert.ok(!calls.some((c) => /update_workflow|publish|restore/.test(c)), "non-TTY test issued no writes: " + calls.join(","));
  });

  it("local differs from the draft: still read-only, flags it in the report", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-testrun-"));
    const dir = seed(tmp, "return [{json:{x:999}}];\n"); // local edit not on the draft
    const remote = wf(); // draft still has the old code
    const { mcp, calls } = stub(remote, { Compute: runData([{ x: 1 }]) });
    const { log } = capturingLog();
    const report = await runTest(mcp, config(tmp), dir, "wf1", { ref: "301", source: "capture" }, log);
    assert.equal(report.localDiffersFromTested, true);
    assert.equal(report.tested, "draft as-is");
    assert.ok(!calls.some((c) => /update_workflow|publish/.test(c)), "non-TTY never pushes local edits");
  });

  it("divergence is reported and ok=false", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-testrun-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), { Compute: runData([{ x: 42 }]) }); // instance produced something else
    const { log } = capturingLog();
    const report = await runTest(mcp, config(tmp), dir, "wf1", { ref: "301", source: "capture" }, log);
    assert.equal(report.ok, false);
    assert.deepEqual(report.divergent, ["Compute"]);
  });

  it("a pin gap aborts BEFORE test_workflow runs (finding-2 ordering)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-testrun-"));
    const dir = seed(tmp);
    const remote = wf();
    remote.nodes.push({ id: "f", name: "Fetch", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 0], parameters: { url: "http://x" } } as any);
    const { mcp, calls } = stub(remote, {});
    const { log } = capturingLog();
    await assert.rejects(runTest(mcp, config(tmp), dir, "wf1", { ref: "301", source: "capture" }, log), /cannot pin "Fetch"/);
    assert.ok(!calls.includes("test_workflow"), "aborted before any run: " + calls.join(","));
  });

  it("surfaces an instance-side failure (e.g. the 5-min timeout)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-testrun-"));
    const dir = seed(tmp);
    const { mcp } = stub(wf(), {}, { status: "error" });
    const { log } = capturingLog();
    const report = await runTest(mcp, config(tmp), dir, "wf1", { ref: "301", source: "capture" }, log);
    assert.equal(report.ok, false);
    assert.equal(report.status, "error");
  });
});
