// Unit tests for the publish/unpublish/delete branch logic (lib/lifecycle.mts),
// with a stubbed N8nApi and a capturing log — no HTTP server, no fs watchers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { N8nApi } from "../../lib/api.mts";
import { deleteWorkflow, duplicateWorkflow, publishWorkflow, unpublishWorkflow } from "../../lib/lifecycle.mts";
import type { DecanterConfig, Log, Workflow, WorkflowPut } from "../../lib/types.mts";

const wf = (over: Partial<Workflow> = {}): Workflow => ({ id: "wf1", name: "Demo", nodes: [], connections: {}, ...over });

/** A stub N8nApi that records which lifecycle calls fired. */
function stubApi(remote: Workflow) {
  const calls: string[] = [];
  const api = {
    getWorkflow: async () => remote,
    activateWorkflow: async () => {
      calls.push("activate");
      return { ...remote, active: true };
    },
    deactivateWorkflow: async () => {
      calls.push("deactivate");
      return { ...remote, active: false };
    },
    deleteWorkflow: async () => {
      calls.push("delete");
      return remote;
    },
  } as unknown as N8nApi;
  return { api, calls };
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
  it("activates an unpublished workflow and reports it live", async () => {
    const { api, calls } = stubApi(wf({ active: false }));
    const { log, lines } = capturingLog();
    await publishWorkflow(api, "wf1", log);
    assert.deepEqual(calls, ["activate"]);
    assert.match(lines.join("\n"), /^ok published "Demo" \(wf1\) — code is live now/m);
  });
  it("is a no-op-with-a-note on an already-published workflow", async () => {
    const { api, calls } = stubApi(wf({ active: true }));
    const { log, lines } = capturingLog();
    await publishWorkflow(api, "wf1", log);
    assert.deepEqual(calls, [], "must not re-activate");
    assert.match(lines.join("\n"), /is already published/);
  });
});

describe("unpublishWorkflow", () => {
  it("deactivates a published workflow", async () => {
    const { api, calls } = stubApi(wf({ active: true }));
    const { log, lines } = capturingLog();
    await unpublishWorkflow(api, "wf1", log);
    assert.deepEqual(calls, ["deactivate"]);
    assert.match(lines.join("\n"), /^ok unpublished "Demo" \(wf1\) — draft only/m);
  });
  it("is a no-op-with-a-note on an already-unpublished workflow", async () => {
    const { api, calls } = stubApi(wf({ active: false }));
    const { log, lines } = capturingLog();
    await unpublishWorkflow(api, "wf1", log);
    assert.deepEqual(calls, []);
    assert.match(lines.join("\n"), /is already unpublished/);
  });
});

describe("deleteWorkflow", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const withTmp = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-lc-")));

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

  /** Stub whose createWorkflow records the POSTed body and getWorkflow serves the clone. */
  function stubDup() {
    let posted: WorkflowPut | undefined;
    let createdId = "clone1";
    const api = {
      createWorkflow: async (body: WorkflowPut) => {
        posted = body;
        return { id: createdId, name: body.name, active: false, nodes: body.nodes, connections: body.connections, settings: body.settings, versionId: "v1" };
      },
      getWorkflow: async (id: string) => ({ id, name: posted!.name, active: false, nodes: posted!.nodes, connections: posted!.connections, settings: posted!.settings, versionId: "v1" }),
    } as unknown as N8nApi;
    return { api, body: () => posted, setId: (id: string) => (createdId = id) };
  }

  it("posts the source's assembled body under a new name and pulls the clone", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api, body } = stubDup();
    const { log, lines } = capturingLog();
    const { id } = await duplicateWorkflow(api, baseConfig(tmp), "src1", "My Clone", log);
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

  it("defaults the name to \"<name> (copy)\" when none is given", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api, body, setId } = stubDup();
    setId("clone2");
    const { log } = capturingLog();
    await duplicateWorkflow(api, baseConfig(tmp), "src1", undefined, log);
    assert.equal(body()!.name, "Source (copy)");
  });

  it("throws for an unknown workflow id", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-dup-"));
    seedSource(tmp);
    const { api } = stubDup();
    const { log } = capturingLog();
    await assert.rejects(duplicateWorkflow(api, baseConfig(tmp), "nope", "X", log), /workflow nope not found/);
  });
});
