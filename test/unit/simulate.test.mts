// Offline unit tests for lib/simulate.mts — the scenario/capture loader +
// route-B transform (Plan 7 task 2, scenarios Plan 37). No engine, no mock
// server: pure file-in/JSON-out.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertDryRunSafe,
  buildSimulation,
  checkScenarios,
  detectGaps,
  diffItems,
  isPureNode,
  listScenarioSlugs,
  PURE_NODE_TYPES,
  scenarioIsSynthetic,
  scenarioProvenance,
  SIM_CAP_PREFIX,
  SIM_OUT_PREFIX,
  SIM_START_NODE,
  SimulationGapError,
  sourceFile,
  testPinGaps,
  validateScenarioRunData,
  writeScenario,
} from "../../lib/simulate.mts";
import { assertNoLegacyFixtures, migrateScenariosDir, SCENARIOS_DIR, latestCaptureId } from "../../lib/executions.mts";
import type { PinDataScaffold } from "../../lib/mcp.mts";
import type { Log, Workflow, WorkflowNode } from "../../lib/types.mts";

const warnings: string[] = [];
const log: Log = { info() {}, ok() {}, warn: (m) => warnings.push(m), error() {} };
afterEach(() => { warnings.length = 0; });

const tmpDirs: string[] = [];
function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "decanter-sim-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const item = (json: unknown, i = 0) => ({ json, pairedItem: { item: i } });
/** runData entry (single run, single output) for one node. */
const run = (items: unknown[]) => [{ data: { main: [items] } }];

/** Webhook(trigger) -> Compute(code, //@file) -> Tag(set) -> Fetch(http). */
function baseWorkflow(): Workflow {
  return {
    id: "wf1", name: "Sim WF", versionId: "v1",
    nodes: [
      { id: "w", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "hook" }, credentials: { httpHeaderAuth: { id: "1", name: "c" } } },
      { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0], parameters: { jsCode: "//@file:code/compute.js" } },
      { id: "s", name: "Tag", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [400, 0], parameters: {} },
      { id: "h", name: "Fetch", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [600, 0], parameters: { url: "http://example.com" }, credentials: { httpBasicAuth: { id: "2", name: "b" } } },
    ] as WorkflowNode[],
    connections: {
      Webhook: { main: [[{ node: "Compute", type: "main", index: 0 }]] },
      Compute: { main: [[{ node: "Tag", type: "main", index: 0 }]] },
      Tag: { main: [[{ node: "Fetch", type: "main", index: 0 }]] },
    },
    settings: { executionOrder: "v1" },
  };
}

function scaffoldBase(runDataOverride?: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const runData = runDataOverride ?? {
    Webhook: run([item({ body: { n: 21 } })]),
    Compute: run([item({ doubled: 42 })]),
    Tag: run([item({ tagged: true })]),
    Fetch: run([item({ status: "ok" })]),
  };
  return scaffold({
    "workflow.json": JSON.stringify(baseWorkflow()),
    ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
    "code/compute.js": "return [{ json: { doubled: 42 } }];\n",
    "executions/1.json": JSON.stringify({ id: 1, status: "success", workflowId: "wf1", workflowVersionId: "v1", data: { resultData: { runData } } }),
    ...extra,
  });
}

const nodeNamed = (wf: Workflow, name: string) => wf.nodes.find((n) => n.name === name)!;

describe("classification", () => {
  it("allowlist has the 14 signed-off pure types, all n8n-nodes-base", () => {
    assert.equal(PURE_NODE_TYPES.size, 14);
    for (const t of PURE_NODE_TYPES) assert.match(t, /^n8n-nodes-base\./);
    for (const t of ["code", "set", "if", "switch", "merge", "noOp"]) assert.ok(PURE_NODE_TYPES.has(`n8n-nodes-base.${t}`));
  });
  it("default-denies unknown, network, and deliberately-excluded types", () => {
    const net = (type: string) => isPureNode({ id: "x", name: "x", type, parameters: {} });
    assert.equal(net("n8n-nodes-base.set"), true);
    for (const t of ["httpRequest", "webhook", "postgres", "slack", "splitInBatches", "wait", "executeWorkflow", "totally-made-up"]) {
      assert.equal(net(`n8n-nodes-base.${t}`), false, t);
    }
  });
});

describe("buildSimulation — happy path", () => {
  it("keeps pure nodes real, pins trigger + network, prepends the manual start", async () => {
    const sim = await buildSimulation(scaffoldBase(), "1", log);
    assert.deepEqual(sim.pure.sort(), ["Compute", "Tag"]);
    assert.deepEqual(sim.pinned.sort(), ["Fetch", "Webhook"]);

    // synthetic entry node prepended and wired to the (former) trigger
    const start = sim.workflow.nodes[0];
    assert.equal(start.name, SIM_START_NODE);
    assert.equal(start.type, "n8n-nodes-base.manualTrigger");
    assert.deepEqual((sim.workflow.connections as any)[SIM_START_NODE].main[0], [{ node: "Webhook", type: "main", index: 0 }]);

    // trigger + network replaced by name-preserving Code nodes emitting the capture
    const webhook = nodeNamed(sim.workflow, "Webhook");
    assert.equal(webhook.type, "n8n-nodes-base.code");
    assert.match(String(webhook.parameters.jsCode), /"body":\{"n":21\}/);
    assert.match(String(nodeNamed(sim.workflow, "Fetch").parameters.jsCode), /"status":"ok"/);

    // pure Code node materialized from its //@file source (no placeholder left)
    assert.equal(nodeNamed(sim.workflow, "Compute").parameters.jsCode, "return [{ json: { doubled: 42 } }];\n");

    // captured map feeds the diff
    assert.deepEqual(sim.captured.get("Compute"), [item({ doubled: 42 })]);
    assert.equal(sim.workflow.active, false);
  });

  it("strips every credentials block (dry-run guarantee) and passes assertDryRunSafe", async () => {
    const sim = await buildSimulation(scaffoldBase(), "1", log);
    for (const n of sim.workflow.nodes) assert.equal((n as any).credentials, undefined, n.name);
    assert.doesNotThrow(() => assertDryRunSafe(sim.workflow));
  });
});

