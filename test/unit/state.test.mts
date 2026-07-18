// Unit tests for .decanter.json state handling (lib/state.mts) — in
// particular the corrupt-state behavior: one broken folder must not take
// down commands for every other workflow.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { findWorkflowDir, listWorkflowDirs, readState, writeState } from "../../lib/state.mts";
import type { Log } from "../../lib/types.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-state-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function workflowDir(rel: string, state: string): string {
  const dir = path.join(TMP, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".decanter.json"), state);
  return dir;
}

describe("readState", () => {
  it("returns null when the state file is missing", () => {
    const dir = path.join(TMP, "empty");
    mkdirSync(dir, { recursive: true });
    assert.equal(readState(dir), null);
  });

  it("round-trips through writeState", () => {
    const dir = path.join(TMP, "roundtrip");
    mkdirSync(dir, { recursive: true });
    const state = { workflowId: "wf1", nodes: { n1: { file: "code/a.js", lastPushedHash: "sha256:0" } } };
    writeState(dir, state);
    assert.deepEqual(readState(dir), state);
  });

  it("throws a clear, file-naming error on corrupt JSON", () => {
    const dir = workflowDir("corrupt", "{ broken");
    assert.throws(() => readState(dir), /^Error: corrupt \.decanter\.json \(/);
  });
});

describe("findWorkflowDir", () => {
  it("skips (and warns about) a corrupt folder without breaking the scan", () => {
    const root = path.join(TMP, "root");
    workflowDir("root/Broken", "{ broken");
    const good = workflowDir("root/Good", JSON.stringify({ workflowId: "wf-good", nodes: {} }));
    const warnings: string[] = [];
    const log: Log = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    assert.equal(findWorkflowDir(root, "wf-good", log), good);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /corrupt \.decanter\.json .*skipping this folder/);
    assert.equal(findWorkflowDir(root, "wf-missing", log), null);
  });
});

describe("listWorkflowDirs", () => {
  it("finds nested workflow folders, does not descend into them or node_modules", () => {
    const root = path.join(TMP, "tree");
    const a = workflowDir("tree/group/A", JSON.stringify({ workflowId: "a", nodes: {} }));
    const b = workflowDir("tree/B", JSON.stringify({ workflowId: "b", nodes: {} }));
    workflowDir("tree/B/code-sub", JSON.stringify({ workflowId: "inner", nodes: {} })); // below a workflow folder: invisible
    workflowDir("tree/node_modules/dep", JSON.stringify({ workflowId: "dep", nodes: {} }));
    assert.deepEqual(listWorkflowDirs(root), [b, a].sort());
  });

  it("returns [] for a missing root", () => {
    assert.deepEqual(listWorkflowDirs(path.join(TMP, "nope")), []);
  });
});
