// Unit tests for the lifecycle branch logic (lib/lifecycle.mts, Plan 32):
// publish/unpublish/create ride a stubbed McpClient, delete a stubbed N8nApi,
// duplicate both — no HTTP server, no fs watchers.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { N8nApi } from "../../lib/api.mts";
import { createWorkflow, deleteWorkflow, duplicateWorkflow, publishWorkflow, unpublishWorkflow } from "../../lib/lifecycle.mts";
import { McpToolError, type McpClient } from "../../lib/mcp.mts";
import type { DecanterConfig, Log, Workflow, WorkflowPut } from "../../lib/types.mts";

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

const baseConfig = (root: string, workflows: string[] = []): DecanterConfig => ({
  configDir: root, root, workflows, commitOnPush: false, commitOnPull: false,
  browserReload: "off", proxyPort: 0, requestTimeoutMs: 30_000, dataTables: true, host: "http://x", apiKey: "k",
});

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

describe("createWorkflow", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("creates via SDK code over MCP and pulls the newborn (auto-available)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-create-"));
    let sentCode: string | undefined;
    const created = wf({ id: "new1", name: "Fresh Flow", active: false, versionId: "v1", activeVersionId: null, settings: {} });
    const mcp = {
      callTool: async (name: string, args: any) => {
        if (name === "create_workflow_from_code") {
          sentCode = args.code;
          return { workflowId: "new1", name: "Fresh Flow", warnings: [] };
        }
        if (name === "get_workflow_details") return { workflow: structuredClone(created) };
        throw new Error("unexpected tool " + name);
      },
    } as unknown as McpClient;
    const { log, lines } = capturingLog();
    const { id } = await createWorkflow(mcp, baseConfig(tmp), "Fresh Flow", log);
    assert.equal(id, "new1");
    assert.equal(sentCode, 'workflow("fresh-flow", "Fresh Flow")', "minimal SDK expression, kebab slug");
    assert.match(lines.join("\n"), /created "Fresh Flow" \(new1\) on the server — unpublished draft/);
    assert.equal(JSON.parse(readFileSync(path.join(tmp, "fresh-flow", ".decanter.json"), "utf8")).workflowId, "new1");
  });
});

describe("deleteWorkflow", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const withTmp = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-lc-")));

  /** A stub N8nApi that records delete calls. */
  function stubApi(remote: Workflow) {
    const calls: string[] = [];
    const api = {
      getWorkflow: async () => remote,
      deleteWorkflow: async () => {
        calls.push("delete");
        return remote;
      },
    } as unknown as N8nApi;
    return { api, calls };
  }

  it("deletes with --force without prompting", async () => {
    const { api, calls } = stubApi(wf({ active: true }));
    const { log, lines } = capturingLog();
    await deleteWorkflow(api, baseConfig(withTmp()), "wf1", { force: true }, log);
    assert.deepEqual(calls, ["delete"]);
    assert.match(lines.join("\n"), /deleted "Demo" \(wf1\) from the server/);
  });

  it("refuses non-interactively without --force and never calls the API", async () => {
    const { api, calls } = stubApi(wf());
    const { log } = capturingLog();
    const wasTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await assert.rejects(
        deleteWorkflow(api, baseConfig(withTmp()), "wf1", { force: false }, log),
        /refusing to delete "Demo" \(wf1\) without confirmation/,
      );
    } finally {
      process.stdin.isTTY = wasTty;
    }
    assert.deepEqual(calls, [], "must not delete without consent");
  });

  it("flags a stale decanter.config.json workflows entry after deleting", async () => {
    const { api } = stubApi(wf());
    const { log, lines } = capturingLog();
    await deleteWorkflow(api, baseConfig(withTmp(), ["wf1"]), "wf1", { force: true }, log);
    assert.match(lines.join("\n"), /wf1 is still listed in decanter\.config\.json "workflows"/);
  });
});