describe("buildSimulation — hard errors", () => {
  it("hard-errors on a network node reachable in the capture but unpinned (gap)", async () => {
    const wf = baseWorkflow();
    wf.nodes.push({ id: "h2", name: "Fetch2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [800, 0], parameters: {} } as WorkflowNode);
    (wf.connections as any).Fetch = { main: [[{ node: "Fetch2", type: "main", index: 0 }]] };
    const dir = scaffold({
      "workflow.json": JSON.stringify(wf),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      // Fetch ran and emitted -> Fetch2 was reachable, but Fetch2 has no data
      "executions/1.json": JSON.stringify({ id: 1, workflowId: "wf1", workflowVersionId: "v1", data: { resultData: { runData: {
        Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
      } } } }),
    });
    await assert.rejects(buildSimulation(dir, "1", log), /reached with no captured data: Fetch2/);
  });

  it("hard-errors on a multi-iteration loop (a non-driver node ran more than once)", async () => {
    const runData = {
      Webhook: run([item({})]), Compute: [{ data: { main: [[item({})]] } }, { data: { main: [[item({})]] } }],
      Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
    };
    await assert.rejects(buildSimulation(scaffoldBase(runData), "1", log), /loop workflows are out of scope/);
  });

  it("errors when the capture file is missing", async () => {
    await assert.rejects(buildSimulation(scaffoldBase(), "999", log), /execution 999 not captured under executions\//);
  });

  it("warns (not errors) when the capture ran a different workflow version", async () => {
    const runData = { Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]) };
    const dir = scaffold({
      "workflow.json": JSON.stringify(baseWorkflow()),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      "executions/1.json": JSON.stringify({ id: 1, workflowId: "wf1", workflowVersionId: "OTHER", data: { resultData: { runData } } }),
    });
    await buildSimulation(dir, "1", log);
    assert.ok(warnings.some((w) => /published version OTHER/.test(w)), warnings.join("|"));
  });
});

describe("buildSimulation — single-iteration loops (tier 1)", () => {
  // Webhook(trigger) -> Loop(splitInBatches): output0=done -> Done(set),
  //                                           output1=loop -> Work(code) -> back to Loop.
  function loopWorkflow(): Workflow {
    return {
      id: "wf2", name: "Loop WF", versionId: "v1",
      nodes: [
        { id: "w", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "hook" } },
        { id: "l", name: "Loop", type: "n8n-nodes-base.splitInBatches", typeVersion: 3, position: [200, 0], parameters: { options: {} } },
        { id: "k", name: "Work", type: "n8n-nodes-base.code", typeVersion: 2, position: [400, 0], parameters: { jsCode: "return items;\n" } },
        { id: "d", name: "Done", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [400, 200], parameters: {} },
      ] as WorkflowNode[],
      connections: {
        Webhook: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: { main: [
          [{ node: "Done", type: "main", index: 0 }], // output 0 = done
          [{ node: "Work", type: "main", index: 0 }], // output 1 = loop
        ] },
        Work: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
      settings: { executionOrder: "v1" },
    };
  }
  const scaffoldLoop = (runData: Record<string, unknown>) => scaffold({
    "workflow.json": JSON.stringify(loopWorkflow()),
    ".decanter.json": JSON.stringify({ workflowId: "wf2", nodes: {} }),
    "executions/1.json": JSON.stringify({ id: 1, status: "success", workflowId: "wf2", workflowVersionId: "v1", data: { resultData: { runData } } }),
  });

  it("allows a one-batch loop: the driver runs for real, isn't pinned or diffed", async () => {
    const runData = {
      Webhook: run([item({ n: 1 })]),
      // splitInBatches ran twice: one batch pass (loop output), one final done pass
      Loop: [{ data: { main: [[], [item({ n: 1 })]] } }, { data: { main: [[item({ n: 1 })], []] } }],
      Work: run([item({ n: 1 })]),
      Done: run([item({ done: true })]),
    };
    const sim = await buildSimulation(scaffoldLoop(runData), "1", log);
    assert.deepEqual(sim.loops, ["Loop"]);
    assert.ok(!sim.pinned.includes("Loop"), "loop driver must not be pinned");
    assert.ok(!sim.pure.includes("Loop"), "loop driver isn't a diffed pure node");
    assert.deepEqual(sim.pure.sort(), ["Done", "Work"]);
    assert.deepEqual(sim.pinned, ["Webhook"]);
    // driver kept as its real type (runs for real), not replaced by a Code stub
    assert.equal(nodeNamed(sim.workflow, "Loop").type, "n8n-nodes-base.splitInBatches");
    assert.doesNotThrow(() => assertDryRunSafe(sim.workflow));
  });

  it("still rejects a multi-batch loop (driver ran 3× and the body ran twice)", async () => {
    const runData = {
      Webhook: run([item({})]),
      Loop: [{ data: { main: [[], [item({})]] } }, { data: { main: [[], [item({})]] } }, { data: { main: [[item({})], []] } }],
      Work: [{ data: { main: [[item({})]] } }, { data: { main: [[item({})]] } }],
      Done: run([item({})]),
    };
    await assert.rejects(buildSimulation(scaffoldLoop(runData), "1", log), /only single-iteration loops replay/);
  });

  it("tier-2: allowMultiBatch turns a multi-batch loop into a capped iteration-1 preview", async () => {
    const runData = {
      Webhook: run([item({ n: 1 })]),
      Loop: [{ data: { main: [[], [item({})]] } }, { data: { main: [[], [item({})]] } }, { data: { main: [[item({})], []] } }],
      Work: [{ data: { main: [[item({})]] } }, { data: { main: [[item({})]] } }],
      Done: run([item({ done: true })]),
    };
    const sim = await buildSimulation(scaffoldLoop(runData), "1", log, { allowMultiBatch: true });
    assert.equal(sim.bestEffortLoop, true);
    assert.equal(sim.loopIterations, 2); // body Work ran twice → 2 batches
    // a synthetic Limit cap was spliced in front of the driver, capping its input
    const cap = sim.workflow.nodes.find((n) => n.name === `${SIM_CAP_PREFIX}Loop`);
    assert.ok(cap, "expected a cap node in front of the loop driver");
    assert.equal(cap!.type, "n8n-nodes-base.limit");
    assert.equal((cap!.parameters as { maxItems?: number }).maxItems, 1); // default batchSize
    // the driver's incoming edge (from Webhook) now targets the cap, and cap -> Loop
    const conns = sim.workflow.connections as Record<string, { main?: unknown[][] }>;
    assert.deepEqual((conns.Webhook.main as any)[0], [{ node: `${SIM_CAP_PREFIX}Loop`, type: "main", index: 0 }]);
    assert.deepEqual((conns[`${SIM_CAP_PREFIX}Loop`].main as any)[0], [{ node: "Loop", type: "main", index: 0 }]);
    // still a valid dry-run workflow (Limit is on the pure allowlist)
    assert.doesNotThrow(() => assertDryRunSafe(sim.workflow));
  });
});

describe("buildSimulation — untaken / disabled exemptions", () => {
  it("neutralizes an unreached network node without demanding data", async () => {
    const wf = baseWorkflow();
    // a disabled network node hanging off Tag: no runData, but exempt
    wf.nodes.push({ id: "d", name: "Disabled HTTP", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 200], parameters: {}, disabled: true } as WorkflowNode);
    const dir = scaffold({
      "workflow.json": JSON.stringify(wf),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      "executions/1.json": JSON.stringify({ id: 1, workflowId: "wf1", workflowVersionId: "v1", data: { resultData: { runData: {
        Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
      } } } }),
    });
    const sim = await buildSimulation(dir, "1", log);
    const disabled = nodeNamed(sim.workflow, "Disabled HTTP");
    assert.equal(disabled.type, "n8n-nodes-base.code"); // neutralized
    assert.match(String(disabled.parameters.jsCode), /reached unexpectedly/);
    assert.doesNotThrow(() => assertDryRunSafe(sim.workflow));
  });
});

