// Regression tests for the per-node sync ladder (lib/status.mts) — the facts
// `diff` renders and `preflight` scores. Both bugs below were reported from a
// real 0.10.0 project mid `.js`→`.ts` conversion: the ladder manufactured a
// CONFLICT out of state `push` itself considers pushable, and it judged the
// conversion against a file map `push`/`pull` had already moved on from.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeSyncFacts } from "../../lib/status.mts";
import type { DecanterState, Workflow } from "../../lib/types.mts";
import { sha256 } from "../../lib/util.mts";

const remoteWorkflow = (jsCode: string): Workflow => ({
  id: "wf1", name: "Order Sync", connections: {}, active: false, versionId: "v1", activeVersionId: null,
  nodes: [
    { id: "h", name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: {} },
    { id: "c", name: "Compute", type: "n8n-nodes-base.code", typeVersion: 2, position: [200, 0], parameters: { jsCode } },
  ],
});

/** A pulled workflow folder: state + snapshot + whichever node files are given. */
function seed(root: string, state: DecanterState, files: Record<string, string>, placeholder: string): string {
  const dir = path.join(root, "order-sync");
  mkdirSync(path.join(dir, "code"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dir, rel), body);
  writeFileSync(path.join(dir, ".decanter.json"), JSON.stringify(state, null, 2));
  const snapshot = remoteWorkflow(`//@file:${placeholder}`);
  writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(snapshot, null, 2));
  return dir;
}

describe("computeSyncFacts — the parity/drift ladder", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  // push's `codeDrift` (lib/push.mts) relaxes drift when there is no baseline:
  // "a first sync for that node has nothing to protect". The reporting ladder
  // did not, so `diff` said CONFLICT and `preflight` failed its drift gate on
  // state that `push` accepts WITHOUT `--force` — and `--force` is exactly what
  // the scaffolded agent permissions deny. The two must agree.
  it("does not manufacture a CONFLICT when the node has no baseline hash", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-status-"));
    const dir = seed(
      tmp,
      { workflowId: "wf1", name: "Order Sync", nodes: { c: { file: "code/compute.js", name: "Compute" } } },
      { "code/compute.js": "return [{json:{local:1}}];\n" },
      "code/compute.js",
    );
    const facts = await computeSyncFacts(remoteWorkflow("return [{json:{remote:1}}];\n"), dir);
    const node = facts.nodes.find((n) => n.id === "c")!;
    assert.notEqual(node.state, "conflict", "no baseline means nothing is known to have moved remotely — push treats it as pushable, so the ladder must not call it a conflict");
  });

  // The `//@file:` placeholder is the sanctioned way to re-point a node's source
  // file (a `.js`→`.ts` conversion). push and pull both adopt it via
  // `reconcileFileMapFromSnapshot` before doing anything; the read side did not,
  // so it looked up the deleted `.js` and reported "local file … missing" —
  // reading as data loss for a conversion that push completes happily.
  it("honors a re-pointed //@file: placeholder (.js → .ts conversion)", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "decanter-status-"));
    const remoteBody = "const t = { cs: { x: 1 } };\nreturn [{ json: { t } }];\n";
    const dir = seed(
      tmp,
      { workflowId: "wf1", name: "Order Sync", nodes: { c: { file: "code/compute.js", lastPushedHash: sha256(remoteBody), name: "Compute" } } },
      { "code/compute.ts": remoteBody }, // the .js is gone; the .ts carries the source
      "code/compute.ts",
    );
    const facts = await computeSyncFacts(remoteWorkflow(remoteBody), dir);
    const node = facts.nodes.find((n) => n.id === "c")!;
    assert.equal(node.file, "code/compute.ts", "the placeholder is the file map — the stale .js entry must not win");
    assert.equal(node.state, "push-pending", "the compiled .ts differs from the un-compiled remote body: local is ahead, nothing is missing");
  });
});
