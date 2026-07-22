// Unit tests for the MCP push path (lib/push.mts, Plan 32): a temp pulled
// folder + a stubbed McpClient (callTool only) — no HTTP server. Covers the
// per-node drift guard (the only guard left), name-addressing by fresh remote
// read, silent re-baselining, and the untracked/deleted node paths.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { McpClient } from "../../lib/mcp.mts";
import { pushWorkflow } from "../../lib/push.mts";
import type { Log, Workflow } from "../../lib/types.mts";
import { sha256 } from "../../lib/util.mts";

const CODE_A = "return [];\n";
const CODE_B = "return $input.all();\n";

function capturingLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
}

/** A stub McpClient backed by one mutable remote workflow. */
function stubMcp(remote: Workflow) {
  const updates: any[][] = [];
  const mcp = {
    callTool: async (name: string, args: any) => {
      if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
      if (name === "update_workflow") {
        updates.push(args.operations);
        for (const op of args.operations) {
          const node = remote.nodes.find((n) => n.name === op.nodeName);
          if (!node) throw new Error(`Operation failed: node '${op.nodeName}' not found`);
          node.parameters = { ...node.parameters, ...op.parameters };
        }
        return { workflowId: remote.id, name: remote.name, nodeCount: remote.nodes.length, appliedOperations: args.operations.length, validationWarnings: [] };
      }
      if (name === "publish_workflow") {
        remote.active = true;
        remote.activeVersionId = remote.versionId;
        return { success: true, workflowId: remote.id, activeVersionId: remote.activeVersionId };
      }
      throw new Error("unexpected tool " + name);
    },
  } as unknown as McpClient;
  return { mcp, updates };
}

/** A pulled folder for wf1 with two synced JS nodes (Alpha → alpha.js, Beta → beta.js). */
function seedFolder(root: string): string {
  const dir = path.join(root, "test-flow");
  mkdirSync(path.join(dir, "code"), { recursive: true });
  writeFileSync(path.join(dir, "code", "alpha.js"), CODE_A);
  writeFileSync(path.join(dir, "code", "beta.js"), CODE_B);
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({
    workflowId: "wf1", name: "Test",
    nodes: {
      n2: { file: "code/alpha.js", lastPushedHash: sha256(CODE_A), name: "Alpha" },
      n3: { file: "code/beta.js", lastPushedHash: sha256(CODE_B), name: "Beta" },
    },
  }, null, 2));
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({
    id: "wf1", name: "Test",
    nodes: [
      { id: "n1", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
      { id: "n2", name: "Alpha", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0], parameters: { jsCode: "//@file:code/alpha.js" } },
      { id: "n3", name: "Beta", type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 0], parameters: { jsCode: "//@file:code/beta.js" } },
    ],
    connections: {},
  }, null, 2));
  return dir;
}

const remoteWorkflow = (): Workflow => ({
  id: "wf1", name: "Test", active: false, versionId: "v1", activeVersionId: null, connections: {}, settings: {},
  nodes: [
    { id: "n1", name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
    { id: "n2", name: "Alpha", type: "n8n-nodes-base.code", parameters: { jsCode: CODE_A, mode: "runOnceForAllItems" } },
    { id: "n3", name: "Beta", type: "n8n-nodes-base.code", parameters: { jsCode: CODE_B } },
  ],
});

describe("pushWorkflow (MCP)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const root = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-push-")));

  it("is a no-op when every node body matches the remote", async () => {
    const r = root();
    seedFolder(r);
    const { mcp, updates } = stubMcp(remoteWorkflow());
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 0, "no update_workflow call");
    assert.match(lines.join("\n"), /code already in sync — nothing to push/);
  });

  it("pushes only changed nodes, addressed by the node's CURRENT remote name (id anchor)", async () => {
    const r = root();
    const dir = seedFolder(r);
    const remote = remoteWorkflow();
    // n2 was renamed remotely (id stays) — the op must use the new name
    remote.nodes[1].name = "Alpha Renamed";
    const { mcp, updates } = stubMcp(remote);
    writeFileSync(path.join(dir, "code", "alpha.js"), CODE_A + "// edit\n");
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].length, 1, "only the changed node is written");
    assert.deepEqual(Object.keys(updates[0][0].parameters), ["jsCode"], "jsCode-only merge write");
    assert.equal(updates[0][0].nodeName, "Alpha Renamed");
    assert.equal(remote.nodes[1].parameters.mode, "runOnceForAllItems", "sibling params survive the merge");
    // hashes recorded from the confirming read
    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    assert.equal(state.nodes.n2.lastPushedHash, sha256(CODE_A + "// edit\n"));
    assert.equal(state.nodes.n2.name, "Alpha Renamed", "cached node name refreshed");
    assert.match(lines.join("\n"), /pushed "Test" \(wf1\) — 1 node — unpublished draft/);
  });

  it("aborts on remote code drift; --force overwrites the draft", async () => {
    const r = root();
    seedFolder(r);
    const remote = remoteWorkflow();
    remote.nodes[2].parameters.jsCode = CODE_B + "// UI hotfix\n";
    const { mcp, updates } = stubMcp(remote);
    const { log } = capturingLog();
    await assert.rejects(pushWorkflow(mcp, r, "wf1", {}, log), /remote code changed since last sync — pull first/);
    assert.equal(updates.length, 0, "nothing written on abort");
    await pushWorkflow(mcp, r, "wf1", { force: true }, log);
    assert.equal(remote.nodes[2].parameters.jsCode, CODE_B, "--force restored the local body");
  });

  it("re-baselines silently when the remote moved to exactly the local content", async () => {
    const r = root();
    const dir = seedFolder(r);
    const remote = remoteWorkflow();
    // stale lastPushedHash, but remote already equals local — not drift
    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    state.nodes.n3.lastPushedHash = sha256("something else entirely");
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state, null, 2));
    const { mcp, updates } = stubMcp(remote);
    const { log } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 0);
    const after = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    assert.equal(after.nodes.n3.lastPushedHash, sha256(CODE_B), "hash re-baselined from the read");
  });

  it("skips nodes deleted remotely (warn) and points at untracked remote Code nodes (info)", async () => {
    const r = root();
    const dir = seedFolder(r);
    const remote = remoteWorkflow();
    remote.nodes = remote.nodes.filter((n) => n.id !== "n3"); // Beta deleted remotely
    remote.nodes.push({ id: "n9", name: "Fresh", type: "n8n-nodes-base.code", parameters: { jsCode: "return 1;\n" } });
    const { mcp } = stubMcp(remote);
    writeFileSync(path.join(dir, "code", "alpha.js"), CODE_A + "// edit\n");
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    const out = lines.join("\n");
    assert.match(out, /warn node "Beta" \(code\/beta\.js\) no longer exists remotely — skipped/);
    assert.match(out, /info remote Code node "Fresh" isn't tracked locally — pull to extract it/);
    assert.match(out, /ok pushed "Test" \(wf1\) — 1 node/);
  });

  it("publish: true takes the draft live after the push", async () => {
    const r = root();
    seedFolder(r);
    const remote = remoteWorkflow();
    const { mcp } = stubMcp(remote);
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", { publish: true }, log);
    assert.equal(remote.active, true);
    assert.match(lines.join("\n"), /published "Test" \(wf1\) — code is live now/);
  });
});