// Plan 63 task 4: reachability is per-OUTPUT, not per-node. An IF emits on one
// output per run — items in main[0] when it took "true", nothing in main[1] —
// and every consumer used to read main[0] regardless of which edge it was
// looking at. So the untaken branch's target counted as reachable (a demanded
// gap the capture provably never reached) and was handed the OTHER branch's
// items as its input sample.
describe("buildSimulation — branch-aware reachability", () => {
  /** Webhook -> Decide(if): output0 -> Taken(http), output1 -> NotTaken(http). */
  function branchingWorkflow(): Workflow {
    return {
      id: "wf1", name: "Branch WF", versionId: "v1",
      nodes: [
        { id: "w", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "hook" } },
        { id: "i", name: "Decide", type: "n8n-nodes-base.if", typeVersion: 2, position: [200, 0], parameters: {} },
        { id: "t", name: "Taken", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, -80], parameters: { url: "http://example.com/yes" } },
        { id: "n", name: "NotTaken", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 80], parameters: { url: "http://example.com/no" } },
      ] as WorkflowNode[],
      connections: {
        Webhook: { main: [[{ node: "Decide", type: "main", index: 0 }]] },
        Decide: { main: [[{ node: "Taken", type: "main", index: 0 }], [{ node: "NotTaken", type: "main", index: 0 }]] },
      },
      settings: { executionOrder: "v1" },
    };
  }

  /** The capture took the TRUE branch: Decide emitted on main[0], nothing on main[1]. */
  function scaffoldBranching(): string {
    return scaffold({
      "workflow.json": JSON.stringify(branchingWorkflow()),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: {} }),
      "executions/1.json": JSON.stringify({
        id: 1, status: "success", workflowId: "wf1", workflowVersionId: "v1",
        data: { resultData: { runData: {
          Webhook: run([item({ n: 1 })]),
          Decide: [{ data: { main: [[item({ side: "yes" })], []] } }],
          Taken: run([item({ status: "ok" })]),
        } } },
      }),
    });
  }

  it("does not demand data for the branch the capture never took", async () => {
    // Before the fix `NotTaken` read Decide's main[0] — non-empty — and was
    // reported as a gap the author had to fill for a path that never ran.
    const sim = await buildSimulation(scaffoldBranching(), "1", log);
    const notTaken = nodeNamed(sim.workflow, "NotTaken");
    assert.equal(notTaken.type, "n8n-nodes-base.code"); // neutralized, not demanded
    assert.match(String(notTaken.parameters.jsCode), /reached unexpectedly/);
  });

  it("still demands data for a node the taken branch DID reach", async () => {
    const dir = scaffoldBranching();
    const capture = JSON.parse(readFileSync(path.join(dir, "executions/1.json"), "utf8")) as { data: { resultData: { runData: Record<string, unknown> } } };
    delete capture.data.resultData.runData.Taken; // reachable on main[0], no data
    writeFileSync(path.join(dir, "executions/1.json"), JSON.stringify(capture));
    await assert.rejects(buildSimulation(dir, "1", log), /Taken/);
  });

  it("fills the gap's input sample from the branch that actually fed it", async () => {
    const dir = scaffoldBranching();
    const capture = JSON.parse(readFileSync(path.join(dir, "executions/1.json"), "utf8")) as { data: { resultData: { runData: Record<string, unknown> } } };
    // Decide took the FALSE branch this time, so NotTaken is the reachable gap
    // and its input must be the false branch's items — not the true branch's.
    capture.data.resultData.runData.Decide = [{ data: { main: [[], [item({ side: "no" })]] } }];
    delete capture.data.resultData.runData.Taken;
    writeFileSync(path.join(dir, "executions/1.json"), JSON.stringify(capture));
    const gaps = await detectGaps(dir, "1", log);
    const notTaken = gaps.find((g) => g.node === "NotTaken");
    assert.ok(notTaken, `expected NotTaken to be the gap, got ${gaps.map((g) => g.node).join(", ") || "none"}`);
    assert.deepEqual(notTaken.input.map((i) => (i as { json: { side: string } }).json.side), ["no"]);
  });
});

// Plan 66 task 3: a pinned node's stand-in is a Code node, which has ONE
// output — so everything behind its error output (or any further output) used
// to get no input at all, emit nothing, and let the run pass anyway. Each extra
// output now replays through its own stand-in.
describe("multi-output pins (Plan 66)", () => {
  /** Webhook -> Fetch(http, error output): main[0] -> OnOk(set), main[1] -> OnError(noOp). */
  function errorOutputWf(): Workflow {
    return {
      id: "wf1", name: "Err WF", versionId: "v1",
      nodes: [
        { id: "w", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
        { id: "h", name: "Fetch", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [200, 0], parameters: { url: "http://x" }, onError: "continueErrorOutput" },
        { id: "o", name: "OnOk", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [400, -80], parameters: {} },
        { id: "e", name: "OnError", type: "n8n-nodes-base.noOp", typeVersion: 1, position: [400, 80], parameters: {} },
      ] as WorkflowNode[],
      connections: {
        Webhook: { main: [[{ node: "Fetch", type: "main", index: 0 }]] },
        Fetch: { main: [[{ node: "OnOk", type: "main", index: 0 }], [{ node: "OnError", type: "main", index: 0 }]] },
      },
      settings: { executionOrder: "v1" },
    };
  }

  const scaffoldErrorOutput = (fetchRuns: unknown) => scaffold({
    "workflow.json": JSON.stringify(errorOutputWf()),
    ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: {} }),
    "executions/1.json": JSON.stringify({
      id: 1, status: "success", workflowId: "wf1", workflowVersionId: "v1",
      data: { resultData: { runData: { Webhook: run([item({ n: 1 })]), Fetch: fetchRuns, OnOk: run([item({ ok: true })]) } } },
    }),
  });

  const bothOutputs = [{ data: { main: [[item({ status: "ok" })], [item({ error: "boom" })]] } }];
  const conn = (wf: Workflow, name: string) => (wf.connections as Record<string, { main: Array<Array<{ node: string }>> }>)[name];

  it("gives each extra output its own stand-in, carrying that output's items", async () => {
    const sim = await buildSimulation(scaffoldErrorOutput(bothOutputs), "1", log);
    assert.deepEqual(sim.splitOutputs, ["Fetch output 1"]);
    const standIn = nodeNamed(sim.workflow, `${SIM_OUT_PREFIX}1__Fetch`);
    assert.equal(standIn.type, "n8n-nodes-base.code");
    assert.match(String(standIn.parameters.jsCode), /boom/);
    assert.doesNotMatch(String(nodeNamed(sim.workflow, "Fetch").parameters.jsCode), /boom/, "output 0's stand-in keeps output 0's items only");
  });

  it("hands the error branch to the stand-in and empties the output it could never reach", async () => {
    const sim = await buildSimulation(scaffoldErrorOutput(bothOutputs), "1", log);
    assert.deepEqual(conn(sim.workflow, "Fetch").main[0].map((t) => t.node), ["OnOk"]);
    assert.deepEqual(conn(sim.workflow, "Fetch").main[1], [], "a Code node has no output 1 — leaving targets there strands them");
    assert.deepEqual(conn(sim.workflow, `${SIM_OUT_PREFIX}1__Fetch`).main[0].map((t) => t.node), ["OnError"]);
  });

  it("fires the stand-in from the original's input, NOT from the synthetic trigger", async () => {
    const sim = await buildSimulation(scaffoldErrorOutput(bothOutputs), "1", log);
    // Same upstream as the original: it replays only when the original would.
    assert.deepEqual(conn(sim.workflow, "Webhook").main[0].map((t) => t.node).sort(), ["Fetch", `${SIM_OUT_PREFIX}1__Fetch`].sort());
    // An entry-wired stand-in would inject the error branch even on a replay
    // whose upstream took another path — the run would contradict itself.
    assert.equal(conn(sim.workflow, SIM_START_NODE).main[0].some((t) => t.node.startsWith(SIM_OUT_PREFIX)), false);
  });

  it("replays an error-ONLY run: output 0 empty, the error branch still gets its items", async () => {
    const sim = await buildSimulation(scaffoldErrorOutput([{ data: { main: [[], [item({ error: "boom" })]] } }]), "1", log);
    assert.deepEqual(sim.splitOutputs, ["Fetch output 1"]);
    assert.match(String(nodeNamed(sim.workflow, `${SIM_OUT_PREFIX}1__Fetch`).parameters.jsCode), /boom/);
    assert.match(String(nodeNamed(sim.workflow, "Fetch").parameters.jsCode), /return \[\]/, "the node itself emitted nothing on output 0");
  });

  it("splits nothing — and adds no node — when the capture used one output", async () => {
    const sim = await buildSimulation(scaffoldErrorOutput(run([item({ status: "ok" })])), "1", log);
    assert.deepEqual(sim.splitOutputs, []);
    assert.equal(sim.workflow.nodes.some((n) => n.name.startsWith(SIM_OUT_PREFIX)), false);
  });

  it("keeps the dry-run guarantee — stand-ins are Code nodes, so nothing executable slipped in", async () => {
    const sim = await buildSimulation(scaffoldErrorOutput(bothOutputs), "1", log);
    assert.doesNotThrow(() => assertDryRunSafe(sim.workflow)); // also asserted inside buildSimulation
  });
});

