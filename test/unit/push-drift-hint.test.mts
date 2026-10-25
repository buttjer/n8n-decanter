// Plan 89 regression guard: the drift abort must NOT carry the "pull it, and
// pull needs MCP access" chain. The workflow in that case is pulled AND opted
// into MCP (push just read it over MCP), so the opt-in hint would be wrong
// advice. test/unit/push.test.mts matches the drift message only by prefix,
// so it would not notice an appended hint — this file pins the absence.
//
// Same approach as push.test.mts: a temp pulled folder plus a stubbed
// McpClient (callTool only), no HTTP server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ENABLE_MCP_HINT, type McpClient } from "../../lib/mcp.mts";
import { pushWorkflow } from "../../lib/push.mts";
import type { Log, Workflow } from "../../lib/types.mts";
import { sha256 } from "../../lib/util.mts";

const CODE = "return [];\n";
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-push-drift-hint-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("push drift abort carries no MCP opt-in hint (Plan 89)", () => {
  it("says pull first, and does not include ENABLE_MCP_HINT", async () => {
    const dir = path.join(TMP, "test-flow");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    writeFileSync(path.join(dir, "code", "alpha.js"), CODE + "// local edit\n");
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({
      workflowId: "wf1", name: "Test",
      nodes: { n2: { file: "code/alpha.js", lastPushedHash: sha256(CODE), name: "Alpha" } },
    }, null, 2));
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({
      id: "wf1", name: "Test",
      nodes: [{ id: "n2", name: "Alpha", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { jsCode: "//@file:code/alpha.js" } }],
      connections: {},
    }, null, 2));
    // The remote moved off the last-sync hash: a UI hotfix since the pull.
    const remote: Workflow = {
      id: "wf1", name: "Test", active: false, versionId: "v1", activeVersionId: null, connections: {}, settings: {},
      nodes: [{ id: "n2", name: "Alpha", type: "n8n-nodes-base.code", parameters: { jsCode: CODE + "// UI hotfix\n" } }],
    };
    const mcp = {
      callTool: async (name: string) => {
        if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
        throw new Error(`unexpected tool ${name} — the drift guard must abort before any write`);
      },
    } as unknown as McpClient;
    const lines: string[] = [];
    const log: Log = { info: (m) => lines.push(m), ok: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };

    let message = "(no error thrown)";
    try {
      await pushWorkflow(mcp, TMP, "wf1", {}, log);
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /remote code changed since last sync — pull first/, "this really is the drift abort");
    assert.ok(!message.includes(ENABLE_MCP_HINT), `the drift abort must not carry the chain — got:\n${message}`);
    assert.ok(!lines.join("\n").includes(ENABLE_MCP_HINT), "nor log it alongside");
  });
});
