// Unit tests for the lifecycle branch logic (lib/lifecycle.mts, Plan 32):
// publish/unpublish ride a stubbed McpClient — no HTTP server, no fs
// watchers. (The other lifecycle verbs are gone: the REST delete/duplicate
// died in Plan 33, and create/archive/rename retired with the structure-verb
// removal — those acts go through n8n's MCP, `pull` reconciles.)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishWorkflow, unpublishWorkflow } from "../../lib/lifecycle.mts";
import type { McpClient } from "../../lib/mcp.mts";
import type { Log, Workflow } from "../../lib/types.mts";

const wf = (over: Partial<Workflow> = {}): Workflow => ({ id: "wf1", name: "Demo", nodes: [], connections: {}, ...over });

/** A stub McpClient that serves one workflow and records lifecycle tool calls. */
function stubMcp(remote: Workflow) {
  const calls: string[] = [];
  const mcp = {
    callTool: async (name: string, _args: any) => {
      if (name === "get_workflow_details") return { workflow: structuredClone(remote) };
      if (name === "publish_workflow") {
        calls.push("publish");
        remote.active = true;
        remote.activeVersionId = remote.versionId;
        return { success: true, workflowId: remote.id, activeVersionId: remote.activeVersionId };
      }
      if (name === "unpublish_workflow") {
        calls.push("unpublish");
        remote.active = false;
        remote.activeVersionId = null;
        return { success: true, workflowId: remote.id };
      }
      throw new Error("unexpected tool " + name);
    },
  } as unknown as McpClient;
  return { mcp, calls };
}

function capturingLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
}

describe("publishWorkflow", () => {
  it("publishes an unpublished workflow and reports it live", async () => {
    const { mcp, calls } = stubMcp(wf({ active: false, versionId: "v2", activeVersionId: null }));
    const { log, lines } = capturingLog();
    await publishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, ["publish"]);
    assert.match(lines.join("\n"), /^ok published "Demo" \(wf1\) — code is live now/m);
  });
  it("is a no-op-with-a-note when the live version already equals the draft", async () => {
    const { mcp, calls } = stubMcp(wf({ active: true, versionId: "v2", activeVersionId: "v2" }));
    const { log, lines } = capturingLog();
    await publishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, [], "must not re-publish");
    assert.match(lines.join("\n"), /is already published/);
  });
  it("publishes a DIVERGED draft on a published workflow (pushes are draft-only now)", async () => {
    const { mcp, calls } = stubMcp(wf({ active: true, versionId: "v3", activeVersionId: "v2" }));
    const { log, lines } = capturingLog();
    await publishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, ["publish"], "a lagging live version must be re-published");
    assert.match(lines.join("\n"), /published "Demo"/);
  });
});

describe("unpublishWorkflow", () => {
  it("unpublishes a published workflow", async () => {
    const { mcp, calls } = stubMcp(wf({ active: true, versionId: "v1", activeVersionId: "v1" }));
    const { log, lines } = capturingLog();
    await unpublishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, ["unpublish"]);
    assert.match(lines.join("\n"), /^ok unpublished "Demo" \(wf1\) — draft only/m);
  });
  it("is a no-op-with-a-note on an already-unpublished workflow", async () => {
    const { mcp, calls } = stubMcp(wf({ active: false }));
    const { log, lines } = capturingLog();
    await unpublishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, []);
    assert.match(lines.join("\n"), /is already unpublished/);
  });
});
