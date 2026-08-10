// Plan 79 F1 regression tests: a SCOPED typecheck run (what preflight does)
// must still report diagnostics in shared helper files — code outside every
// workflow dir — because the unscoped run `push` does fails on them for every
// workflow alike. Before the fix, preflight graded `types` green on code
// `push` then rejected: the gate lied. Scoping keeps doing its actual job,
// which is isolating one workflow from another workflow's *node* errors.
//
// Two layers, driven the way the product drives them: the script spawned with
// scope args (preflight's subprocess), and lib's runTypecheckPerDir seam that
// attributes one run back to each workflow dir.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { runTypecheckPerDir } from "../../lib/validate.mts";

const execFile = promisify(execFileCb);
const SCRIPT = fileURLToPath(new URL("../../scripts/typecheck.mts", import.meta.url));

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-typecheck-scope-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PROJ = path.join(TMP, "proj");
const WF_A = path.join(PROJ, "workflows", "a");
const WF_B = path.join(PROJ, "workflows", "b");

before(() => {
  for (const wf of [WF_A, WF_B]) {
    mkdirSync(path.join(wf, "code"), { recursive: true });
    writeFileSync(path.join(wf, ".decanter.json"), JSON.stringify({ workflowId: path.basename(wf), nodes: {} }));
  }
  writeFileSync(
    path.join(PROJ, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "preserve",
        moduleResolution: "bundler",
        lib: ["ES2022"],
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        moduleDetection: "force",
      },
      include: ["**/*.ts", "**/*.js"],
      exclude: ["node_modules", "**/*.remote.js"],
    }),
  );
  // clean node file in A (top-level return — the wrapper must still apply)
  writeFileSync(path.join(WF_A, "code", "node.ts"), "const rows: number[] = [];\nreturn rows.map((n) => ({ json: { n } }));\n");
  // node file in B with its own type error — must stay B's alone
  writeFileSync(path.join(WF_B, "code", "node.ts"), 'const n: number = "not a number";\nreturn [{ json: { n } }];\n');
  // broken helpers OUTSIDE every workflow dir, under two different roots —
  // the folder name must not matter (Plan 79: shared/ is a convention)
  mkdirSync(path.join(PROJ, "shared"), { recursive: true });
  mkdirSync(path.join(PROJ, "helpers"), { recursive: true });
  writeFileSync(path.join(PROJ, "shared", "broken.ts"), 'export const x: number = "wrong";\n');
  writeFileSync(path.join(PROJ, "helpers", "alt.ts"), 'export const y: string = 42;\n');
});

async function runScoped(...dirs: string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await execFile(process.execPath, [SCRIPT, ...dirs], { cwd: PROJ, encoding: "utf8" });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("scoped typecheck sees shared code (Plan 79 F1)", () => {
  it("a run scoped to one workflow reports helper errors under ANY root, but not the other workflow's node error", async () => {
    const { code, out } = await runScoped(WF_A);
    assert.equal(code, 1, out);
    assert.match(out, /shared[/\\]broken\.ts\(1,14\): error TS2322/, "shared/ helper error must not be dropped by the scope");
    assert.match(out, /helpers[/\\]alt\.ts\(1,14\): error TS2322/, "a non-shared helper root is the same common infrastructure");
    assert.doesNotMatch(out, /workflows[/\\]b[/\\]/, "another workflow's NODE error stays out of scope");
    assert.doesNotMatch(out, /workflows[/\\]a[/\\]/, "the clean in-scope node file produces no diagnostic");
  });

  it("scope dirs reached through a symlinked path still match (Plan 79 task 4)", async () => {
    // The compiler's file names live under the REALPATHED cwd; before the fix,
    // scope dirs handed over in a symlinked spelling (macOS /tmp) never
    // prefix-matched, and every node diagnostic silently vanished from a
    // scoped run.
    const alias = path.join(TMP, "proj-alias");
    symlinkSync(PROJ, alias, "dir");
    const { code, out } = await runScoped(path.join(alias, "workflows", "b"));
    assert.equal(code, 1, out);
    assert.match(out, /workflows[/\\]b[/\\]code[/\\]node\.ts\(1,7\): error TS2322/, "the scoped node error must survive the symlinked spelling");
  });

  it("runTypecheckPerDir attributes a helper diagnostic to EVERY workflow, a node diagnostic to its own dir only", async () => {
    const map = await runTypecheckPerDir(PROJ, [WF_A, WF_B]);
    const a = map.get(WF_A);
    const b = map.get(WF_B);
    assert.equal(a?.status, "failed", "A must fail on the shared helper alone");
    assert.match(a?.output ?? "", /shared[/\\]broken\.ts/);
    assert.match(a?.output ?? "", /helpers[/\\]alt\.ts/);
    assert.doesNotMatch(a?.output ?? "", /workflows[/\\]b[/\\]/, "B's node error must not leak into A");
    assert.equal(b?.status, "failed");
    assert.match(b?.output ?? "", /workflows[/\\]b[/\\]code[/\\]node\.ts\(1,7\): error TS2322/, "B keeps its own node error");
    assert.match(b?.output ?? "", /shared[/\\]broken\.ts/, "and the shared error too");
  });
});