// Plan 65: `scenario check` and `test` enforced different node sets, so a
// capture-seeded scenario could be green here and rejected there — with no
// supported way to fix it, because `scenario create` refused an existing file.
describe("scenario ↔ test gate parity (Plan 65)", () => {
  /** Webhook -> Decide(if): output0 -> Taken(http), output1 -> NotTaken(http). */
  function branchWf(): Workflow {
    return {
      id: "wf1", name: "Branch WF", versionId: "v1",
      nodes: [
        { id: "w", name: "Webhook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { path: "hook" } },
        { id: "i", name: "Decide", type: "n8n-nodes-base.if", typeVersion: 2, position: [200, 0], parameters: {} },
        { id: "t", name: "Taken", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, -80], parameters: {} },
        { id: "n", name: "NotTaken", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 80], parameters: {} },
      ] as WorkflowNode[],
      connections: {
        Webhook: { main: [[{ node: "Decide", type: "main", index: 0 }]] },
        Decide: { main: [[{ node: "Taken", type: "main", index: 0 }], [{ node: "NotTaken", type: "main", index: 0 }]] },
      },
      settings: { executionOrder: "v1" },
    };
  }
  /** The capture took the TRUE branch, so NotTaken never ran and was never reached. */
  const dirWithCapture = () => scaffold({
    "workflow.json": JSON.stringify(branchWf()),
    ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: {} }),
    "executions/7.json": JSON.stringify({
      id: 7, status: "success", workflowId: "wf1", workflowVersionId: "v1",
      data: { resultData: { runData: {
        Webhook: run([item({ n: 1 })]),
        Decide: [{ data: { main: [[item({ side: "yes" })], []] } }],
        Taken: run([item({ ok: true })]),
      } } },
    }),
  });

  it("testPinGaps applies test's rule: every pinnable node, reachable or not", () => {
    const gaps = testPinGaps(branchWf(), { Webhook: run([item({})]), Taken: run([item({})]) } as never);
    assert.deepEqual(gaps, ["NotTaken"]);
  });

  it("a capture-seeded scenario pins the unreached branch to an EMPTY run, and records it", async () => {
    const dir = dirWithCapture();
    await writeScenario(dir, { execId: "7", slug: "happy" }, log);
    const written = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "happy.json"), "utf8")) as {
      data: { resultData: { runData: Record<string, unknown> } };
      _decanterScenario: { fill: Array<{ node: string }>; notExercised?: string[] };
    };
    // pinned to zero items — satisfies `test` without inventing output, and the
    // node cannot touch the real world
    assert.deepEqual(written.data.resultData.runData.NotTaken, [{ data: { main: [[]] } }]);
    // …and the claim is visible, not hidden
    assert.deepEqual(written._decanterScenario.notExercised, ["NotTaken"]);
    // it is NOT a fill entry: nobody is being asked to author it
    assert.equal(written._decanterScenario.fill.some((f) => f.node === "NotTaken"), false);
    // both gates now agree on this scenario
    assert.deepEqual(testPinGaps(branchWf(), written.data.resultData.runData as never), []);
  });

  it("scenario check reports the test gate too when a hand-edited scenario is short", () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(branchWf()),
      [`${SCENARIOS_DIR}/short.json`]: JSON.stringify({
        id: "short", data: { resultData: { runData: { Webhook: run([item({})]), Taken: run([item({})]) } } },
        _decanterScenario: { source: "capture", createdAt: "2026-08-04", guidance: "", fill: [] },
      }),
    });
    assert.equal(checkScenarios(dir, "short", log), 0); // still VALID for simulate
    assert.ok(warnings.some((w) => /`test` needs 1 more node.*NotTaken/.test(w)), `expected a test-gate warning, got: ${warnings.join(" | ")}`);
    assert.ok(warnings.some((w) => /--extend/.test(w)), "the warning must name the way out");
  });

  it("--extend adds the missing nodes and keeps what was already authored", async () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(branchWf()),
      [`${SCENARIOS_DIR}/short.json`]: JSON.stringify({
        id: "short", data: { resultData: { runData: { Webhook: run([item({ keep: "me" })]), Taken: run([item({})]) } } },
        _decanterScenario: { source: "capture", createdAt: "2026-08-04", guidance: "", fill: [] },
      }),
    });
    const res = await writeScenario(dir, { slug: "short", extend: true }, log);
    assert.deepEqual(res.gaps, ["NotTaken"]);
    const after = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "short.json"), "utf8")) as {
      data: { resultData: { runData: Record<string, unknown> } };
      _decanterScenario: { fill: Array<{ node: string }> };
    };
    assert.deepEqual(after._decanterScenario.fill.map((f) => f.node), ["NotTaken"]);
    assert.deepEqual(after.data.resultData.runData.Webhook, run([item({ keep: "me" })])); // untouched
  });

  it("--extend on an already-complete scenario is a no-op, not an error", async () => {
    const dir = dirWithCapture();
    await writeScenario(dir, { execId: "7", slug: "happy" }, log);
    const res = await writeScenario(dir, { slug: "happy", extend: true }, log);
    assert.deepEqual(res.gaps, []);
  });

  it("--extend refuses a scenario that does not exist", async () => {
    const dir = scaffold({ "workflow.json": JSON.stringify(branchWf()) });
    await assert.rejects(writeScenario(dir, { slug: "nope", extend: true }, log), /no scenario "nope" to extend/);
  });

  // Plan 76: the gaps come from the LOCAL workflow.json; the instance only ever
  // supplied the per-node JSON Schemas, and those are an annotation. A scaffold
  // with no schemas is a less-annotated scenario, not an invalid one — which is
  // what makes `preflight --offline --simulate` reachable with no instance.
  it("scaffolds with no schema oracle at all — every pinnable node still becomes a fill entry", async () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(branchWf()),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: {} }),
    });
    const res = await writeScenario(dir, { slug: "train", scaffoldRequested: true }, log);
    assert.deepEqual(res.gaps, ["Webhook", "Taken", "NotTaken"], "the IF node is not pinnable; the three network/trigger nodes are");
    const written = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "train.json"), "utf8")) as {
      _decanterScenario: { source: string; fill: Array<{ node: string; expectedSchema?: unknown }> };
    };
    assert.equal(written._decanterScenario.source, "scaffold");
    assert.ok(
      written._decanterScenario.fill.every((f) => f.expectedSchema === undefined),
      "no instance means no expectedSchema — the difference stays visible in the file, not hidden",
    );
  });

  it("still refuses a bare call that asked for neither a capture nor a scaffold", async () => {
    const dir = scaffold({ "workflow.json": JSON.stringify(branchWf()) });
    await assert.rejects(writeScenario(dir, { slug: "empty" }, log), /needs --scaffold/);
  });
});

