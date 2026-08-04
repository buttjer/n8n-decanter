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

// --- Plan 64 task 3b: the go-live gate ---------------------------------------
// `publish` scans the draft it ALREADY read, not the repo folder. That choice is
// what these tests pin: the finding must come from the instance, so a stale or
// absent local mirror can neither hide a break nor invent one.
const codeNode = (name: string, jsCode: string) => ({ id: `c-${name}`, name, type: "n8n-nodes-base.code", parameters: { jsCode } });
const setNode = (name: string, value: string) => ({ id: `s-${name}`, name, type: "n8n-nodes-base.set", parameters: { value } });

describe("publishWorkflow — dangling-ref gate", () => {
  it("refuses when the DRAFT carries a dangling ref in Code-node source", async () => {
    const { mcp, calls } = stubMcp(wf({ versionId: "v2", activeVersionId: null, nodes: [codeNode("Transform", "return $('Fetch').all();")] as any }));
    const { log } = capturingLog();
    await assert.rejects(() => publishWorkflow(mcp, "wf1", log), /refusing to publish "Demo" — 1 dangling/);
    assert.deepEqual(calls, [], "nothing may go live");
  });

  it("refuses on a dangling ref in another node's expression parameter, and routes it to n8n", async () => {
    const nodes = [codeNode("Keep", "return [];"), setNode("Label", "={{ $('Fetch').first().json.x }}")];
    const { mcp, calls } = stubMcp(wf({ versionId: "v2", activeVersionId: null, nodes: nodes as any }));
    const { log } = capturingLog();
    await assert.rejects(() => publishWorkflow(mcp, "wf1", log), (err: Error) => {
      assert.match(err.message, /expression parameters \(structure — fix in n8n, not in workflow\.json\)/);
      assert.match(err.message, /node "Label" references \$\('Fetch'\)/);
      assert.match(err.message, /n8n-decanter test wf1/);
      return true;
    });
    assert.deepEqual(calls, []);
  });

  it("orders the two halves parameters-first — the order that does not lose the code edit", async () => {
    const nodes = [codeNode("Transform", "return $('Fetch').all();"), setNode("Label", "={{ $('Fetch').first().json.x }}")];
    const { mcp } = stubMcp(wf({ versionId: "v2", activeVersionId: null, nodes: nodes as any }));
    const { log } = capturingLog();
    await assert.rejects(() => publishWorkflow(mcp, "wf1", log), (err: Error) => {
      assert.ok(err.message.indexOf("expression parameters") < err.message.indexOf("Code-node source"), "parameters must be listed first");
      assert.match(err.message, /fix the expression parameters FIRST/);
      return true;
    });
  });

  it("publishes a clean draft — a resolvable ref is not a finding", async () => {
    const nodes = [codeNode("Fetch", "return [];"), codeNode("Transform", "return $('Fetch').all();")];
    const { mcp, calls } = stubMcp(wf({ versionId: "v2", activeVersionId: null, nodes: nodes as any }));
    const { log } = capturingLog();
    await publishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, ["publish"]);
  });

  it("ignores a //@file: placeholder — locally that is not the source", async () => {
    // The gate reads the instance, where jsCode is inline. A placeholder can
    // only reach it via a hand-mangled draft; it must not be scanned as code.
    const { mcp, calls } = stubMcp(wf({ versionId: "v2", activeVersionId: null, nodes: [codeNode("Transform", "//@file:code/transform.js")] as any }));
    const { log } = capturingLog();
    await publishWorkflow(mcp, "wf1", log);
    assert.deepEqual(calls, ["publish"]);
  });
});
