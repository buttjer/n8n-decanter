// Regression tests for `pull`'s per-node reporting (lib/pull.mts). Pull runs
// its own copy of the parity/drift ladder for TS-managed nodes, and it carried
// the same hole as the read-side ladder in lib/status.mts: an absent baseline
// fell through every comparison into "CONFLICT".
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { compileNode } from "../../lib/compile.mts";
import type { McpClient } from "../../lib/mcp.mts";
import { pullWorkflow } from "../../lib/pull.mts";
import type { Log, Workflow } from "../../lib/types.mts";
import { sha256, splitMarker, withMarker } from "../../lib/util.mts";

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

// Plan 24: a `.js` node with a top-level import is bundled on push (line-1
// marker whose path ends `.js`). Pull must keep that `.js` as the source —
// never re-point it at a `.ts`, never overwrite it with the bundle — and must
// not undo a conversion that was re-pointed but not yet pushed.
const HELPER_JS = "export function cents(n) {\n  return Math.round(n * 100);\n}\n";
const IMPORTING_JS = 'import { cents } from "../../shared/money";\n\nreturn [{ json: { total: cents(1.5) } }];\n';

/** Tagged capture: pull's `capture()` above drops the level, these tests need it. */
function tagged(): { log: Log; lines: string[]; warns: () => string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return {
    lines,
    warns: () => lines.filter((l) => l.startsWith("warn ")),
    log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") },
  };
}

/**
 * A sync dir (decanter.config.json at the root, so bundling finds it) with
 * `shared/money.js` and the Order Sync folder. `file`/`source` seed the tracked
 * node file (omit `source` to leave it absent); `placeholder` is what
 * workflow.json's `//@file:` says — it wins over the state's `file`, exactly as
 * a re-pointed conversion does.
 */
function seed(root: string, opts: { file: string; source?: string; lastPushedHash?: string; placeholder?: string }): string {
  writeFileSync(path.join(root, "decanter.config.json"), JSON.stringify({ root: "." }));
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "shared", "money.js"), HELPER_JS);
  const dir = path.join(root, "order-sync");
  mkdirSync(path.join(dir, "code"), { recursive: true });
  if (opts.source !== undefined) writeFileSync(path.join(dir, opts.file), opts.source);
  const node: Record<string, string> = { file: opts.file, name: "Compute" };
  if (opts.lastPushedHash !== undefined) node.lastPushedHash = opts.lastPushedHash;
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "wf1", name: "Order Sync", nodes: { c: node } }));
  const snapshot = remoteWorkflow("//@file:" + (opts.placeholder ?? opts.file));
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(snapshot, null, 2));
  return dir;
}

const readState = (dir: string) => JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8"));
const placeholderOf = (dir: string): string =>
  JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8")).nodes.find((n: { id: string }) => n.id === "c").parameters.jsCode;

/** What a push of the importing `.js` put on the remote: the bundle behind a `.js`-path line-1 marker. */
async function bundledRemote(dir: string, file: string, sourcePath = "order-sync/" + file): Promise<{ jsCode: string; body: string }> {
  const { jsCode } = withMarker(await compileNode(path.join(dir, file)), { sourcePath });
  return { jsCode, body: splitMarker(jsCode).body };
}

