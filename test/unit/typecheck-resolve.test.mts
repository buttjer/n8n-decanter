// Regression test for plans/13's global-install gap: scripts/typecheck.mts
// must resolve `typescript` relative to the sync dir it's typechecking (its
// cwd), not relative to its own file location — a globally-installed CLI's
// own location is never inside the sync dir, so the old plain
// `import ts from "typescript"` could never find the sync dir's scaffolded
// `typescript` devDependency. Spawns the real script exactly like
// lib/validate.mts's runTypecheck does, with cwd deliberately far from the
// script itself (this repo checkout) — mirroring the real global-install
// topology — and a fake `typescript` package planted in cwd's node_modules
// so a distinctive failure proves which copy got loaded.
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

const execFile = promisify(execFileCb);
const SCRIPT = fileURLToPath(new URL("../../scripts/typecheck.mts", import.meta.url));

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-typecheck-resolve-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A fake `typescript` package that fails loudly and distinctively when used. */
function plantFakeTypescript(dir: string): void {
  const pkgDir = path.join(dir, "node_modules", "typescript");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "typescript", version: "0.0.0-fake", main: "index.js" }));
  writeFileSync(
    path.join(pkgDir, "index.js"),
    'exports.sys = { fileExists: () => false };\nexports.findConfigFile = () => { throw new Error("FAKE_TYPESCRIPT_MARKER"); };\n',
  );
}

describe("scripts/typecheck.mts typescript resolution", () => {
  it("prefers the sync dir's own typescript over the script's own location", async () => {
    const dir = path.join(TMP, "with-fake");
    mkdirSync(dir, { recursive: true });
    plantFakeTypescript(dir);
    await assert.rejects(execFile(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" }), (err: unknown) => {
      const e = err as { stderr?: string };
      assert.match(e.stderr ?? "", /FAKE_TYPESCRIPT_MARKER/);
      return true;
    });
  });

  it("falls back to the script's own location when the sync dir has no typescript", async () => {
    const dir = path.join(TMP, "no-fake");
    mkdirSync(dir, { recursive: true });
    // No node_modules/typescript here: must fall back to this repo's own
    // devDependency (resolved relative to SCRIPT's location) instead of
    // crashing with a module-not-found error.
    try {
      await execFile(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
      assert.fail("expected a non-zero exit (no tsconfig.json in the temp dir)");
    } catch (err) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      assert.doesNotMatch((e.stderr ?? "") + (e.stdout ?? ""), /FAKE_TYPESCRIPT_MARKER/);
      assert.match((e.stderr ?? "") + (e.stdout ?? ""), /tsconfig\.json not found/);
      assert.equal(e.code, 2);
    }
  });
});