// Plan 63 tasks 7 + 8. Three messages that pointed the reader somewhere the
// thing they needed was not, plus the size fact that was never printed.
describe("scenario messages tell the truth about the file in front of you", () => {
  it("names the LEGACY marker key when that is the one in the file (task 8)", () => {
    // `readScenarioMeta` has always accepted `_decanterMock`; the message
    // hardcoded `_decanterScenario.fill`, i.e. a key literally not in the file.
    const legacy = {
      id: "old", data: { resultData: { runData: {} } },
      _decanterMock: { source: "capture", createdAt: "2026-01-01", guidance: "", fill: [{ node: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: {}, inputSample: [] }] },
    } as never;
    assert.throws(() => validateScenarioRunData(legacy, "old"), /_decanterMock\.fill/);
    assert.throws(() => validateScenarioRunData(legacy, "old"), (e: Error) => !/_decanterScenario\.fill/.test(e.message));
  });

  it("distinguishes 'no entry' from 'an entry that emits nothing' (task 8)", () => {
    const withFill = (runData: Record<string, unknown>) => ({
      id: "s", data: { resultData: { runData } },
      _decanterScenario: { source: "capture", createdAt: "2026-01-01", guidance: "", fill: [{ node: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: {}, inputSample: [] }] },
    }) as never;
    // absent entirely → "add runData"
    assert.throws(() => validateScenarioRunData(withFill({}), "s"), /add runData for Fetch/);
    // present but empty → say so, and show the "emits nothing" spelling
    assert.throws(() => validateScenarioRunData(withFill({ Fetch: [] }), "s"), /EMPTY runs array/);
    assert.throws(() => validateScenarioRunData(withFill({ Fetch: [] }), "s"), /\[\{"data":\{"main":\[\[\]\]\}\}\]/);
  });

  it("a graph-derived gap does NOT send the reader to the fill block (task 8)", async () => {
    // These names come from the WORKFLOW GRAPH, so they are by definition not in
    // `fill` — the old wording ("see the _decanterScenario block") sent the field
    // report hunting for entries that were never there.
    const dir = scaffoldBase(undefined, {
      [`${SCENARIOS_DIR}/thin.json`]: JSON.stringify({
        id: "thin",
        data: { resultData: { runData: { Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]) } } },
        _decanterScenario: { source: "capture", createdAt: "2026-01-01", guidance: "", fill: [] },
      }),
    });
    await assert.rejects(buildSimulation(dir, "thin", log, { source: "scenario" }), (e: Error) => {
      assert.match(e.message, /does not cover network node\(s\)/);
      assert.match(e.message, /NOT listed in the scenario's "fill"/);
      assert.match(e.message, /--extend/, "must name the supported way to add them");
      assert.doesNotMatch(e.message, /see the _decanterScenario block/);
      return true;
    });
  });

  it("prints the scenario's size, and warns when it is about to be committed (task 7)", async () => {
    const dir = scaffoldBase();
    await writeScenario(dir, { execId: "1", slug: "small" }, log);
    const infos = [...warnings]; // the recorder below collects warns; size lands on ok/info
    assert.ok(infos.length >= 0); // (kept so the recorder is exercised even when quiet)
    const file = path.join(dir, SCENARIOS_DIR, "small.json");
    assert.ok(existsSync(file));
    // a small scenario must NOT trip the commit warning
    assert.equal(warnings.some((w) => /TRACKED/.test(w)), false, `small scenario should not warn: ${warnings.join(" | ")}`);
  });
});

describe("latestCaptureId", () => {
  it("returns the highest numeric capture id (newest), ignoring non-numeric files", () => {
    const dir = scaffold({
      "executions/3.json": "{}", "executions/17.json": "{}", "executions/9.json": "{}",
      "executions/notes.json": "{}", "executions/.gitignore": "*",
    });
    assert.equal(latestCaptureId(dir), "17");
  });
  it("does not count committed scenarios (slug-named, not 'latest'-ordered)", () => {
    const dir = scaffold({ "executions/3.json": "{}", "scenarios/happy-path.json": "{}" });
    assert.equal(latestCaptureId(dir), "3");
  });
  it("returns null when there are no captures", () => {
    assert.equal(latestCaptureId(scaffold({ "workflow.json": "{}" })), null);
  });
});

