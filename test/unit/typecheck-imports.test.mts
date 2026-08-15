// The scaffolded tsconfig must accept BOTH spellings of a helper import.
// `moduleResolution: "bundler"` makes the extensionless form (what the docs
// teach) resolve, but esbuild resolves an explicit `../../../shared/money.ts`
// just as happily — so without `allowImportingTsExtensions` the typecheck
// rejects (TS5097) code that `push` bundles without complaint: the gate and
// the bundler disagreeing over a pure spelling choice. Driven through the
// real wrapper script, against the template tsconfig verbatim.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

const execFile = promisify(execFileCb);
const SCRIPT = fileURLToPath(new URL("../../scripts/typecheck.mts", import.meta.url));
// The SCAFFOLDED tsconfig, verbatim — dropping the option from the template
// must fail here, not just in a user's sync dir months later.
const TEMPLATE_TSCONFIG = fileURLToPath(new URL("../../template/tsconfig.json.example", import.meta.url));

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-typecheck-imports-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A sync dir with the scaffolded tsconfig, a shared helper, and one node file. */
function project(name: string, nodeSource: string): string {
  const proj = path.join(TMP, name);
  mkdirSync(path.join(proj, "shared"), { recursive: true });
  mkdirSync(path.join(proj, "workflows", "a", "code"), { recursive: true });
  writeFileSync(path.join(proj, "tsconfig.json"), readFileSync(TEMPLATE_TSCONFIG, "utf8"));
  writeFileSync(path.join(proj, "shared", "money.ts"), "export const total = (lines: number[]): number => lines.reduce((a, b) => a + b, 0);\n");
  writeFileSync(path.join(proj, "workflows", "a", ".decanter.json"), JSON.stringify({ workflowId: "a", nodes: {} }));
  writeFileSync(path.join(proj, "workflows", "a", "code", "node.ts"), nodeSource);
  return proj;
}

async function typecheck(cwd: string): Promise<{ code: number; out: string }> {
  try {
    const r = await execFile(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("helper imports in node files", () => {
  it("accepts an explicit .ts extension as well as the extensionless form", async () => {
    for (const [name, spec] of [["with-extension", "../../../shared/money.ts"], ["extensionless", "../../../shared/money"]]) {
      const proj = project(name, `import { total } from "${spec}";\n\nreturn [{ json: { total: total([1, 2]) } }];\n`);
      const { code, out } = await typecheck(proj);
      assert.equal(code, 0, `${spec}: ${out}`);
    }
  });

  it("really resolves the .ts-suffixed module — its types still gate the node", async () => {
    const proj = project("typed", 'import { total } from "../../../shared/money.ts";\n\nreturn [{ json: { total: total("nope") } }];\n');
    const { code, out } = await typecheck(proj);
    assert.equal(code, 1, out);
    // TS2345 = the helper's signature applied. TS2307 (unresolved module) or
    // TS5097 (extension rejected) would mean the import never really landed.
    assert.match(out, /code[/\\]node\.ts\(3,\d+\): error TS2345/, "the argument type error must be reported on the node file's own line");
    assert.doesNotMatch(out, /TS2307|TS5097/, out);
  });
});