describe("pullWorkflow — bundled .js nodes (Plan 24)", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const root = () => (tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-pull-js-")));

  it("a .js-path marker with a matching local importing .js stays .js, untouched and in sync", async () => {
    const r = root();
    const dir = seed(r, { file: "code/compute.js", source: IMPORTING_JS });
    const remote = await bundledRemote(dir, "code/compute.js");
    const state = readState(dir);
    state.nodes.c.lastPushedHash = sha256(remote.body);
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state));
    const { log, lines, warns } = tagged();

    const result = await pullWorkflow(stubMcp(remoteWorkflow(remote.jsCode)), r, "wf1", {}, log);

    assert.equal(readFileSync(path.join(dir, "code", "compute.js"), "utf8"), IMPORTING_JS, "source untouched");
    assert.equal(existsSync(path.join(dir, "code", "compute.ts")), false, "no .ts created");
    assert.deepEqual(warns(), [], `in sync — no warning; got:\n${lines.join("\n")}`);
    assert.doesNotMatch(lines.join("\n"), /modified, not yet pushed/);
    assert.deepEqual(result.clobbered, []);
    assert.equal(readState(dir).nodes.c.file, "code/compute.js");
    assert.equal(placeholderOf(dir), "//@file:code/compute.js");
  });

  it("clobber guard: a markerless remote never overwrites a local .js that imports shared code", async () => {
    const r = root();
    const dir = seed(r, { file: "code/compute.js", source: IMPORTING_JS, lastPushedHash: sha256("return [];\n") });
    const remoteBody = "return [{ json: { remote: 1 } }];\n";
    const { log, lines, warns } = tagged();

    const result = await pullWorkflow(stubMcp(remoteWorkflow(remoteBody)), r, "wf1", {}, log);

    assert.equal(readFileSync(path.join(dir, "code", "compute.js"), "utf8"), IMPORTING_JS, "kept byte-for-byte");
    assert.equal(warns().filter((l) => /imports shared code but the remote code is not a decanter bundle/.test(l)).length, 1, `got:\n${lines.join("\n")}`);
    assert.doesNotMatch(lines.join("\n"), /overwriting unpushed local changes/);
    assert.deepEqual(result.clobbered, [], "not reported as clobbered");
    const ns = readState(dir).nodes.c;
    assert.equal(ns.lastPushedHash, sha256(remoteBody), "re-baselined on the remote body");
    assert.equal(ns.file, "code/compute.js");
    assert.equal(placeholderOf(dir), "//@file:code/compute.js");
  });

  it("clobber guard without a state entry: an importing .js written before the first push survives a markerless pull (Plan 63 shape)", async () => {
    const r = root();
    const dir = seed(r, { file: "code/compute.js", source: IMPORTING_JS });
    // the agent added node c over MCP and wrote its source; nothing tracks it yet
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify({ workflowId: "wf1", name: "Order Sync", nodes: {} }));
    const snapshot = remoteWorkflow("");
    snapshot.nodes = snapshot.nodes.filter((n) => n.id !== "c");
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(snapshot, null, 2));
    const remoteBody = ""; // the guard blocks jsCode in addNode, so the remote body is empty
    const { log, lines, warns } = tagged();

    const result = await pullWorkflow(stubMcp(remoteWorkflow(remoteBody)), r, "wf1", {}, log);

    assert.equal(readFileSync(path.join(dir, "code", "compute.js"), "utf8"), IMPORTING_JS, "kept byte-for-byte");
    assert.equal(warns().filter((l) => /imports shared code but the remote code is not a decanter bundle/.test(l)).length, 1, `got:\n${lines.join("\n")}`);
    assert.deepEqual(result.clobbered, [], "not reported as clobbered");
  });

  it("a .js-path marker with no local file warns and writes nothing", async () => {
    const r = root();
    const dir = seed(r, { file: "code/compute.js" });
    const { jsCode } = withMarker("return [{ json: { total: 150 } }];\n", { sourcePath: "order-sync/code/compute.js" });
    const { log, lines, warns } = tagged();

    await pullWorkflow(stubMcp(remoteWorkflow(jsCode)), r, "wf1", {}, log);

    assert.equal(warns().filter((l) => /managed on remote but no local code\/.+\.js/.test(l)).length, 1, `got:\n${lines.join("\n")}`);
    assert.equal(existsSync(path.join(dir, "code", "compute.js")), false, "no .js written");
    assert.equal(existsSync(path.join(dir, "code", "compute.ts")), false, "no .ts written");
  });

  it("an import removed locally but not pushed reads \"modified, not yet pushed\" and keeps the file", async () => {
    const r = root();
    const dir = seed(r, { file: "code/compute.js", source: IMPORTING_JS });
    const remote = await bundledRemote(dir, "code/compute.js");
    const state = readState(dir);
    state.nodes.c.lastPushedHash = sha256(remote.body);
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state));
    const edited = "return [{ json: { total: 150 } }];\n";
    writeFileSync(path.join(dir, "code", "compute.js"), edited);
    const { log, lines, warns } = tagged();

    const result = await pullWorkflow(stubMcp(remoteWorkflow(remote.jsCode)), r, "wf1", {}, log);

    assert.match(lines.join("\n"), /local code\/compute\.js modified, not yet pushed/);
    assert.deepEqual(warns(), [], `got:\n${lines.join("\n")}`);
    assert.equal(readFileSync(path.join(dir, "code", "compute.js"), "utf8"), edited, "file kept");
    assert.deepEqual(result.clobbered, []);
    assert.equal(readState(dir).nodes.c.file, "code/compute.js");
  });

  it("a .ts → .js conversion re-pointed but not pushed keeps the .js (remote marker still says .ts)", async () => {
    const r = root();
    const plain = "return [{ json: { total: 150 } }];\n";
    // state still says .ts; the placeholder was re-pointed to the .js, the .ts deleted
    const dir = seed(r, { file: "code/compute.ts", placeholder: "code/compute.js" });
    writeFileSync(path.join(dir, "code", "compute.js"), plain);
    const { jsCode, hash } = withMarker("var a = 1;\nreturn [{ json: { a } }];\n", { sourcePath: "order-sync/code/compute.ts" });
    const state = readState(dir);
    state.nodes.c.lastPushedHash = hash;
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state));
    const { log, lines } = tagged();

    await pullWorkflow(stubMcp(remoteWorkflow(jsCode)), r, "wf1", {}, log);

    assert.equal(readState(dir).nodes.c.file, "code/compute.js", "state stays on the existing .js");
    assert.equal(placeholderOf(dir), "//@file:code/compute.js", "placeholder stays on the existing .js");
    assert.doesNotMatch(lines.join("\n"), /managed on remote but no local/, `got:\n${lines.join("\n")}`);
    assert.equal(readFileSync(path.join(dir, "code", "compute.js"), "utf8"), plain, ".js untouched");
    assert.equal(existsSync(path.join(dir, "code", "compute.ts")), false, "no .ts resurrected");
  });

  it("the mirror case: a .js-path marker with an existing tracked .ts stays .ts", async () => {
    const r = root();
    const src = "const a: number = 1;\nreturn [{ json: { a } }];\n";
    const dir = seed(r, { file: "code/compute.ts", source: src });
    const { jsCode, hash } = withMarker("var b = 2;\nreturn [{ json: { b } }];\n", { sourcePath: "order-sync/code/compute.js" });
    const state = readState(dir);
    state.nodes.c.lastPushedHash = hash;
    writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state));
    const { log, lines } = tagged();

    await pullWorkflow(stubMcp(remoteWorkflow(jsCode)), r, "wf1", {}, log);

    assert.equal(readState(dir).nodes.c.file, "code/compute.ts", "state stays on the existing .ts");
    assert.equal(placeholderOf(dir), "//@file:code/compute.ts");
    assert.doesNotMatch(lines.join("\n"), /managed on remote but no local/, `got:\n${lines.join("\n")}`);
    assert.equal(readFileSync(path.join(dir, "code", "compute.ts"), "utf8"), src, ".ts untouched");
    assert.equal(existsSync(path.join(dir, "code", "compute.js")), false, "no .js written");
  });
});