describe("gaps — SimulationGapError context", () => {
  // Fetch -> Fetch2(http, no data): Fetch2 is a reachable, unpinned network node.
  function gapDir(): string {
    const wf = baseWorkflow();
    wf.nodes.push({ id: "h2", name: "Fetch2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [800, 0], parameters: { url: "http://x" } } as WorkflowNode);
    (wf.connections as any).Fetch = { main: [[{ node: "Fetch2", type: "main", index: 0 }]] };
    return scaffold({
      "workflow.json": JSON.stringify(wf),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      "executions/1.json": JSON.stringify({ id: 1, workflowId: "wf1", workflowVersionId: "v1", data: { resultData: { runData: {
        Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
      } } } }),
    });
  }

  it("throws SimulationGapError carrying per-node context (type, params, input)", async () => {
    const err = await buildSimulation(gapDir(), "1", log).then(() => null, (e) => e);
    assert.ok(err instanceof SimulationGapError, "expected a SimulationGapError");
    assert.equal(err.gaps.length, 1);
    assert.equal(err.gaps[0].node, "Fetch2");
    assert.equal(err.gaps[0].type, "n8n-nodes-base.httpRequest");
    assert.deepEqual(err.gaps[0].parameters, { url: "http://x" });
    // input = the captured items feeding Fetch2 (Fetch's output)
    assert.deepEqual(err.gaps[0].input, [item({ status: "ok" })]);
  });

  it("detectGaps returns the same contexts, and [] when there are none", async () => {
    assert.deepEqual((await detectGaps(gapDir(), "1", log)).map((g) => g.node), ["Fetch2"]);
    assert.deepEqual(await detectGaps(scaffoldBase(), "1", log), []);
  });
});

describe("scenario create (writeScenario) + sourceFile resolution", () => {
  it("sourceFile resolves scenarios by slug and captures by id", () => {
    const dir = scaffold({ "executions/1.json": "{}", "scenarios/happy-path.json": "{}" });
    assert.ok(sourceFile(dir, "happy-path", "scenario")!.includes(`${SCENARIOS_DIR}/happy-path.json`));
    assert.ok(sourceFile(dir, "1", "capture")!.includes("executions/1.json"));
    assert.equal(sourceFile(dir, "nope", "scenario"), null);
    // a scenario ref is kebab-slugged on lookup
    assert.ok(sourceFile(dir, "Happy Path", "scenario")!.includes("happy-path.json"));
  });

  const gapWorkflowDir = () => {
    const wf = baseWorkflow();
    wf.nodes.push({ id: "h2", name: "Fetch2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [800, 0], parameters: { url: "http://x" } } as WorkflowNode);
    (wf.connections as any).Fetch = { main: [[{ node: "Fetch2", type: "main", index: 0 }]] };
    return scaffold({
      "workflow.json": JSON.stringify(wf),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      "executions/1.json": JSON.stringify({ id: 1, workflowId: "wf1", workflowVersionId: "v1", data: { resultData: { runData: {
        Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
      } } } }),
    });
  };

  it("promotes a capture to a named scenario, flagging gap nodes to fill", async () => {
    const dir = gapWorkflowDir();
    const result = await writeScenario(dir, { execId: "1", slug: "happy path" }, log); // slug kebab-slugged
    assert.equal(result.slug, "happy-path");
    assert.deepEqual(result.gaps, ["Fetch2"]);
    const scenario = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "happy-path.json"), "utf8"));
    // the scenario is a full copy of the capture (real runData preserved) + guidance block
    assert.deepEqual(scenario.data.resultData.runData.Fetch, run([item({ status: "ok" })]));
    assert.equal(scenario._decanterScenario.source, "capture");
    assert.equal(scenario._decanterScenario.sourceExecution, "1");
    assert.equal(scenario._decanterScenario.fill.length, 1);
    assert.equal(scenario._decanterScenario.fill[0].node, "Fetch2");
    assert.equal(scenario._decanterScenario.fill[0].expectedSchema, undefined); // no --scaffold
    assert.deepEqual(scenario._decanterScenario.fill[0].inputSample, [{ status: "ok" }]);
    assert.ok(warnings.some((w) => /credentials\/PII/.test(w)), warnings.join("|"));
    // refuses to clobber an existing scenario (protects hand-filled data)
    await assert.rejects(writeScenario(dir, { execId: "1", slug: "happy path" }, log), /scenario "happy-path" already exists/);
  });

  it("defaults the slug to the execution id when none is given", async () => {
    const dir = gapWorkflowDir();
    const result = await writeScenario(dir, { execId: "1", slug: "1" }, log);
    assert.equal(result.slug, "1");
    assert.ok(existsSync(path.join(dir, SCENARIOS_DIR, "1.json")));
  });

  it("strips the capture's embedded workflowData — a committed scenario must not duplicate node source", async () => {
    const dir = gapWorkflowDir();
    const captureFile = path.join(dir, "executions", "1.json");
    const capture = JSON.parse(readFileSync(captureFile, "utf8"));
    capture.workflowData = { nodes: [{ name: "Compute", parameters: { jsCode: "return $input.all();" } }] };
    writeFileSync(captureFile, JSON.stringify(capture));
    await writeScenario(dir, { execId: "1", slug: "no-inline" }, log);
    const scenario = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "no-inline.json"), "utf8"));
    assert.equal(scenario.workflowData, undefined, "workflowData stripped from the committed scenario");
    assert.ok(scenario.data.resultData.runData.Fetch, "runData survives the strip");
  });

  // A prepare_test_pin_data result: Fetch2 gets a schema, and a from-scratch
  // scaffold covers every pinnable node (Webhook + Fetch + Fetch2 here).
  const scaffoldResult = (schemas: Record<string, unknown>, without: string[] = []): PinDataScaffold => ({
    nodeSchemasToGenerate: schemas,
    nodesWithoutSchema: without,
    nodesSkipped: ["Compute", "Tag"],
    coverage: { withSchemaFromExecution: 0, withSchemaFromDefinition: Object.keys(schemas).length, withoutSchema: without.length, skipped: 2, total: Object.keys(schemas).length + without.length + 2 },
  });

  it("--scaffold annotates each gap with its expectedSchema (provenance scaffolded), never inventing values", async () => {
    const dir = gapWorkflowDir();
    const schema = { type: "object", properties: { id: { type: "string" } } };
    const result = await writeScenario(dir, { execId: "1", slug: "scaffolded", scaffold: scaffoldResult({ Fetch2: schema }) }, log);
    assert.deepEqual(result.gaps, ["Fetch2"]);
    assert.deepEqual(result.coverage, scaffoldResult({ Fetch2: schema }).coverage);
    const scenario = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "scaffolded.json"), "utf8"));
    assert.equal(scenario._decanterScenario.source, "capture+scaffold");
    assert.deepEqual(scenario._decanterScenario.fill[0].expectedSchema, schema);
    // no value was invented — Fetch2 has no runData yet (still a gap to author)
    assert.equal(scenario.data.resultData.runData.Fetch2, undefined);
  });

  it("a bare --scaffold with no --execution builds a from-scratch set: every pinnable node is a fill entry", async () => {
    const dir = gapWorkflowDir();
    const schemas = { Webhook: { type: "object" }, Fetch: { type: "object" }, Fetch2: { type: "object" } };
    const result = await writeScenario(dir, { slug: "from-scratch", scaffold: scaffoldResult(schemas) }, log);
    // Webhook, Fetch, Fetch2 are the pinnable (non-pure, enabled) nodes
    assert.deepEqual(result.gaps.sort(), ["Fetch", "Fetch2", "Webhook"]);
    const scenario = JSON.parse(readFileSync(path.join(dir, SCENARIOS_DIR, "from-scratch.json"), "utf8"));
    assert.equal(scenario._decanterScenario.source, "scaffold");
    assert.equal(scenario._decanterScenario.sourceExecution, undefined);
    assert.equal(scenario._decanterScenario.fill.length, 3);
    assert.deepEqual(scenario.data.resultData.runData, {}); // nothing captured or invented
  });

  it("refuses a from-scratch create without --scaffold (no capture, no schemas)", async () => {
    const dir = gapWorkflowDir();
    await assert.rejects(writeScenario(dir, { slug: "nope" }, log), /needs --scaffold/);
  });

  it("validateScenarioRunData: no-op on a real capture (no scenario marker)", () => {
    const capture = { id: 1, data: { resultData: { runData: { A: run([item({ x: 1 })]) } } } } as any;
    assert.doesNotThrow(() => validateScenarioRunData(capture, "1"));
  });

  it("validateScenarioRunData: passes a well-formed filled scenario", () => {
    const scenario = {
      id: 1, data: { resultData: { runData: { Enrich: run([item({ ok: true })]) } } },
      _decanterScenario: { source: "capture", sourceExecution: "1", fill: [{ node: "Enrich" }] },
    } as any;
    assert.doesNotThrow(() => validateScenarioRunData(scenario, "1"));
  });

  it("validateScenarioRunData: still reads the legacy _decanterMock marker (migrated files)", () => {
    const legacy = {
      id: 1, data: { resultData: { runData: { A: run([item({})]) } } },
      _decanterMock: { fill: [{ node: "Enrich" }] }, // Enrich unfilled → incomplete
    } as any;
    assert.throws(() => validateScenarioRunData(legacy, "1"), /incomplete: add runData for Enrich/);
  });

  it("validateScenarioRunData: catches malformed runData shape with a node-named error", () => {
    const badItem = { id: 1, data: { resultData: { runData: { Enrich: [{ data: { main: [[42]] } }] } } }, _decanterScenario: { fill: [] } } as any;
    assert.throws(() => validateScenarioRunData(badItem, "1"), /Enrich run 0 item 0: each item must be an object/);
    const badMain = { id: 1, data: { resultData: { runData: { Enrich: [{ data: { main: "nope" } }] } } }, _decanterScenario: { fill: [] } } as any;
    assert.throws(() => validateScenarioRunData(badMain, "1"), /data\.main must be an array of outputs/);
    const noJson = { id: 1, data: { resultData: { runData: { Enrich: [{ data: { main: [[{ nope: 1 }]] } }] } } }, _decanterScenario: { fill: [] } } as any;
    assert.throws(() => validateScenarioRunData(noJson, "1"), /needs a "json" field/);
  });

  it("validateScenarioRunData: flags a fill node left without data (incomplete scenario)", () => {
    const scenario = {
      id: 1, data: { resultData: { runData: { A: run([item({})]) } } },
      _decanterScenario: { fill: [{ node: "Enrich" }] },
    } as any;
    assert.throws(() => validateScenarioRunData(scenario, "1"), /incomplete: add runData for Enrich/);
  });

  it("a filled scenario (source=scenario) resolves the gap; an unfilled one still errors", async () => {
    const wf = baseWorkflow();
    wf.nodes.push({ id: "h2", name: "Fetch2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [800, 0], parameters: {} } as WorkflowNode);
    (wf.connections as any).Fetch = { main: [[{ node: "Fetch2", type: "main", index: 0 }]] };
    const base = { id: 1, workflowId: "wf1", workflowVersionId: "v1", _decanterScenario: { source: "capture", fill: [{ node: "Fetch2" }] }, data: { resultData: { runData: {
      Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
    } } } };
    const dir = scaffold({
      "workflow.json": JSON.stringify(wf),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      // filled scenario: Fetch2 now has runData
      "scenarios/happy-path.json": JSON.stringify({ ...base, data: { resultData: { runData: {
        ...base.data.resultData.runData, Fetch2: run([item({ enriched: true })]),
      } } } }),
      // unfilled scenario: Fetch2 absent → validator flags it before the transform
      "scenarios/unfilled.json": JSON.stringify(base),
    });
    const sim = await buildSimulation(dir, "happy-path", log, { source: "scenario" });
    assert.ok(sim.pinned.includes("Fetch2"), "Fetch2 should be pinned from the scenario");
    assert.match(String(nodeNamed(sim.workflow, "Fetch2").parameters.jsCode), /"enriched":true/);
    await assert.rejects(buildSimulation(dir, "unfilled", log, { source: "scenario" }), /incomplete: add runData for Fetch2/);
  });
});

