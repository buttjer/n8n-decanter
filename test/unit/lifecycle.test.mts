// Unit tests for the publish/unpublish/delete branch logic (lib/lifecycle.mts),
// with a stubbed N8nApi and a capturing log — no HTTP server, no fs watchers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { N8nApi } from "../../lib/api.mts";
import { deleteWorkflow, publishWorkflow, unpublishWorkflow } from "../../lib/lifecycle.mts";
import type { DecanterConfig, Log, Workflow } from "../../lib/types.mts";

const wf = (over: Partial<Workflow> = {}): Workflow => ({ id: "wf1", name: "Demo", nodes: [], connections: {}, ...over });

/** A stub N8nApi that records which lifecycle calls fired. */
function stubApi(remote: Workflow) {
  const calls: string[] = [];
  const api = {
    getWorkflow: async () => remote,
    activateWorkflow: async () => (calls.push("activate"), { ...remote, active: true }),
    deactivateWorkflow: async () => (calls.push("deactivate"), { ...remote, active: false }),
    deleteWorkflow: async () => (calls.push("delete"), remote),
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
  browserReload: "off", proxyPort: 0, requestTimeoutMs: 30_000, host: "http://x", apiKey: "k",
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
