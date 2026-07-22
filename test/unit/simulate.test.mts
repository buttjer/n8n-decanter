// Offline unit tests for lib/simulate.mts — the fixture loader + route-B
// transform (Plan 7 task 2). No engine, no mock server: pure file-in/JSON-out.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertDryRunSafe,
  buildSimulation,
  checkMocks,
  detectGaps,
  diffItems,
  isPureNode,
  listMockSlugs,
  pinFixtures,
  PURE_NODE_TYPES,
  SIM_CAP_PREFIX,
  SIM_START_NODE,
  SimulationGapError,
  sourceFile,
  validateMockRunData,
  writeMock,
} from "../../lib/simulate.mts";
import { MOCKS_DIR, latestCaptureId } from "../../lib/executions.mts";
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

describe("buildSimulation — fixture precedence", () => {
  it("prefers a committed fixture over the capture's runData", async () => {
    const dir = scaffoldBase(undefined, {
      "fixtures/fetch.json": JSON.stringify({ source: "capture", node: "Fetch", execId: 9, items: [item({ status: "pinned-override" })] }),
    });
    const sim = await buildSimulation(dir, "1", log);
    assert.match(String(nodeNamed(sim.workflow, "Fetch").parameters.jsCode), /pinned-override/);
    assert.deepEqual(sim.captured.get("Fetch"), [item({ status: "pinned-override" })]);
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

describe("latestCaptureId", () => {
  it("returns the highest numeric capture id (newest), ignoring non-numeric files", () => {
    const dir = scaffold({
      "executions/3.json": "{}", "executions/17.json": "{}", "executions/9.json": "{}",
      "executions/notes.json": "{}", "executions/.gitignore": "*",
    });
    assert.equal(latestCaptureId(dir), "17");
  });
  it("does not count committed mocks (slug-named scenarios aren't 'latest'-ordered)", () => {
    const dir = scaffold({ "executions/3.json": "{}", "mocks/happy-path.json": "{}" });
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

describe("mock create (writeMock) + sourceFile resolution", () => {
  it("sourceFile resolves mocks by slug and captures by id", () => {
    const dir = scaffold({ "executions/1.json": "{}", "mocks/happy-path.json": "{}" });
    assert.ok(sourceFile(dir, "happy-path", "mock")!.includes(`${MOCKS_DIR}/happy-path.json`));
    assert.ok(sourceFile(dir, "1", "capture")!.includes("executions/1.json"));
    assert.equal(sourceFile(dir, "nope", "mock"), null);
    // a mock ref is kebab-slugged on lookup
    assert.ok(sourceFile(dir, "Happy Path", "mock")!.includes("happy-path.json"));
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

  it("promotes a capture to a named mock scenario, flagging gap nodes to fill", async () => {
    const dir = gapWorkflowDir();
    const result = await writeMock(dir, "1", "happy path", log); // slug kebab-slugged
    assert.equal(result.slug, "happy-path");
    assert.deepEqual(result.gaps, ["Fetch2"]);
    const mock = JSON.parse(readFileSync(path.join(dir, MOCKS_DIR, "happy-path.json"), "utf8"));
    // the mock is a full copy of the capture (real runData preserved) + guidance block
    assert.deepEqual(mock.data.resultData.runData.Fetch, run([item({ status: "ok" })]));
    assert.equal(mock._decanterMock.sourceExecution, "1");
    assert.equal(mock._decanterMock.fill.length, 1);
    assert.equal(mock._decanterMock.fill[0].node, "Fetch2");
    assert.deepEqual(mock._decanterMock.fill[0].inputSample, [{ status: "ok" }]);
    assert.ok(warnings.some((w) => /credentials\/PII/.test(w)), warnings.join("|"));
    // refuses to clobber an existing mock (protects hand-filled data)
    await assert.rejects(writeMock(dir, "1", "happy path", log), /mock "happy-path" already exists/);
  });

  it("defaults the slug to the execution id when none is given", async () => {
    const dir = gapWorkflowDir();
    const result = await writeMock(dir, "1", "1", log);
    assert.equal(result.slug, "1");
    assert.ok(existsSync(path.join(dir, MOCKS_DIR, "1.json")));
  });

  it("validateMockRunData: no-op on a real capture (no _decanterMock marker)", () => {
    const capture = { id: 1, data: { resultData: { runData: { A: run([item({ x: 1 })]) } } } } as any;
    assert.doesNotThrow(() => validateMockRunData(capture, "1"));
  });

  it("validateMockRunData: passes a well-formed filled mock", () => {
    const mock = {
      id: 1, data: { resultData: { runData: { Enrich: run([item({ ok: true })]) } } },
      _decanterMock: { sourceExecution: "1", fill: [{ node: "Enrich" }] },
    } as any;
    assert.doesNotThrow(() => validateMockRunData(mock, "1"));
  });

  it("validateMockRunData: catches malformed runData shape with a node-named error", () => {
    const badItem = { id: 1, data: { resultData: { runData: { Enrich: [{ data: { main: [[42]] } }] } } }, _decanterMock: { fill: [] } } as any;
    assert.throws(() => validateMockRunData(badItem, "1"), /Enrich run 0 item 0: each item must be an object/);
    const badMain = { id: 1, data: { resultData: { runData: { Enrich: [{ data: { main: "nope" } }] } } }, _decanterMock: { fill: [] } } as any;
    assert.throws(() => validateMockRunData(badMain, "1"), /data\.main must be an array of outputs/);
    const noJson = { id: 1, data: { resultData: { runData: { Enrich: [{ data: { main: [[{ nope: 1 }]] } }] } } }, _decanterMock: { fill: [] } } as any;
    assert.throws(() => validateMockRunData(noJson, "1"), /needs a "json" field/);
  });

  it("validateMockRunData: flags a fill node left without data (incomplete mock)", () => {
    const mock = {
      id: 1, data: { resultData: { runData: { A: run([item({})]) } } },
      _decanterMock: { fill: [{ node: "Enrich" }] },
    } as any;
    assert.throws(() => validateMockRunData(mock, "1"), /incomplete: add runData for Enrich/);
  });

  it("a filled mock (source=mock) resolves the gap; an unfilled one still errors", async () => {
    const wf = baseWorkflow();
    wf.nodes.push({ id: "h2", name: "Fetch2", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [800, 0], parameters: {} } as WorkflowNode);
    (wf.connections as any).Fetch = { main: [[{ node: "Fetch2", type: "main", index: 0 }]] };
    const base = { id: 1, workflowId: "wf1", workflowVersionId: "v1", _decanterMock: { fill: [{ node: "Fetch2" }] }, data: { resultData: { runData: {
      Webhook: run([item({})]), Compute: run([item({})]), Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
    } } } };
    const dir = scaffold({
      "workflow.json": JSON.stringify(wf),
      ".decanter.json": JSON.stringify({ workflowId: "wf1", nodes: { c: { file: "code/compute.js" } } }),
      "code/compute.js": "return [];\n",
      // filled mock: Fetch2 now has runData
      "mocks/happy-path.json": JSON.stringify({ ...base, data: { resultData: { runData: {
        ...base.data.resultData.runData, Fetch2: run([item({ enriched: true })]),
      } } } }),
      // unfilled mock: Fetch2 absent → validator flags it before the transform
      "mocks/unfilled.json": JSON.stringify(base),
    });
    const sim = await buildSimulation(dir, "happy-path", log, { source: "mock" });
    assert.ok(sim.pinned.includes("Fetch2"), "Fetch2 should be pinned from the mock");
    assert.match(String(nodeNamed(sim.workflow, "Fetch2").parameters.jsCode), /"enriched":true/);
    await assert.rejects(buildSimulation(dir, "unfilled", log, { source: "mock" }), /incomplete: add runData for Fetch2/);
  });
});

describe("mock check (checkMocks) + listMockSlugs", () => {
  const withMocks = (mocks: Record<string, unknown>) => scaffold(
    Object.fromEntries(Object.entries(mocks).map(([slug, body]) => [`mocks/${slug}.json`, JSON.stringify(body)])),
  );
  const goodMock = { _decanterMock: { fill: [{ node: "Enrich" }] }, data: { resultData: { runData: { Enrich: run([item({ ok: true })]) } } } };
  const badMock = { _decanterMock: { fill: [{ node: "Enrich" }] }, data: { resultData: { runData: {} } } }; // Enrich unfilled

  it("listMockSlugs returns the sorted slugs", () => {
    assert.deepEqual(listMockSlugs(withMocks({ "b-two": goodMock, "a-one": goodMock })), ["a-one", "b-two"]);
    assert.deepEqual(listMockSlugs(scaffold({ "workflow.json": "{}" })), []);
  });

  it("checkMocks: 0 invalid for a good mock, >0 for a bad one, by slug or all", () => {
    const dir = withMocks({ good: goodMock, bad: badMock });
    assert.equal(checkMocks(dir, "good", log), 0);
    assert.equal(checkMocks(dir, "bad", log), 1);
    assert.equal(checkMocks(dir, undefined, log), 1); // all: one bad
    assert.equal(checkMocks(scaffold({ "workflow.json": "{}" }), undefined, log), 0); // none → 0
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

describe("pinFixtures", () => {
  it("writes provenance-stamped fixtures for network nodes only, with a PII warning", () => {
    const dir = scaffoldBase();
    pinFixtures(dir, "1", log);
    // Webhook + Fetch are network -> pinned; Compute/Tag are pure -> skipped
    const webhook = JSON.parse(readFileSync(path.join(dir, "fixtures", "webhook.json"), "utf8"));
    assert.equal(webhook.source, "capture");
    assert.equal(webhook.node, "Webhook");
    assert.equal(webhook.execId, "1");
    assert.equal(webhook.workflowVersionId, "v1");
    assert.deepEqual(webhook.items, [item({ body: { n: 21 } })]);
    assert.ok(existsSync(path.join(dir, "fixtures", "fetch.json")));
    assert.ok(!existsSync(path.join(dir, "fixtures", "compute.json")));
    assert.ok(warnings.some((w) => /credentials\/PII/.test(w)), warnings.join("|"));
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
