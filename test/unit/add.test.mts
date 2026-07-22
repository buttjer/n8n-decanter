// Unit tests for `node create` (lib/add.mts, Plan 32): the node is born in
// n8n over a stubbed McpClient (addNode — the stub even re-mints the id, like
// the real server may) and lands locally via the follow-up pull.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { addCodeNode } from "../../lib/add.mts";
import type { McpClient } from "../../lib/mcp.mts";
import type { DecanterConfig, Log, Workflow } from "../../lib/types.mts";

function capturingLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
}

const baseConfig = (root: string): DecanterConfig => ({
  configDir: root, root, workflows: [], commitOnPush: false, commitOnPull: false,
  browserReload: "off", proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, host: "http://x", apiKey: "",
});

/** A stub McpClient over one mutable remote workflow; addNode re-mints ids. */
function stubMcp(remote: Workflow) {
  let minted = 0;
  const mcp = {
    callTool: async (name: string, args: any) => {
      if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
      if (name === "update_workflow") {
        for (const op of args.operations) {
          if (op.type !== "addNode") throw new Error("unexpected op " + op.type);
          if (remote.nodes.some((n) => n.name === op.node.name)) throw new Error(`Operation 0 failed: node '${op.node.name}' already exists`);
          remote.nodes.push({ ...op.node, id: `minted-${minted++}` });
        }
        return { workflowId: remote.id, name: remote.name, nodeCount: remote.nodes.length, appliedOperations: args.operations.length, validationWarnings: [] };
      }
      throw new Error("unexpected tool " + name);
    },
  } as unknown as McpClient;
  return mcp;
}

/** A minimal pulled workflow folder with one non-code node. */
function seedWorkflow(root: string, id = "wf1"): { dir: string; remote: Workflow } {
  const dir = path.join(root, "Demo");
  mkdirSync(dir, { recursive: true });
  const remote: Workflow = {
    id, name: "Demo",
    nodes: [{ id: "n1", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} }],
    connections: {},
    settings: {},
  };
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: id, nodes: {} }));
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(remote, null, 2));
  return { dir, remote };
}

describe("addCodeNode", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const root = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-add-")));

  it("creates the node in n8n and lands it locally: file, placeholder, state under the server id", async () => {
    const r = root();
    const { dir, remote } = seedWorkflow(r);
    const { log, lines } = capturingLog();
    await addCodeNode(stubMcp(remote), baseConfig(r), "wf1", "Parse Order", {}, log);

    const remoteNode = remote.nodes.find((n) => n.name === "Parse Order");
    assert.ok(remoteNode, "node exists in n8n");
    assert.equal(remoteNode!.type, "n8n-nodes-base.code");
    assert.equal(remoteNode!.parameters.mode, "runOnceForAllItems");
    assert.match(String(remoteNode!.parameters.jsCode), /New Code node/, "starter source lives on the server");

    const wf = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"));
    const node = wf.nodes.find((n: any) => n.name === "Parse Order");
    assert.ok(node, "node landed in the snapshot via pull");
    assert.equal(node.id, remoteNode!.id, "snapshot carries the server-minted id");
    assert.equal(node.parameters.jsCode, "//@file:code/parse-order.js");
    assert.ok(existsSync(path.join(dir, "code", "parse-order.js")), "source file extracted");
    assert.deepEqual(wf.connections, {}, "no connections wired");

    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    assert.equal(state.nodes[remoteNode!.id].file, "code/parse-order.js", "registered in state under the server id");
    assert.match(lines.join("\n"), /added Code node "Parse Order"/);
  });

  it("--ts converts the pulled .js to .ts in place (marker lands on first push)", async () => {
    const r = root();
    const { dir, remote } = seedWorkflow(r);
    const { log } = capturingLog();
    await addCodeNode(stubMcp(remote), baseConfig(r), "wf1", "Typed Step", { ts: true }, log);
    const wf = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"));
    const node = wf.nodes.find((n: any) => n.name === "Typed Step");
    assert.equal(node.parameters.jsCode, "//@file:code/typed-step.ts");
    assert.ok(existsSync(path.join(dir, "code", "typed-step.ts")));
    assert.ok(!existsSync(path.join(dir, "code", "typed-step.js")), "js original renamed away");
    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    assert.equal(state.nodes[node.id].file, "code/typed-step.ts");
  });

  it("colliding kebab base falls back to the -<id8> suffix", async () => {
    const r = root();
    const { dir, remote } = seedWorkflow(r);
    const { log } = capturingLog();
    const mcp = stubMcp(remote); // one stub — its minted-id counter must not reset between calls
    await addCodeNode(mcp, baseConfig(r), "wf1", "Parse Order", {}, log);
    await addCodeNode(mcp, baseConfig(r), "wf1", "Parse-Order", {}, log); // kebabs to the same base
    const files = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"))
      .nodes.filter((n: any) => n.type === "n8n-nodes-base.code")
      .map((n: any) => n.parameters.jsCode);
    assert.ok(files.includes("//@file:code/parse-order.js"));
    assert.ok(files.some((f: string) => /^\/\/@file:code\/parse-order-[0-9a-z-]{1,8}\.js$/.test(f)), "suffixed sibling: " + files.join(","));
  });

  it("refuses a duplicate node name locally and creates nothing", async () => {
    const r = root();
    const { dir, remote } = seedWorkflow(r);
    const { log } = capturingLog();
    const mcp = stubMcp(remote);
    await addCodeNode(mcp, baseConfig(r), "wf1", "Parse Order", {}, log);
    await assert.rejects(addCodeNode(mcp, baseConfig(r), "wf1", "Parse Order", {}, log), /a node named "Parse Order" already exists/);
    const codeFiles = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"))
      .nodes.filter((n: any) => n.type === "n8n-nodes-base.code");
    assert.equal(codeFiles.length, 1, "no second node added");
    assert.equal(remote.nodes.filter((n) => n.type === "n8n-nodes-base.code").length, 1, "nothing created remotely");
  });

  it("rejects an empty node name and an unknown workflow", async () => {
    const r = root();
    const { remote } = seedWorkflow(r);
    const { log } = capturingLog();
    await assert.rejects(addCodeNode(stubMcp(remote), baseConfig(r), "wf1", "   ", {}, log), /node name must not be empty/);
    await assert.rejects(addCodeNode(stubMcp(remote), baseConfig(r), "nope", "X", {}, log), /workflow nope not found/);
  });
});
