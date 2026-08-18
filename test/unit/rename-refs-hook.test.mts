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

// `.mjs.example` is inert on purpose; materialize it the way `init` does — at
// `<syncdir>/.claude/hooks/`, which is also where the hook reads its own
// position from to find the sync dir, so the placement is load-bearing here.
const TEMPLATE_HOOK = path.join(PROJECT, "template/.claude/hooks/rename-refs.mjs.example");
const hookIn = (dir: string) => path.join(dir, ".claude", "hooks", "rename-refs.mjs");

// A decoy at the shared temp root, which the "agent started above the sync dir"
// cases below use as cwd: it makes a cwd-relative read actively WRONG (a root
// that does not exist) rather than merely fruitless, so those tests cannot pass
// by accident.
writeFileSync(path.join(TMP, "decanter.config.json"), JSON.stringify({ root: "./nowhere", workflows: ["wf1"] }));

let seq = 0;
interface Scaffold {
  /** workflow.json node params — the "other nodes' expression parameters" half. */
  param?: string;
  /** code/main.js body — the half we own. */
  code?: string;
  workflowId?: string;
  /** `decanter.config.json`'s `root` — sync-dir-relative, so it must resolve from there. */
  root?: string;
}

/** A sync dir in the PRE-PULL state: the snapshot still holds the old name. */
function scaffold({ param = "={{ $json.x }}", code = "return [];\n", workflowId = "wf1", root = "./workflows" }: Scaffold = {}): string {
  const dir = path.join(TMP, `proj-${seq++}`);
  const wf = path.join(dir, root, "orders");
  mkdirSync(path.join(wf, "code"), { recursive: true });
  mkdirSync(path.dirname(hookIn(dir)), { recursive: true });
  copyFileSync(TEMPLATE_HOOK, hookIn(dir));
  writeFileSync(path.join(dir, "decanter.config.json"), JSON.stringify({ root, workflows: [workflowId] }));
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

/**
 * Drive the hook the way the harness does: JSON payload on stdin. `cwd` is the
 * AGENT's launch dir — the sync dir by default, anywhere else when the sync dir
 * is nested in a bigger repo.
 */
function run(dir: string, payload: unknown, cwd = dir): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [hookIn(dir)], { cwd, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
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
          execFileSync(process.execPath, [hookIn(dir)], { cwd: dir, input: payload, encoding: "utf8" });
          return 0;
        } catch (err) {
          return (err as { status?: number }).status ?? 1;
        }
      })();
      assert.equal(res, 0, `payload ${JSON.stringify(payload)} should be a silent no-op`);
    }
  });
});

// Plan 81 task 8. The hook is declared in `<syncdir>/.claude/settings.json` but
// SPAWNED WITH THE AGENT'S CWD — the sync dir only when the agent was started
// there. With the sync dir nested in a bigger repo the agent runs at the repo
// root, where a cwd-reading hook finds no `decanter.config.json`, no workflow,
// and exits 0: a silent no-op in the guard whose whole job is catching the refs
// n8n's `renameNode` strands. Anchoring on `import.meta.dirname` fixes it,
// because `init` always writes the script to `<syncdir>/.claude/hooks/`.
describe("rename-refs hook — locates the sync dir from its own path, not cwd", () => {
  it("is unchanged when the agent runs IN the sync dir", () => {
    const dir = scaffold({ code: "return $('Fetch').all();\n" });
    const { code, out } = run(dir, renameOp());
    assert.equal(code, 2, out);
    // Bare sync-dir-relative path, byte for byte what it printed before the fix.
    assert.match(out, /^ {2}workflows\/orders\/code\/main\.js:1 {2}return \$\('Fetch'\)/m);
  });

  it("still reports when the agent runs ABOVE the sync dir", () => {
    const dir = scaffold({ param: "={{ $('Fetch').first().json.x }}", code: "return $('Fetch').all();\n" });
    const { code, out } = run(dir, renameOp(), TMP); // TMP is the parent of `dir`
    assert.equal(code, 2, `must not degrade to a silent no-op from a parent cwd: ${out}`);
    assert.match(out, /EXPRESSION PARAMETERS/);
    // The path stays anchored on the agent's cwd, so it still opens from there.
    assert.match(out, new RegExp(`CODE FILES[^]*${path.basename(dir)}/workflows/orders/code/main\\.js:1`));
  });

  it("resolves a non-default `root` against the sync dir, not the cwd", () => {
    const dir = scaffold({ root: "./flows", code: "return $('Fetch').all();\n" });
    const { code, out } = run(dir, renameOp(), TMP);
    assert.equal(code, 2, out);
    assert.match(out, new RegExp(`${path.basename(dir)}/flows/orders/code/main\\.js:1`));
  });
});
