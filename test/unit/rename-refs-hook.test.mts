// Unit tests for the scaffolded PostToolUse rename hook
// (template/.claude/hooks/rename-refs.mjs.example, Plan 64 task 3a).
//
// The hook is what tells an agent that n8n's `renameNode` op left every
// `$('Old Name')` reference behind. It is driven exactly as Claude Code drives
// it: the tool payload on stdin, in a scaffolded sync dir.
//
// The load-bearing case is "pre-pull": the hook fires the instant the tool
// returns, BEFORE the debounced snapshot refresh, so `workflow.json` still
// carries the OLD node name and every ref still resolves. That is why the hook
// scans for the old name instead of running `preflight`, which would be green.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-renamehook-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// `.mjs.example` is inert on purpose; materialize it the way `init` does.
const HOOK = path.join(TMP, "rename-refs.mjs");
copyFileSync(path.join(PROJECT, "template/.claude/hooks/rename-refs.mjs.example"), HOOK);

let seq = 0;
interface Scaffold {
  /** workflow.json node params — the "other nodes' expression parameters" half. */
  param?: string;
  /** code/main.js body — the half we own. */
  code?: string;
  workflowId?: string;
}

/** A sync dir in the PRE-PULL state: the snapshot still holds the old name. */
function scaffold({ param = "={{ $json.x }}", code = "return [];\n", workflowId = "wf1" }: Scaffold = {}): string {
  const dir = path.join(TMP, `proj-${seq++}`);
  const wf = path.join(dir, "workflows", "orders");
  mkdirSync(path.join(wf, "code"), { recursive: true });
  writeFileSync(path.join(dir, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: [workflowId] }));
  writeFileSync(path.join(wf, ".decanter.json"), JSON.stringify({ workflowId, nodes: { n2: { file: "code/main.js" } } }));
  writeFileSync(
    path.join(wf, "workflow.json"),
    JSON.stringify({
      nodes: [
        { id: "n1", name: "Fetch", type: "n8n-nodes-base.code", parameters: { jsCode: "//@file:code/fetch.js" } },
        { id: "n2", name: "Label", type: "n8n-nodes-base.set", parameters: { value: param } },
      ],
    }),
  );
  writeFileSync(path.join(wf, "code", "main.js"), code);
  return dir;
}

/** Drive the hook the way the harness does: JSON payload on stdin. */
function run(dir: string, payload: unknown): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [HOOK], { cwd: dir, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const renameOp = (workflowId = "wf1", oldName = "Fetch", newName = "Fetched") => ({
  tool_input: { workflowId, operations: [{ type: "renameNode", oldName, newName }] },
});

describe("rename-refs hook", () => {
  it("fires PRE-PULL, when the snapshot still carries the old name and preflight would be green", () => {
    // Both halves reference "Fetch"; the snapshot still calls the node "Fetch",
    // so every ref resolves and the compliance guard has nothing to say yet.
    const dir = scaffold({ param: "={{ $('Fetch').first().json.x }}", code: "return $('Fetch').all();\n" });
    const { code, out } = run(dir, renameOp());
    assert.equal(code, 2, `hook must block so the agent sees it: ${out}`);
    assert.match(out, /renameNode op rewrites the node name and connections ONLY/);
    assert.match(out, /"Fetch" → "Fetched"/);
  });

  it("routes each half to where it is actually repaired", () => {
    const dir = scaffold({ param: "={{ $('Fetch').first().json.x }}", code: "return $('Fetch').all();\n" });
    const { out } = run(dir, renameOp());
    // Structure half -> n8n, explicitly NOT workflow.json.
    assert.match(out, /EXPRESSION PARAMETERS/);
    assert.match(out, /not by editing workflow\.json/);
    // Our half -> the file, with a line number to jump to.
    assert.match(out, /CODE FILES/);
    assert.match(out, /code\/main\.js:1/);
    // And the order, which is the part that silently destroys work if reversed.
    assert.match(out, /EXPRESSION PARAMETERS FIRST/);
  });

  it("reports only the half that is actually dirty", () => {
    const codeOnly = run(scaffold({ code: "return $('Fetch').all();\n" }), renameOp());
    assert.equal(codeOnly.code, 2);
    assert.match(codeOnly.out, /CODE FILES/);
    assert.doesNotMatch(codeOnly.out, /EXPRESSION PARAMETERS/);
    assert.match(codeOnly.out, /then `n8n-decanter push`/);

    const paramOnly = run(scaffold({ param: "={{ $('Fetch').first().json.x }}" }), renameOp());
    assert.equal(paramOnly.code, 2);
    assert.match(paramOnly.out, /EXPRESSION PARAMETERS/);
    assert.doesNotMatch(paramOnly.out, /CODE FILES/);
  });

  it("catches the ref forms n8n's own rewriter handles, in every quote style", () => {
    for (const ref of [`$('Fetch')`, `$("Fetch")`, "$(`Fetch`)", `$node["Fetch"]`, `$items('Fetch')`]) {
      const { code, out } = run(scaffold({ code: `return ${ref}.all();\n` }), renameOp());
      assert.equal(code, 2, `missed ${ref}: ${out}`);
    }
  });

  it("stays silent when nothing references the old name", () => {
    const { code, out } = run(scaffold(), renameOp());
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "");
  });

  it("stays silent on a batch with no rename, and on a no-op rename", () => {
    const dir = scaffold({ code: "return $('Fetch').all();\n" });
    const other = run(dir, { tool_input: { workflowId: "wf1", operations: [{ type: "updateNodeParameters", nodeName: "Label", parameters: {} }] } });
    assert.equal(other.code, 0, other.out);
    const noop = run(dir, renameOp("wf1", "Fetch", "Fetch"));
    assert.equal(noop.code, 0, noop.out);
  });

  it("stays silent for a workflow this repo does not track", () => {
    const { code, out } = run(scaffold({ code: "return $('Fetch').all();\n" }), renameOp("wf-elsewhere"));
    assert.equal(code, 0, out);
  });

  it("survives junk input instead of crashing the agent's turn", () => {
    const dir = scaffold();
    for (const payload of ["", "not json", "{}", '{"tool_input":null}', '{"tool_input":{"operations":"nope"}}']) {
      const res = (() => {
        try {
          execFileSync(process.execPath, [HOOK], { cwd: dir, input: payload, encoding: "utf8" });
          return 0;
        } catch (err) {
          return (err as { status?: number }).status ?? 1;
        }
      })();
      assert.equal(res, 0, `payload ${JSON.stringify(payload)} should be a silent no-op`);
    }
  });
});