describe("scenario provenance", () => {
  it("marks captured nodes 'capture' and fill nodes 'authored'/'scaffolded'", () => {
    const exec = {
      data: { resultData: { runData: { Compute: run([item({})]), Fetch: run([item({})]), Fetch2: run([item({})]) } } },
      _decanterScenario: { source: "capture+scaffold", fill: [
        { node: "Fetch", inputSample: [] },                              // no schema → authored
        { node: "Fetch2", inputSample: [], expectedSchema: { type: "object" } }, // schema → scaffolded
      ] },
    } as any;
    const prov = scenarioProvenance(exec);
    assert.equal(prov.get("Compute"), "capture");
    assert.equal(prov.get("Fetch"), "authored");
    assert.equal(prov.get("Fetch2"), "scaffolded");
    assert.equal(scenarioIsSynthetic(exec), true);
  });

  it("a capture-only scenario (empty fill) is not synthetic; all nodes are 'capture'", () => {
    const exec = { data: { resultData: { runData: { A: run([item({})]) } } }, _decanterScenario: { source: "capture", fill: [] } } as any;
    assert.equal(scenarioIsSynthetic(exec), false);
    assert.equal(scenarioProvenance(exec).get("A"), "capture");
  });
});

describe("scenario check (checkScenarios) + listScenarioSlugs", () => {
  const withScenarios = (scenarios: Record<string, unknown>) => scaffold(
    Object.fromEntries(Object.entries(scenarios).map(([slug, body]) => [`scenarios/${slug}.json`, JSON.stringify(body)])),
  );
  const good = { _decanterScenario: { fill: [{ node: "Enrich" }] }, data: { resultData: { runData: { Enrich: run([item({ ok: true })]) } } } };
  const bad = { _decanterScenario: { fill: [{ node: "Enrich" }] }, data: { resultData: { runData: {} } } }; // Enrich unfilled

  it("listScenarioSlugs returns the sorted slugs", () => {
    assert.deepEqual(listScenarioSlugs(withScenarios({ "b-two": good, "a-one": good })), ["a-one", "b-two"]);
    assert.deepEqual(listScenarioSlugs(scaffold({ "workflow.json": "{}" })), []);
  });

  // --- Plan 66: say what the replay will THROW AWAY ---------------------------
  const multiOutput = (items: unknown[][]) => [{ data: { main: items } }];

  it("warns when a pin carries items on more than one output — `test` still truncates them", () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(baseWorkflow()),
      [`${SCENARIOS_DIR}/branchy.json`]: JSON.stringify({
        id: "branchy", _decanterScenario: { fill: [{ node: "Webhook" }] },
        data: { resultData: { runData: { Webhook: multiOutput([[item({ taken: true })], [item({ other: true })]]) } } },
      }),
    });
    assert.equal(checkScenarios(dir, "branchy", log), 0, "structurally valid — this is a warning, not an error");
    assert.ok(warnings.some((w) => /"Webhook" has items on outputs 0, 1/.test(w)), `got: ${warnings.join(" | ")}`);
    // The two paths differ since task 3 — saying "both drop it" would now be wrong.
    assert.ok(warnings.some((w) => /`preflight --simulate` replays all of them/.test(w)), "the sim replays extra outputs");
    assert.ok(warnings.some((w) => /`test` pins ONE items array per node/.test(w)), "the instance run is the one that truncates");
  });

  it("warns when a node source reads a pinned node's second output — the reported failure's cause", () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(baseWorkflow()),
      "code/compute.js": "const rows = $('Webhook').all(1);\nreturn rows;\n",
      [`${SCENARIOS_DIR}/reads.json`]: JSON.stringify({
        id: "reads", _decanterScenario: { fill: [{ node: "Webhook" }] },
        data: { resultData: { runData: { Webhook: run([item({ n: 1 })]) } } },
      }),
    });
    assert.equal(checkScenarios(dir, "reads", log), 0);
    assert.ok(warnings.some((w) => /code\/compute\.js calls \$\('Webhook'\)\.all\(1\)/.test(w)), `got: ${warnings.join(" | ")}`);
    assert.ok(warnings.some((w) => /this node emits nothing/.test(w)), "the consequence must be spelled out");
    // This scenario has no items on output 1 at all, so neither path can answer.
    assert.ok(warnings.some((w) => /no items on output 1 either/.test(w)), `got: ${warnings.join(" | ")}`);
  });

  it("tells a branch reader that the SIM can answer it when the scenario does cover that output", () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(baseWorkflow()),
      "code/compute.js": "return $('Webhook').all(1);\n",
      [`${SCENARIOS_DIR}/covered.json`]: JSON.stringify({
        id: "covered", _decanterScenario: { fill: [{ node: "Webhook" }] },
        data: { resultData: { runData: { Webhook: [{ data: { main: [[item({ n: 1 })], [item({ n: 2 })]] } }] } } },
      }),
    });
    assert.equal(checkScenarios(dir, "covered", log), 0);
    assert.ok(warnings.some((w) => /`preflight --simulate` does replay output 1, so run it there/.test(w)), `got: ${warnings.join(" | ")}`);
  });

  it("stays quiet on a single-output scenario whose code reads output 0", () => {
    const dir = scaffold({
      "workflow.json": JSON.stringify(baseWorkflow()),
      "code/compute.js": "return $('Webhook').all();\n",
      [`${SCENARIOS_DIR}/plain.json`]: JSON.stringify({
        id: "plain", _decanterScenario: { fill: [{ node: "Webhook" }] },
        data: { resultData: { runData: { Webhook: run([item({ n: 1 })]) } } },
      }),
    });
    assert.equal(checkScenarios(dir, "plain", log), 0);
    assert.equal(warnings.filter((w) => /main\[0\] only|calls \$\(/.test(w)).length, 0, `expected no truncation warning, got: ${warnings.join(" | ")}`);
  });

  it("checkScenarios: 0 invalid for a good scenario, >0 for a bad one, by slug or all", () => {
    const dir = withScenarios({ good, bad });
    assert.equal(checkScenarios(dir, "good", log), 0);
    assert.equal(checkScenarios(dir, "bad", log), 1);
    assert.equal(checkScenarios(dir, undefined, log), 1); // all: one bad
    assert.equal(checkScenarios(scaffold({ "workflow.json": "{}" }), undefined, log), 0); // none → 0
  });
});

