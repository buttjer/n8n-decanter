// Unit tests for the MCP push path (lib/push.mts, Plan 32): a temp pulled
// folder + a stubbed McpClient (callTool only) — no HTTP server. Covers the
// per-node drift guard (the only guard left), name-addressing by fresh remote
// read, silent re-baselining, and the untracked/deleted node paths.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ForceableError } from "../../lib/errors.mts";
import type { McpClient } from "../../lib/mcp.mts";
import { buildNodeCode, pushSingleNode, pushWorkflow } from "../../lib/push.mts";
import type { Log, Workflow } from "../../lib/types.mts";
import { sha256, splitMarker, withMarker } from "../../lib/util.mts";

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

  // Plan 29: the picker's force-retry offer keys on the TYPE, so the drift
  // guard — the one gate --force bypasses — must be the one throwing it.
  it("marks the drift abort ForceableError; the compliance guard stays a plain Error", async () => {
    const r = root();
    const dir = seedFolder(r);
    const remote = remoteWorkflow();
    remote.nodes[2].parameters.jsCode = CODE_B + "// UI hotfix\n";
    const { mcp } = stubMcp(remote);
    const { log } = capturingLog();
    await assert.rejects(pushWorkflow(mcp, r, "wf1", {}, log), (err: Error) => {
      assert.ok(err instanceof ForceableError, `drift abort must be forceable, got ${err.name}`);
      return true;
    });
    // inline jsCode in the snapshot is a layout violation: --force can't fix it,
    // so it must NOT be forceable
    const snapshot = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8"));
    snapshot.nodes[1].parameters.jsCode = "return [];\n";
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(snapshot, null, 2));
    await assert.rejects(pushWorkflow(mcp, r, "wf1", { force: true }, log), (err: Error) => {
      assert.ok(err instanceof Error && !(err instanceof ForceableError), "compliance failure must not be forceable");
      assert.match(err.message, /does not comply with the decanter layout/);
      return true;
    });
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
    assert.match(lines.join("\n"), /published "Test" \(wf1\) — n8n activates it in the background/);
  });
});

// Plan 24: a `.js` node with a top-level import is bundled on push like a
// `.ts` node (line-1 marker, path ending `.js`); one without stays verbatim.
// The marker reconciliation is keyed on what the BUILD produced, not on the
// file extension, and a push that flips a `.js` node's management says so.
const HELPER_JS = "export function cents(n) {\n  return Math.round(n * 100);\n}\n";
const IMPORTING_JS = 'import { cents } from "../../shared/money";\n\nreturn [{ json: { total: cents(1.5) } }];\n';
const PLAIN_BODY = "return [{ json: { total: 150 } }];\n";
const NOW_IMPORTS = "info Compute: code/compute.js now imports — bundled on push, one-way from here (pull no longer overwrites it)";
const NO_IMPORTS = "info Compute: code/compute.js has no imports any more — pushed verbatim, two-way again";

/**
 * A sync dir (decanter.config.json at `root` — bundling finds its root by it)
 * with `shared/money.js` and one tracked Code node Compute → `code/<file>`.
 */
function seedSyncDir(root: string, file: string, source: string, lastPushedHash: string): string {
  writeFileSync(path.join(root, "decanter.config.json"), JSON.stringify({ root: "." }));
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "shared", "money.js"), HELPER_JS);
  const dir = path.join(root, "test-flow");
  mkdirSync(path.join(dir, "code"), { recursive: true });
  writeFileSync(path.join(dir, file), source);
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({
    workflowId: "wf1", name: "Test",
    nodes: { c: { file, lastPushedHash, name: "Compute" } },
  }, null, 2));
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify({
    id: "wf1", name: "Test",
    nodes: [
      { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
      { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0], parameters: { jsCode: "//@file:" + file } },
    ],
    connections: {},
  }, null, 2));
  return dir;
}

