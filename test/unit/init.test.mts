// Unit tests for init's package-root resolution — the regression guard for
// the 2026-07-18 release blocker: from the published build (dist/lib/), a
// plain `../template` URL resolved to the nonexistent dist/template.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { packageRootFrom } from "../../lib/init.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-init-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

describe("packageRootFrom", () => {
  it("finds the package root from the checkout layout (lib/)", () => {
    const pkg = path.join(TMP, "checkout");
    mkdirSync(path.join(pkg, "lib"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), "{}");
    assert.equal(packageRootFrom(path.join(pkg, "lib")), pkg);
  });

  it("finds the package root from the published layout (dist/lib/, no package.json in dist)", () => {
    const pkg = path.join(TMP, "published");
    mkdirSync(path.join(pkg, "dist", "lib"), { recursive: true });
    mkdirSync(path.join(pkg, "template"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), "{}");
    assert.equal(packageRootFrom(path.join(pkg, "dist", "lib")), pkg);
  });

  it("stops at the nearest package.json, not a higher one", () => {
    const outer = path.join(TMP, "outer");
    const inner = path.join(outer, "node_modules", "n8n-decanter");
    mkdirSync(path.join(inner, "dist", "lib"), { recursive: true });
    writeFileSync(path.join(outer, "package.json"), "{}");
    writeFileSync(path.join(inner, "package.json"), "{}");
    assert.equal(packageRootFrom(path.join(inner, "dist", "lib")), inner);
  });
});
