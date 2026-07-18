// Unit tests for .decanter.json state handling (lib/state.mts) — in
// particular the corrupt-state behavior: one broken folder must not take
// down commands for every other workflow.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { findWorkflowDir, listWorkflowDirs, listWorkflowRefs, looksLikeWorkflowId, matchWorkflowRef, nodeFileContextDir, readState, renameNodeFilePair, writeState } from "../../lib/state.mts";
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
    const log: Log = { info: () => {}, ok: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    assert.equal(findWorkflowDir(root, "wf-good", log), good);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /corrupt \.decanter\.json .*skipping this folder/);
    assert.equal(findWorkflowDir(root, "wf-missing", log), null);
  });
});

describe("listWorkflowRefs", () => {
  it("collects id, workflow.json name, and folder name; skips corrupt folders", () => {
    const root = path.join(TMP, "refs");
    const a = workflowDir("refs/Order Sync", JSON.stringify({ workflowId: "wf1", nodes: {} }));
    writeFileSync(path.join(a, "workflow.json"), JSON.stringify({ name: "Order Sync (live)" }));
    workflowDir("refs/NoJson", JSON.stringify({ workflowId: "wf2", nodes: {} }));
    workflowDir("refs/Broken", "{ broken");
    const warnings: string[] = [];
    const log: Log = { info: () => {}, ok: () => {}, warn: (m) => warnings.push(m), error: () => {} };
    const refs = listWorkflowRefs(root, log);
    assert.deepEqual(refs.map((r) => [r.id, r.name, r.names]), [
      ["wf2", "NoJson", ["NoJson"]],
      ["wf1", "Order Sync (live)", ["Order Sync (live)", "Order Sync"]],
    ]);
    assert.equal(warnings.length, 1, "corrupt folder warns once");
  });
});

describe("matchWorkflowRef", () => {
  const candidates = [
    { id: "wf1", names: ["Order Sync"] },
    { id: "wf2", names: ["Order Archive"] },
    { id: "wf3", names: ["Billing"] },
  ];

  it("matches an exact id first", () => {
    assert.equal(matchWorkflowRef(candidates, "wf2")?.id, "wf2");
  });

  it("matches an exact name case-insensitively, beating a same-tier prefix", () => {
    const withBill = [...candidates, { id: "wf4", names: ["Bill"] }];
    assert.equal(matchWorkflowRef(withBill, "BILL")?.id, "wf4"); // exact "Bill", not prefix of "Billing"
    assert.equal(matchWorkflowRef(candidates, "billing")?.id, "wf3");
  });

  it("resolves a unique name prefix", () => {
    assert.equal(matchWorkflowRef(candidates, "order sy")?.id, "wf1");
  });

  it("throws on an ambiguous prefix, listing the candidates", () => {
    assert.throws(() => matchWorkflowRef(candidates, "order"), /ambiguous workflow "order".*"Order Sync" \(wf1\).*"Order Archive" \(wf2\)/);
  });

  it("returns null when nothing matches", () => {
    assert.equal(matchWorkflowRef(candidates, "zzz"), null);
  });
});

describe("looksLikeWorkflowId", () => {
  it("accepts opaque alphanumeric tokens, rejects anything with other characters", () => {
    assert.equal(looksLikeWorkflowId("aBc123XyZ456"), true);
    assert.equal(looksLikeWorkflowId("Order Sync"), false);
    assert.equal(looksLikeWorkflowId("Räder"), false);
  });
});

describe("nodeFileContextDir", () => {
  it("finds the folder next to the file or one level above code/", () => {
    const wf = workflowDir("ctx/WF", JSON.stringify({ workflowId: "w", nodes: {} }));
    mkdirSync(path.join(wf, "code"), { recursive: true });
    writeFileSync(path.join(wf, "workflow.json"), "{}");
    const inCode = path.join(wf, "code", "a.js");
    assert.equal(nodeFileContextDir(inCode), wf); // .decanter.json one level above code/
    assert.equal(nodeFileContextDir(inCode, "workflow.json"), wf);
    assert.equal(nodeFileContextDir(path.join(wf, "b.js")), wf); // sibling marker
    assert.equal(nodeFileContextDir(path.join(TMP, "nowhere", "c.js")), null);
  });
});

describe("renameNodeFilePair", () => {
  const log: Log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };

  it("renames the source and its .remote.js sibling, returns the wanted path", () => {
    const dir = path.join(TMP, "pair1");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    writeFileSync(path.join(dir, "code/old-name.js"), "x");
    writeFileSync(path.join(dir, "code/old-name.remote.js"), "r");
    assert.equal(renameNodeFilePair(dir, "code/old-name.js", "new-name", ".js", log), "code/new-name.js");
    assert.ok(existsSync(path.join(dir, "code/new-name.js")));
    assert.ok(existsSync(path.join(dir, "code/new-name.remote.js")));
    assert.ok(!existsSync(path.join(dir, "code/old-name.js")));
  });

  it("never renames across extensions and never clobbers an existing target", () => {
    const dir = path.join(TMP, "pair2");
    mkdirSync(path.join(dir, "code"), { recursive: true });
    writeFileSync(path.join(dir, "code/a.js"), "js source");
    // ext .ts differs from the current .js → the source must stay in place
    assert.equal(renameNodeFilePair(dir, "code/a.js", "b", ".ts", log), "code/b.ts");
    assert.ok(existsSync(path.join(dir, "code/a.js")));
    assert.ok(!existsSync(path.join(dir, "code/b.ts")));
    // occupied target → rename skipped, target content preserved
    writeFileSync(path.join(dir, "code/c.js"), "target");
    assert.equal(renameNodeFilePair(dir, "code/a.js", "c", ".js", log), "code/c.js");
    assert.equal(readFileSync(path.join(dir, "code/c.js"), "utf8"), "target");
    assert.ok(existsSync(path.join(dir, "code/a.js")));
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
