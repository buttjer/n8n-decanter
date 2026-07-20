// Unit tests for the offline `add` verb (lib/add.mts): a temp workflow folder,
// a capturing log — no HTTP, no network.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { addCodeNode } from "../../lib/add.mts";
import type { Log } from "../../lib/types.mts";

function capturingLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
}

/** A minimal pulled workflow folder with one non-code node. */
function seedWorkflow(root: string, id = "wf1"): string {
  const dir = path.join(root, "Demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: id, nodes: {} }));
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({
    id, name: "Demo",
    nodes: [{ id: "n1", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
  }, null, 2));
  return dir;
}

describe("addCodeNode", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const root = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-add-")));

  it("scaffolds a disconnected Code node: node object, source file, state entry", () => {
    const r = root();
    const dir = seedWorkflow(r);
    const { log, lines } = capturingLog();
    addCodeNode(r, "wf1", "Parse Order", {}, log);

    const wf = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"));
    const node = wf.nodes.find((n: any) => n.name === "Parse Order");
    assert.ok(node, "node appended");
    assert.equal(node.type, "n8n-nodes-base.code");
    assert.equal(node.typeVersion, 2);
    assert.equal(node.parameters.mode, "runOnceForAllItems");
    assert.equal(node.parameters.jsCode, "//@file:code/parse-order.js");
    assert.match(node.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "v4 uuid");
    assert.ok(existsSync(path.join(dir, "code", "parse-order.js")), "source file written");
    assert.deepEqual(wf.connections, {}, "no connections wired");

    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    assert.equal(state.nodes[node.id].file, "code/parse-order.js", "registered in state");
    assert.match(lines.join("\n"), /added Code node "Parse Order"/);
  });

  it("--ts writes a .ts source and a .ts placeholder", () => {
    const r = root();
    const dir = seedWorkflow(r);
    const { log } = capturingLog();
    addCodeNode(r, "wf1", "Typed Step", { ts: true }, log);
    const wf = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"));
    const node = wf.nodes.find((n: any) => n.name === "Typed Step");
    assert.equal(node.parameters.jsCode, "//@file:code/typed-step.ts");
    assert.ok(existsSync(path.join(dir, "code", "typed-step.ts")));
  });

  it("colliding kebab base falls back to the -<id8> suffix", () => {
    const r = root();
    const dir = seedWorkflow(r);
    const { log } = capturingLog();
    addCodeNode(r, "wf1", "Parse Order", {}, log);
    addCodeNode(r, "wf1", "Parse-Order", {}, log); // kebabs to the same base
    const files = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"))
      .nodes.filter((n: any) => n.type === "n8n-nodes-base.code")
      .map((n: any) => n.parameters.jsCode);
    assert.ok(files.includes("//@file:code/parse-order.js"));
    assert.ok(files.some((f: string) => /^\/\/@file:code\/parse-order-[0-9a-f]{8}\.js$/.test(f)), "suffixed sibling: " + files.join(","));
  });

  it("refuses a duplicate node name and writes nothing", () => {
    const r = root();
    const dir = seedWorkflow(r);
    const { log } = capturingLog();
    addCodeNode(r, "wf1", "Parse Order", {}, log);
    assert.throws(() => addCodeNode(r, "wf1", "Parse Order", {}, log), /a node named "Parse Order" already exists/);
    const codeFiles = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"))
      .nodes.filter((n: any) => n.type === "n8n-nodes-base.code");
    assert.equal(codeFiles.length, 1, "no second node added");
  });

  it("rejects an empty node name and an unknown workflow", () => {
    const r = root();
    seedWorkflow(r);
    const { log } = capturingLog();
    assert.throws(() => addCodeNode(r, "wf1", "   ", {}, log), /node name must not be empty/);
    assert.throws(() => addCodeNode(r, "nope", "X", {}, log), /workflow nope not found/);
  });
});