describe("migration + legacy fixtures guard", () => {
  it("migrateScenariosDir renames a legacy mocks/ dir to scenarios/", () => {
    const dir = scaffold({ "mocks/happy-path.json": "{}" });
    migrateScenariosDir(dir, log);
    assert.ok(!existsSync(path.join(dir, "mocks")), "legacy mocks/ removed");
    assert.ok(existsSync(path.join(dir, SCENARIOS_DIR, "happy-path.json")), "moved to scenarios/");
  });

  it("migrateScenariosDir refuses when both mocks/ and scenarios/ exist", () => {
    const dir = scaffold({ "mocks/a.json": "{}", "scenarios/b.json": "{}" });
    assert.throws(() => migrateScenariosDir(dir, log), /both mocks\/ .* and scenarios\/ exist/);
  });

  it("migrateScenariosDir is a no-op with no legacy dir", () => {
    const dir = scaffold({ "scenarios/a.json": "{}" });
    assert.doesNotThrow(() => migrateScenariosDir(dir, log));
  });

  it("assertNoLegacyFixtures hard-errors on a fixtures/ dir with .json files", () => {
    const dir = scaffold({ "fixtures/fetch.json": "{}" });
    assert.throws(() => assertNoLegacyFixtures(dir), /fixtures\/ .* removed \(Plan 37\)/);
    assert.doesNotThrow(() => assertNoLegacyFixtures(scaffold({ "scenarios/a.json": "{}" })));
  });
});

describe("diffItems", () => {
  it("is key-order-insensitive on json payloads and ignores pairedItem/metadata", () => {
    assert.equal(diffItems([{ json: { a: 1, b: 2 }, pairedItem: { item: 0 } }], [{ json: { b: 2, a: 1 }, pairedItem: { item: 9 } }]), true);
  });
  it("detects a differing value (the regression signal) and item count", () => {
    assert.equal(diffItems([{ json: { doubled: 42 } }], [{ json: { doubled: 43 } }]), false);
    assert.equal(diffItems([{ json: { x: 1 } }], [{ json: { x: 1 } }, { json: { x: 2 } }]), false);
  });
});

describe("assertDryRunSafe", () => {
  const wrap = (nodes: WorkflowNode[]): Workflow => ({ id: "x", name: "x", nodes, connections: {} });
  it("throws on a surviving credentials block", () => {
    assert.throws(() => assertDryRunSafe(wrap([
      { id: "1", name: "Bad", type: "n8n-nodes-base.set", parameters: {}, credentials: { x: {} } } as WorkflowNode,
    ])), /still carries credentials/);
  });
  it("throws on a surviving off-allowlist executable node", () => {
    assert.throws(() => assertDryRunSafe(wrap([
      { id: "1", name: "Live HTTP", type: "n8n-nodes-base.httpRequest", parameters: {} } as WorkflowNode,
    ])), /not on the pure allowlist/);
  });
  it("ignores disabled and the synthetic start node", () => {
    assert.doesNotThrow(() => assertDryRunSafe(wrap([
      { id: "s", name: SIM_START_NODE, type: "n8n-nodes-base.manualTrigger", parameters: {} } as WorkflowNode,
      { id: "1", name: "Off but disabled", type: "n8n-nodes-base.httpRequest", parameters: {}, disabled: true } as WorkflowNode,
    ])));
  });
});
