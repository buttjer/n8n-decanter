// Unit tests for the scaffolded PostToolUse verify hook
// (template/.claude/hooks/verify.mjs.example, Plan 81 task 8).
//
// The hook runs `preflight --offline` after an edit to a Code-node source file
// and turns a non-zero exit into blocking feedback (exit 2). Its load-bearing
// property is that it must behave IDENTICALLY however the agent was started:
// the scripts live in the sync dir, but an agent launched at a bigger repo's
// root spawns them with cwd = that root. So every case here is scaffolded
// nested — sync dir at <repo>/flows — and driven from both cwds.
//
// The CLI is a stub that logs which copy of itself ran, its cwd and its argv.
// A case installs it in the sync dir's node_modules/.bin (the local-install
// shape), on PATH (the global-install shape most users have — the one the dir
// pin must not disturb), or both (to pin down which one wins). PATH is always
// scrubbed to the case's own dir, so no machine-global n8n-decanter can satisfy
// a case, and nothing here needs a reachable n8n.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-verifyhook-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
interface Case {
  /** The bigger repo the agent may have been launched in — NOT the sync dir. */
  parent: string;
  /** The nested sync dir: everything `init` scaffolds lives here. */
  syncDir: string;
  /** Where the hook script was materialized, as `init` materializes it. */
  hook: string;
  /** The edited Code-node source file. */
  nodeFile: string;
  /** The stub CLI's log — absent iff the CLI was never spawned. */
  log: string;
  /** The ONLY dir on the hook's PATH: empty unless the case installs there. */
  pathDir: string;
}

