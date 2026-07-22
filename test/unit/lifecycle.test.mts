// Unit tests for the lifecycle branch logic (lib/lifecycle.mts, Plans 32/33):
// publish/unpublish/create/archive all ride a stubbed McpClient — no HTTP
// server, no fs watchers. (The REST verbs died in Plan 33: delete became the
// MCP archive verb, duplicate was dropped.)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { archiveWorkflow, createWorkflow, publishWorkflow, unpublishWorkflow } from "../../lib/lifecycle.mts";
import type { McpClient } from "../../lib/mcp.mts";
import type { DecanterConfig, Log, Workflow } from "../../lib/types.mts";

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
      if (name === "archive_workflow") {
        calls.push("archive");
        return { archived: true, workflowId: remote.id, name: remote.name };
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

  it("validates the SDK code, creates over MCP, and pulls the newborn (auto-available)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-create-"));
    let validatedCode: string | undefined;
    let sentCode: string | undefined;
    const created = wf({ id: "new1", name: "Fresh Flow", active: false, versionId: "v1", activeVersionId: null, settings: {} });
    const mcp = {
      callTool: async (name: string, args: any) => {
        if (name === "validate_workflow") {
          validatedCode = args.code;
          return { valid: true, nodeCount: 0 };
        }
        if (name === "create_workflow_from_code") {
          assert.equal(validatedCode, args.code, "create must send exactly the validated code");
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

  it("aborts before create_workflow_from_code when validate_workflow rejects, surfacing errors + hint", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-create-"));
    const mcp = {
      callTool: async (name: string) => {
        if (name === "validate_workflow") {
          return { valid: false, errors: ["workflow() needs a name"], hint: "read get_sdk_reference" };
        }
        throw new Error("create must not be reached: " + name);
      },
    } as unknown as McpClient;
    const { log } = capturingLog();
    await assert.rejects(
      createWorkflow(mcp, baseConfig(tmp), "Broken", log),
      /validate_workflow: workflow\(\) needs a name — read get_sdk_reference/,
    );
  });
});

describe("archiveWorkflow", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const withTmp = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-lc-")));

  it("archives with --force without prompting (published workflow notes it went offline)", async () => {
    const { mcp, calls } = stubMcp(wf({ active: true, versionId: "v1", activeVersionId: "v1" }));
    const { log, lines } = capturingLog();
    await archiveWorkflow(mcp, baseConfig(withTmp()), "wf1", { force: true }, log);
    assert.deepEqual(calls, ["archive"]);
    assert.match(lines.join("\n"), /archived "Demo" \(wf1\) — it was published and is now offline — restore or permanently delete it from the n8n UI/);
  });

  it("refuses non-interactively without --force and never calls the tool", async () => {
    const { mcp, calls } = stubMcp(wf());
    const { log } = capturingLog();
    const wasTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await assert.rejects(
        archiveWorkflow(mcp, baseConfig(withTmp()), "wf1", { force: false }, log),
        /refusing to archive "Demo" \(wf1\) without confirmation/,
      );
    } finally {
      process.stdin.isTTY = wasTty;
    }
    assert.deepEqual(calls, [], "must not archive without consent");
  });

  it("flags a stale decanter.config.json workflows entry after archiving", async () => {
    const { mcp } = stubMcp(wf());
    const { log, lines } = capturingLog();
    await archiveWorkflow(mcp, baseConfig(withTmp(), ["wf1"]), "wf1", { force: true }, log);
    assert.match(lines.join("\n"), /wf1 is still listed in decanter\.config\.json "workflows"/);
  });
});