describe("duplicateWorkflow", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  /** A pulled source folder with one JS Code node behind a placeholder. */
  function seedSource(root: string): void {
    const dir = path.join(root, "Source");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    writeFileSync(path.join(dir, "code", "transform.js"), "return $input.all();\n");
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "src1", nodes: { n1: { file: "code/transform.js" } } }));
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({
      id: "src1", name: "Source",
      nodes: [{ id: "n1", name: "Transform", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { jsCode: "//@file:code/transform.js" } }],
      connections: {},
    }, null, 2));
  }

  /** REST stub whose createWorkflow records the POSTed body; MCP stub serves the clone (or the gate). */
  function stubDup({ available = true }: { available?: boolean } = {}) {
    let posted: WorkflowPut | undefined;
    let createdId = "clone1";
    const api = {
      createWorkflow: async (body: WorkflowPut) => {
        posted = body;
        return { id: createdId, name: body.name, active: false, nodes: body.nodes, connections: body.connections, settings: body.settings, versionId: "v1" };
      },
    } as unknown as N8nApi;
    const mcp = {
      callTool: async (name: string) => {
        if (name === "get_workflow_details") {
          if (!available) throw new McpToolError("get_workflow_details", "Workflow is not available in MCP. Enable MCP access from the workflow card in the workflows list, or from the workflow settings.");
          return { workflow: { id: createdId, name: posted!.name, active: false, nodes: structuredClone(posted!.nodes), connections: posted!.connections, settings: posted!.settings, versionId: "v1" } };
        }
        throw new Error("unexpected tool " + name);
      },
    } as unknown as McpClient;
    return { api, mcp, body: () => posted, setId: (id: string) => (createdId = id) };
  }

  it("posts the source's assembled body under a new name and pulls the clone (when MCP-available)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api, mcp, body } = stubDup();
    const { log, lines } = capturingLog();
    const { id } = await duplicateWorkflow(api, mcp, baseConfig(tmp), "src1", "My Clone", log);
    assert.equal(id, "clone1");
    // POSTed body carries the reconstituted code (placeholder replaced) under the new name
    assert.equal(body()!.name, "My Clone");
    assert.equal(body()!.nodes[0].parameters.jsCode, "return $input.all();\n");
    assert.match(lines.join("\n"), /duplicated "Source" -> "My Clone" \(clone1\) on the server — unpublished draft/);
    // pulled into its own folder
    assert.equal(JSON.parse(readFileSync(path.join(tmp!, "my-clone", ".decanter.json"), "utf8")).workflowId, "clone1");
    // source folder untouched
    assert.equal(JSON.parse(readFileSync(path.join(tmp!, "Source", "workflow.json"), "utf8")).name, "Source");
  });

  it("turns the not-available refusal into guidance instead of an error (API-born clones are gated)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api, mcp } = stubDup({ available: false });
    const { log, lines } = capturingLog();
    const { dir, id } = await duplicateWorkflow(api, mcp, baseConfig(tmp), "src1", "Gated Clone", log);
    assert.equal(id, "clone1", "the clone exists — only the pull is gated");
    assert.equal(dir, null, "no folder while gated");
    assert.match(lines.join("\n"), /not yet available in MCP/);
    assert.match(lines.join("\n"), /n8n-decanter pull clone1/);
    assert.ok(!existsSync(path.join(tmp!, "gated-clone")), "no folder created");
  });

  it("defaults the name to \"<name> (copy)\" when none is given", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api, mcp, body, setId } = stubDup();
    setId("clone2");
    const { log } = capturingLog();
    await duplicateWorkflow(api, mcp, baseConfig(tmp), "src1", undefined, log);
    assert.equal(body()!.name, "Source (copy)");
  });

  it("throws for an unknown workflow id", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api, mcp } = stubDup();
    const { log } = capturingLog();
    await assert.rejects(duplicateWorkflow(api, mcp, baseConfig(tmp), "nope", "X", log), /workflow nope not found/);
  });
});
