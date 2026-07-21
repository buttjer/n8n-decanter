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
  diffItems,
  isPureNode,
  pinFixtures,
  PURE_NODE_TYPES,
  SIM_START_NODE,
} from "../../lib/simulate.mts";
import { latestCaptureId } from "../../lib/executions.mts";
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
    await assert.rejects(buildSimulation(dir, "1", log), /no captured output for network node\(s\): Fetch2/);
  });

  it("hard-errors on a multi-run (loop) capture", async () => {
    const runData = {
      Webhook: run([item({})]), Compute: [{ data: { main: [[item({})]] } }, { data: { main: [[item({})]] } }],
      Tag: run([item({})]), Fetch: run([item({ status: "ok" })]),
    };
    await assert.rejects(buildSimulation(scaffoldBase(runData), "1", log), /loop workflows are out of scope/);
  });

  it("errors when the capture file is missing", async () => {
    await assert.rejects(buildSimulation(scaffoldBase(), "999", log), /not captured under/);
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
  it("returns null when there are no captures", () => {
    assert.equal(latestCaptureId(scaffold({ "workflow.json": "{}" })), null);
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
