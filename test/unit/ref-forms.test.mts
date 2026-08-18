// Plan 64 task 3d: the CLI's scan and the scaffolded rename hook must recognise
// the SAME set of node-reference forms.
//
// They cannot share code — the hook is a standalone `.mjs` that `init` copies
// into a user's project and that has no access to `lib/`. So the contract is
// pinned mechanically instead: one corpus, both implementations, same verdict.
//
// The forms are n8n's, not ours: `applyAccessPatterns` rewrites exactly these
// four on a rename. Anything n8n treats as a reference must be visible to the
// guard, or a rename strands a call site nothing reports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { findNodeRefs } from "../../lib/util.mts";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-refforms-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// The hook locates the sync dir from its OWN path (`import.meta.dirname`, two
// levels up) rather than from cwd, so each fixture has to materialize it where
// `init` does — `<syncdir>/.claude/hooks/` — not at a shared temp root. Copied
// from `.mjs.example`, which is inert in this repo on purpose.
const TEMPLATE_HOOK = path.join(PROJECT, "template/.claude/hooks/rename-refs.mjs.example");
const hookIn = (dir: string) => path.join(dir, ".claude", "hooks", "rename-refs.mjs");

/** Every snippet here references a node named exactly `Fetch`. */
const REFERENCES = [
  "$('Fetch')",
  '$("Fetch")',
  "$(`Fetch`)",
  "$( 'Fetch' )",
  '$node["Fetch"]',
  "$node['Fetch']",
  "$node.Fetch",
  "$node.Fetch.json.x",
  "$items('Fetch')",
  '$items("Fetch", 0)',
];

/** None of these reference a node named `Fetch` — a regex must not claim they do. */
const NON_REFERENCES = [
  "$('Fetched')",
  "$('Other')",
  "$node.Fetched",
  '$node["Fetched"]',
  "$items('Fetched', 0)",
  "// Fetch is mentioned only in prose",
  "const Fetch = 1;",
];

let seq = 0;
/** Drive the hook the way the harness does: a rename payload on stdin. */
function hookSees(snippet: string): boolean {
  const dir = path.join(TMP, `p-${seq++}`);
  const wf = path.join(dir, "workflows", "w");
  mkdirSync(path.join(wf, "code"), { recursive: true });
  mkdirSync(path.dirname(hookIn(dir)), { recursive: true });
  copyFileSync(TEMPLATE_HOOK, hookIn(dir));
  writeFileSync(path.join(dir, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: ["wf1"] }));
  writeFileSync(path.join(wf, ".decanter.json"), JSON.stringify({ workflowId: "wf1", nodes: {} }));
  writeFileSync(path.join(wf, "workflow.json"), JSON.stringify({ nodes: [] }));
  writeFileSync(path.join(wf, "code", "main.js"), `${snippet}\n`);
  const payload = JSON.stringify({ tool_input: { workflowId: "wf1", operations: [{ type: "renameNode", oldName: "Fetch", newName: "Fetched" }] } });
  try {
    execFileSync(process.execPath, [hookIn(dir)], { cwd: dir, input: payload, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return false; // exit 0 = found nothing
  } catch (err) {
    return (err as { status?: number }).status === 2;
  }
}

/** The CLI's view: does the scan attribute this snippet to the node `Fetch`? */
const cliSees = (snippet: string): boolean => findNodeRefs(snippet).some((r) => r.name === "Fetch");

describe("reference forms — CLI scan and scaffolded hook agree", () => {
  it("both find every form n8n rewrites on a rename", () => {
    for (const snippet of REFERENCES) {
      assert.equal(cliSees(snippet), true, `CLI missed: ${snippet}`);
      assert.equal(hookSees(snippet), true, `hook missed: ${snippet}`);
    }
  });

  it("neither claims a near-miss", () => {
    for (const snippet of NON_REFERENCES) {
      assert.equal(cliSees(snippet), false, `CLI false positive: ${snippet}`);
      assert.equal(hookSees(snippet), false, `hook false positive: ${snippet}`);
    }
  });

  it("they agree snippet by snippet — that is the contract, not the individual verdicts", () => {
    const disagreements = [...REFERENCES, ...NON_REFERENCES].filter((s) => cliSees(s) !== hookSees(s));
    assert.deepEqual(disagreements, [], "CLI and hook disagree on these snippets");
  });

  it("shares the documented ceiling: neither resolves a computed reference", () => {
    for (const snippet of ["$(someVar)", "$(`Fetch ${suffix}`)", "$node[key]"]) {
      assert.equal(cliSees(snippet), false, `CLI over-reached: ${snippet}`);
      assert.equal(hookSees(snippet), false, `hook over-reached: ${snippet}`);
    }
  });
});
