// Regression tests for `pull`'s per-node reporting (lib/pull.mts). Pull runs
// its own copy of the parity/drift ladder for TS-managed nodes, and it carried
// the same hole as the read-side ladder in lib/status.mts: an absent baseline
// fell through every comparison into "CONFLICT".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { McpClient } from "../../lib/mcp.mts";
import { pullWorkflow } from "../../lib/pull.mts";
import type { Log, Workflow } from "../../lib/types.mts";
import { withMarker } from "../../lib/util.mts";

const remoteWorkflow = (jsCode: string): Workflow => ({
  id: "wf1", name: "Order Sync", connections: {}, active: false, versionId: "v1", activeVersionId: null,
  nodes: [
    { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
    { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0], parameters: { jsCode } },
  ],
});

const stubMcp = (remote: Workflow): McpClient =>
  ({ callTool: async (name: string) => {
    if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
    throw new Error(`unexpected tool ${name}`);
  } }) as unknown as McpClient;

function capture(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: { info: (m) => lines.push(m), ok: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } };
}

describe("pullWorkflow — TS-managed node reporting", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("does not report a CONFLICT for a TS node with no baseline hash", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-pull-"));
    const dir = path.join(tmp, "order-sync");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    writeFileSync(path.join(dir, "code", "compute.ts"), "const a: number = 1;\nreturn [{ json: { local: a } }];\n");
    // tracked as .ts, TS-managed on the remote — but the baseline is absent, so
    // nothing is known about whether the remote moved.
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "wf1", name: "Order Sync", nodes: { c: { file: "code/compute.ts", name: "Compute" } } }));
    const { log, lines } = capture();

    await pullWorkflow(stubMcp(remoteWorkflow(withMarker("return [{ json: { remote: 1 } }];\n", { sourcePath: "order-sync/code/compute.ts" }).jsCode)), tmp, "wf1", {}, log);

    assert.equal(lines.filter((l) => l.includes("CONFLICT")).length, 0, `no baseline is not a conflict — got:\n${lines.join("\n")}`);
  });
});