/** A sync dir nested one level inside an unrelated parent repo. */
function scaffold({ cli = true, onPath = false, exit = 0, say = "" }: { cli?: boolean; onPath?: boolean; exit?: number; say?: string } = {}): Case {
  const base = path.join(TMP, `case-${seq++}`);
  const parent = path.join(base, "repo");
  const syncDir = path.join(parent, "flows");
  const wf = path.join(syncDir, "workflows", "orders");
  const pathDir = path.join(base, "path");
  const log = path.join(base, "cli.log");
  mkdirSync(path.join(wf, "code"), { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  // The parent looks like a project too, so a cwd-bound hook would find *it*.
  writeFileSync(path.join(parent, "package.json"), JSON.stringify({ name: "the-monorepo" }));

  // `.mjs.example` is inert on purpose; materialize it where `init` puts it —
  // the location is what the hook self-locates from.
  mkdirSync(path.join(syncDir, ".claude", "hooks"), { recursive: true });
  const hook = path.join(syncDir, ".claude", "hooks", "verify.mjs");
  copyFileSync(path.join(PROJECT, "template/.claude/hooks/verify.mjs.example"), hook);

  writeFileSync(path.join(syncDir, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: ["wf1"] }));
  writeFileSync(path.join(wf, ".decanter.json"), JSON.stringify({ workflowId: "wf1", nodes: { n1: { file: "code/main.js" } } }));
  const nodeFile = path.join(wf, "code", "main.js");
  writeFileSync(nodeFile, "return [];\n");

  // Only shell builtins, so the scrubbed PATH can't break the stub. `who=`
  // names the copy, so a case with both installed can tell which one ran.
  const writeStub = (dir: string, who: string) => {
    mkdirSync(dir, { recursive: true });
    const stub = path.join(dir, "n8n-decanter");
    writeFileSync(stub, `#!/bin/sh\necho "who=${who}" >> ${JSON.stringify(log)}\necho "cwd=$(pwd -P)" >> ${JSON.stringify(log)}\necho "args=$*" >> ${JSON.stringify(log)}\n${say === "" ? "" : `echo ${JSON.stringify(say)}\n`}exit ${exit}\n`);
    chmodSync(stub, 0o755);
  };
  if (cli) writeStub(path.join(syncDir, "node_modules", ".bin"), "local");
  if (onPath) writeStub(pathDir, "path");
  return { parent, syncDir, hook, nodeFile, log, pathDir };
}

/** Drive the hook the way the harness does: JSON payload on stdin. */
function run(c: Case, cwd: string, file: string | undefined = c.nodeFile): { code: number; out: string } {
  const payload = file === undefined ? {} : { tool_input: { file_path: file } };
  try {
    const out = execFileSync(process.execPath, [c.hook], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, PATH: c.pathDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** What the stub CLI recorded — `pwd -P`, so compare against realpaths. */
function spawned(c: Case): string {
  return existsSync(c.log) ? readFileSync(c.log, "utf8") : "";
}

/**
 * One entry per spawn: the dir preflight actually ran in. Compared as plain
 * strings — a temp path is not a safe RegExp source.
 */
function cwds(c: Case): string[] {
  return spawned(c)
    .split("\n")
    .filter((line) => line.startsWith("cwd="))
    .map((line) => line.slice("cwd=".length));
}

describe("verify hook", () => {
  it("runs preflight for the edited workflow, from the sync dir's own install", () => {
    const c = scaffold();
    const { code, out } = run(c, c.syncDir);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "");
    // Scoped to the workflow ID from .decanter.json, not the folder name.
    assert.match(spawned(c), /args=preflight --offline wf1/);
    // Nothing was on PATH, so the local node_modules/.bin copy is what ran.
    assert.ok(spawned(c).includes("who=local"), spawned(c));
    assert.deepEqual(cwds(c), [realpathSync(c.syncDir)]);
  });

  it("blocks with the CLI's output when preflight fails", () => {
    const c = scaffold({ exit: 1, say: "layout: node 'Gone' is not in this workflow" });
    const { code, out } = run(c, c.syncDir);
    assert.equal(code, 2, `a failed preflight must reach the agent as blocking feedback: ${out}`);
    assert.match(out, /preflight --offline failed after editing main\.js/);
    assert.match(out, /node 'Gone' is not in this workflow/);
  });

  it("REGRESSION: an agent started in the parent repo gets the same run, not a blocking error", () => {
    // Before Plan 81 the CLI was spawned bare and cwd-less, so from here
    // decanter's UPWARD config search missed the sync dir entirely and every
    // node-file edit came back as exit 2 complaining about a missing sync dir.
    const c = scaffold();
    const { code, out } = run(c, c.parent);
    assert.equal(code, 0, `a nested sync dir must not turn every edit into blocking feedback: ${out}`);
    assert.equal(out.trim(), "");
    assert.deepEqual(cwds(c), [realpathSync(c.syncDir)], "preflight must run IN the sync dir, whatever the agent's cwd is");
    assert.match(spawned(c), /args=preflight --offline wf1/);
  });

  it("still blocks on a real failure when driven from the parent repo", () => {
    const c = scaffold({ exit: 1, say: "layout: node 'Gone' is not in this workflow" });
    const { code, out } = run(c, c.parent);
    assert.equal(code, 2, out);
    assert.match(out, /node 'Gone' is not in this workflow/);
  });

  it("keeps the global-install shape intact: a PATH-resolved CLI, run in the sync dir either way", () => {
    // The shape almost every user has today — no node_modules in the sync dir,
    // `n8n-decanter` installed globally. Adding the dir pin must not disturb it,
    // and from cwd == the sync dir it has to stay bit-for-bit what it was.
    const c = scaffold({ cli: false, onPath: true });
    for (const cwd of [c.syncDir, c.parent]) {
      const { code, out } = run(c, cwd);
      assert.equal(code, 0, `a PATH-resolved CLI must still run quietly: ${out}`);
      assert.equal(out.trim(), "");
    }
    assert.ok(spawned(c).includes("who=path"), `the CLI on PATH is what must have run: ${spawned(c)}`);
    assert.deepEqual(cwds(c), [realpathSync(c.syncDir), realpathSync(c.syncDir)]);
    assert.match(spawned(c), /args=preflight --offline wf1/);
  });

  it("prefers the sync dir's own install over one on PATH", () => {
    const c = scaffold({ onPath: true });
    const { code } = run(c, c.parent);
    assert.equal(code, 0);
    assert.ok(spawned(c).includes("who=local"), `node_modules/.bin wins, npm-style: ${spawned(c)}`);
    assert.ok(!spawned(c).includes("who=path"), `and the PATH copy must not run too: ${spawned(c)}`);
  });

  it("is an immediate quiet no-op for anything that is not a node file", () => {
    for (const file of ["README.md", "workflows/orders/code/main.remote.js", "workflows/orders/workflow.json", "shared/money.ts"]) {
      for (const cwd of ["syncDir", "parent"] as const) {
        const c = scaffold();
        const { code, out } = run(c, c[cwd], path.join(c.syncDir, file));
        assert.equal(code, 0, `${file} from ${cwd}: ${out}`);
        assert.equal(out.trim(), "");
        assert.equal(spawned(c), "", `${file} must not spawn the CLI at all`);
      }
    }
  });

  it("stays quiet when the CLI isn't installed yet (fresh scaffold)", () => {
    const c = scaffold({ cli: false });
    for (const cwd of [c.syncDir, c.parent]) {
      const { code, out } = run(c, cwd);
      assert.equal(code, 0, `a missing CLI is guidance-free silence, never a block: ${out}`);
      assert.equal(out.trim(), "");
    }
  });

  it("survives junk input instead of crashing the agent's turn", () => {
    const c = scaffold();
    for (const payload of ["", "not json", "{}", '{"tool_input":null}', '{"tool_input":{}}']) {
      const res = (() => {
        try {
          execFileSync(process.execPath, [c.hook], { cwd: c.parent, input: payload, encoding: "utf8", env: { ...process.env, PATH: c.pathDir } });
          return 0;
        } catch (err) {
          return (err as { status?: number }).status ?? 1;
        }
      })();
      assert.equal(res, 0, `payload ${JSON.stringify(payload)} should be a silent no-op`);
    }
  });
});
