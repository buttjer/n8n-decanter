// Unit tests for init's package-root resolution — the regression guard for
// the 2026-07-18 release blocker: from the published build (dist/lib/), a
// plain `../template` URL resolved to the nonexistent dist/template.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { init, normalizeHostInput, packageRootFrom } from "../../lib/init.mts";
import type { Log } from "../../lib/types.mts";

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

describe("normalizeHostInput", () => {
  it("keeps a scheme the user typed, stripping trailing slashes", () => {
    assert.equal(normalizeHostInput("http://127.0.0.1:5678"), "http://127.0.0.1:5678");
    assert.equal(normalizeHostInput("https://n8n.example.com/"), "https://n8n.example.com");
    assert.equal(normalizeHostInput("  https://n8n.example.com//  "), "https://n8n.example.com");
  });

  it("defaults LOCAL scheme-less hosts to http (Plan 35 finding)", () => {
    for (const h of ["localhost:5678", "127.0.0.1:5678", "127.0.0.1", "0.0.0.0:5678", "10.0.0.4:5678", "192.168.1.20:5678", "172.16.0.5", "n8n.local", "[::1]:5678", "::1"]) {
      assert.equal(normalizeHostInput(h), "http://" + h.trim(), `local host ${h} should default to http`);
    }
  });

  it("defaults non-local scheme-less hosts to https", () => {
    assert.equal(normalizeHostInput("n8n.example.com"), "https://n8n.example.com");
    assert.equal(normalizeHostInput("my-instance.app.n8n.cloud"), "https://my-instance.app.n8n.cloud");
    assert.equal(normalizeHostInput("203.0.113.10:5678"), "https://203.0.113.10:5678");
  });
});

describe("init (non-interactive flags)", () => {
  const nullLog: Log = { info: () => {}, ok: () => {}, warn: () => {}, error: () => {} };

  it("throws instead of prompting when a setup flag is passed but the host is missing (Plan 35 finding)", async () => {
    const dir = path.join(TMP, "flag-no-host");
    // A setup flag makes init non-interactive: with no host (and no .env), a
    // flag-less init would prompt "n8n host:" and hang on non-TTY stdin; flag
    // mode must error with the fix-it hint and read no stdin at all.
    await assert.rejects(init(dir, { token: "tok" }, nullLog), /host is required — pass --host <url>/);
  });
});