const computeRemote = (jsCode: string): Workflow => ({
  id: "wf1", name: "Test", active: false, versionId: "v1", activeVersionId: null, connections: {}, settings: {},
  nodes: [
    { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
    { id: "c", name: "Compute", type: "n8n-nodes-base.code", parameters: { jsCode } },
  ],
});

/**
 * `stubMcp`, with `afterUpdate` run once per successful `update_workflow` —
 * to simulate a server that normalizes the stored code, or (by throwing
 * before the write) a write that fails.
 */
function stubMcpWith(remote: Workflow, hooks: { beforeUpdate?: () => void; afterUpdate?: () => void }) {
  const stub = stubMcp(remote);
  const inner = stub.mcp.callTool.bind(stub.mcp);
  (stub.mcp as unknown as { callTool: (name: string, args: any) => Promise<unknown> }).callTool = async (name: string, args: any) => {
    if (name === "update_workflow") hooks.beforeUpdate?.();
    const res = await inner(name, args);
    if (name === "update_workflow") hooks.afterUpdate?.();
    return res;
  };
  return stub;
}

/** The compiled body (marker stripped) push would write for `file`. */
async function builtBody(dir: string, file: string): Promise<string> {
  return splitMarker((await buildNodeCode(dir, file)).jsCode).body;
}

describe("pushWorkflow — bundled .js nodes (Plan 24)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const root = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-push-js-")));

  it("buildNodeCode: a .js node without a top-level import stays verbatim, byte-identical", async () => {
    const r = root();
    // import-shaped text that is NOT a static import: a JSDoc type, a comment,
    // a dynamic import() — none of them makes the node managed
    const src = "/** @typedef {import('../../shared/money').Cents} Cents */\n// import { cents } from \"../../shared/money\";\nconst m = await import(\"node:path\").catch(() => null);\nreturn [{ json: { ok: m === null } }];\n";
    const dir = seedSyncDir(r, "code/compute.js", src, sha256(src));
    const built = await buildNodeCode(dir, "code/compute.js");
    assert.equal(built.jsCode, src, "pushed verbatim — no marker, no bundling");
    assert.equal(built.hash, sha256(src));
  });

  it("bundles an importing .js once (line-1 marker ending code/compute.js, helper inlined, flip note); a second push is a no-op", async () => {
    const r = root();
    const dir = seedSyncDir(r, "code/compute.js", IMPORTING_JS, sha256(PLAIN_BODY));
    const remote = computeRemote(PLAIN_BODY);
    const { mcp, updates } = stubMcp(remote);
    const first = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, first.log);
    assert.equal(updates.length, 1, `one update_workflow call — got:\n${first.lines.join("\n")}`);
    assert.equal(updates[0].length, 1);
    const split = splitMarker(updates[0][0].parameters.jsCode);
    assert.equal(split.where, "leading", "line-1 marker");
    assert.match(split.sourcePath ?? "", /(^|\/)code\/compute\.js$/, "marker path keeps the .js extension");
    assert.match(split.body, /Math\.round\(n \* 100\)/, "shared helper inlined");
    assert.doesNotMatch(split.body, /^\s*import\s/m, "no import statement reaches n8n");
    assert.equal(first.lines.filter((l) => l === NOW_IMPORTS).length, 1, `"now imports" flip note once — got:\n${first.lines.join("\n")}`);
    assert.doesNotMatch(first.lines.join("\n"), /does not match/, "round-trip check takes the marker-hash branch");
    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    assert.equal(state.nodes.c.lastPushedHash, sha256(split.body));

    const second = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, second.log);
    assert.equal(updates.length, 1, `second push writes nothing — got:\n${second.lines.join("\n")}`);
    assert.equal(second.lines.filter((l) => l === NOW_IMPORTS).length, 0, "no flip note without an op");
    assert.doesNotMatch(second.lines.join("\n"), /does not match/);
    assert.match(second.lines.join("\n"), /code already in sync — nothing to push/);
  });

  it("a legacy trailing-marker .ts node with an equal body is still a no-op (Plan 84)", async () => {
    const r = root();
    const src = "const a: number = 1;\nreturn [{ json: { a } }];\n";
    const dir = seedSyncDir(r, "code/compute.ts", src, "");
    const body = await builtBody(dir, "code/compute.ts");
    const remote = computeRemote(body + `// @ts-n8n ${sha256(body)}\n`);
    assert.equal(splitMarker(remote.nodes[1].parameters.jsCode!).where, "trailing", "fixture really is the legacy form");
    const { mcp, updates } = stubMcp(remote);
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 0, `relocation alone never forces a write — got:\n${lines.join("\n")}`);
  });

  it("import removed from a bundled .js: one op that clears the marker, and the \"has no imports any more\" note", async () => {
    const r = root();
    // the raw file now equals the remote body byte-for-byte; only the marker differs
    seedSyncDir(r, "code/compute.js", PLAIN_BODY, sha256(PLAIN_BODY));
    const remote = computeRemote(withMarker(PLAIN_BODY, { sourcePath: "test-flow/code/compute.js" }).jsCode);
    const { mcp, updates } = stubMcp(remote);
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].length, 1, "exactly one op");
    assert.equal(updates[0][0].parameters.jsCode, PLAIN_BODY, "pushed verbatim");
    assert.equal(splitMarker(updates[0][0].parameters.jsCode).markerHash, null, "marker cleared");
    assert.equal(lines.filter((l) => l === NO_IMPORTS).length, 1, `"has no imports any more" note once — got:\n${lines.join("\n")}`);
    assert.equal(lines.filter((l) => l === NOW_IMPORTS).length, 0);
  });

  it("remote marker names a .ts path, local is an importing .js with an equal body: one op re-marking it .js, no flip note", async () => {
    const r = root();
    const dir = seedSyncDir(r, "code/compute.js", IMPORTING_JS, "");
    const body = await builtBody(dir, "code/compute.js");
    const remote = computeRemote(withMarker(body, { sourcePath: "test-flow/code/compute.ts" }).jsCode);
    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    state.nodes.c.lastPushedHash = sha256(body);
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state, null, 2));
    const { mcp, updates } = stubMcp(remote);
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 1, `wrong-extension marker forces one write — got:\n${lines.join("\n")}`);
    assert.equal(updates[0].length, 1);
    const split = splitMarker(updates[0][0].parameters.jsCode);
    assert.equal(split.body, body, "body unchanged");
    assert.match(split.sourcePath ?? "", /(^|\/)code\/compute\.js$/, "marker path now ends .js");
    assert.doesNotMatch(lines.join("\n"), /now imports|has no imports any more/, "no flip note for a wrong extension");
  });

  it("a .ts → plain .js conversion clears the marker without a \"has no imports any more\" note", async () => {
    const r = root();
    seedSyncDir(r, "code/compute.js", PLAIN_BODY, sha256(PLAIN_BODY));
    const remote = computeRemote(withMarker(PLAIN_BODY, { sourcePath: "test-flow/code/compute.ts" }).jsCode);
    const { mcp, updates } = stubMcp(remote);
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].length, 1, "one op");
    assert.equal(updates[0][0].parameters.jsCode, PLAIN_BODY, "marker cleared, raw bytes pushed");
    assert.doesNotMatch(lines.join("\n"), /now imports|has no imports any more/, "that file never imported — no flip note");
  });

  it("round-trip check on a bundled .js: a server-normalized body warns against the marker hash, never \"byte-exactly\"", async () => {
    const r = root();
    seedSyncDir(r, "code/compute.js", IMPORTING_JS, sha256(PLAIN_BODY));
    const remote = computeRemote(PLAIN_BODY);
    // the server "normalizes" the stored code after the write: one extra newline
    const { mcp, updates } = stubMcpWith(remote, { afterUpdate: () => { remote.nodes[1].parameters.jsCode += "\n"; } });
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 1, `got:\n${lines.join("\n")}`);
    assert.equal(lines.filter((l) => /^warn node "Compute": remote code does not match its @ts-n8n marker hash after push/.test(l)).length, 1, `marker-hash branch warns — got:\n${lines.join("\n")}`);
    assert.doesNotMatch(lines.join("\n"), /byte-exactly/, "a bundled .js is never byte-compared against its source");
  });

  it("flip notes print only after the write succeeded: a failed update_workflow prints no \"now imports\"", async () => {
    const r = root();
    seedSyncDir(r, "code/compute.js", IMPORTING_JS, sha256(PLAIN_BODY));
    const { mcp } = stubMcpWith(computeRemote(PLAIN_BODY), { beforeUpdate: () => { throw new Error("update_workflow exploded"); } });
    const { log, lines } = capturingLog();
    await assert.rejects(pushWorkflow(mcp, r, "wf1", {}, log), /update_workflow exploded/);
    assert.equal(lines.filter((l) => l === NOW_IMPORTS).length, 0, `no note for a write that never landed — got:\n${lines.join("\n")}`);
  });

  it("pushSingleNode (watch save) prints the \"now imports\" note once for a .js that just gained an import", async () => {
    const r = root();
    const dir = seedSyncDir(r, "code/compute.js", IMPORTING_JS, sha256(PLAIN_BODY));
    const { mcp, updates } = stubMcp(computeRemote(PLAIN_BODY));
    const { log, lines } = capturingLog();
    await pushSingleNode(mcp, dir, "c", {}, log);
    assert.equal(updates.length, 1, `got:\n${lines.join("\n")}`);
    assert.match(splitMarker(updates[0][0].parameters.jsCode).sourcePath ?? "", /(^|\/)code\/compute\.js$/);
    assert.equal(lines.filter((l) => l === NOW_IMPORTS).length, 1, `got:\n${lines.join("\n")}`);
  });

  it("a .ts node gaining its first marker (missingMarker) prints no flip note", async () => {
    const r = root();
    const src = "const a: number = 1;\nreturn [{ json: { a } }];\n";
    const dir = seedSyncDir(r, "code/compute.ts", src, "");
    const body = await builtBody(dir, "code/compute.ts");
    const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
    state.nodes.c.lastPushedHash = sha256(body);
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state, null, 2));
    // markerless remote with the compiled body: only the marker is missing
    const { mcp, updates } = stubMcp(computeRemote(body));
    const { log, lines } = capturingLog();
    await pushWorkflow(mcp, r, "wf1", {}, log);
    assert.equal(updates.length, 1, "the marker write still happens");
    assert.equal(splitMarker(updates[0][0].parameters.jsCode).where, "leading");
    assert.doesNotMatch(lines.join("\n"), /now imports|has no imports any more/, "flip notes are for .js files only");
  });
});
