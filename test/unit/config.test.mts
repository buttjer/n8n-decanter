// Unit tests for config/env loading (lib/config.mts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { loadConfig, loadEnv, parseEnvFile } from "../../lib/config.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-config-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function configDir(cfg: object | string, env?: string): string {
  const dir = path.join(TMP, `cfg-${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "decanter.config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  if (env !== undefined) writeFileSync(path.join(dir, ".env"), env);
  return dir;
}

// loadEnv writes into process.env; keep the credential vars clean per test.
beforeEach(() => {
  delete process.env.N8N_HOST;
  delete process.env.N8N_API_KEY;
});

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, export prefixes, and strips quotes", () => {
    const file = path.join(TMP, ".env-parse");
    writeFileSync(file, [
      "PLAIN=one",
      "export EXPORTED=two",
      'DOUBLE="three three"',
      "SINGLE='four'",
      "  SPACED  =  five  ",
      "# COMMENT=nope",
      "not a var line",
      "",
    ].join("\n"));
    assert.deepEqual(parseEnvFile(file), {
      PLAIN: "one",
      EXPORTED: "two",
      DOUBLE: "three three",
      SINGLE: "four",
      SPACED: "five",
    });
  });

  it("returns an empty object for a missing file", () => {
    assert.deepEqual(parseEnvFile(path.join(TMP, "no-such.env")), {});
  });
});

describe("loadEnv", () => {
  it("never overrides real environment variables", () => {
    const dir = path.join(TMP, "loadenv");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".env"), "DECANTER_TEST_KEEP=from-file\nDECANTER_TEST_NEW=fresh\n");
    process.env.DECANTER_TEST_KEEP = "from-env";
    try {
      loadEnv(dir);
      assert.equal(process.env.DECANTER_TEST_KEEP, "from-env");
      assert.equal(process.env.DECANTER_TEST_NEW, "fresh");
    } finally {
      delete process.env.DECANTER_TEST_KEEP;
      delete process.env.DECANTER_TEST_NEW;
    }
  });
});

describe("loadConfig", () => {
  it("resolves defaults: root, commit flags, browserReload, proxyPort", () => {
    const dir = configDir({}, "N8N_HOST=http://localhost:5678\nN8N_API_KEY=k\n");
    const cfg = loadConfig(dir);
    assert.equal(cfg.configDir, dir);
    assert.equal(cfg.root, path.join(dir, "workflows"));
    assert.deepEqual(cfg.workflows, []);
    assert.equal(cfg.commitOnPush, true);
    assert.equal(cfg.commitOnPull, true);
    assert.equal(cfg.browserReload, "off");
    assert.equal(cfg.proxyPort, 5679);
    assert.equal(cfg.host, "http://localhost:5678");
    assert.equal(cfg.apiKey, "k");
  });

  it("honors explicit settings and strips trailing slashes off the host", () => {
    const dir = configDir(
      { root: "./flows", workflows: ["a", "b"], commitOnPush: false, browserReload: "proxy", proxyPort: 7000 },
      "N8N_HOST=http://localhost:5678///\nN8N_API_KEY=k\n",
    );
    const cfg = loadConfig(dir);
    assert.equal(cfg.root, path.join(dir, "flows"));
    assert.deepEqual(cfg.workflows, ["a", "b"]);
    assert.equal(cfg.commitOnPush, false);
    assert.equal(cfg.commitOnPull, true);
    assert.equal(cfg.browserReload, "proxy");
    assert.equal(cfg.proxyPort, 7000);
    assert.equal(cfg.host, "http://localhost:5678");
  });

  it("searches upward and stops at the first config", () => {
    const outer = configDir({ root: "./outer-root" }, "N8N_HOST=http://outer\nN8N_API_KEY=k\n");
    const inner = path.join(outer, "nested", "deeper");
    mkdirSync(inner, { recursive: true });
    writeFileSync(path.join(outer, "nested", "decanter.config.json"), JSON.stringify({ root: "./inner-root" }));
    writeFileSync(path.join(outer, "nested", ".env"), "N8N_HOST=http://inner\nN8N_API_KEY=k\n");
    const cfg = loadConfig(inner);
    assert.equal(cfg.configDir, path.join(outer, "nested"));
    assert.equal(cfg.root, path.join(outer, "nested", "inner-root"));
    assert.equal(cfg.host, "http://inner");
  });

  it("prefers real environment variables over .env", () => {
    const dir = configDir({}, "N8N_HOST=http://from-file\nN8N_API_KEY=file-key\n");
    process.env.N8N_HOST = "http://from-env";
    const cfg = loadConfig(dir);
    assert.equal(cfg.host, "http://from-env");
    assert.equal(cfg.apiKey, "file-key");
  });

  it("errors when the config is missing anywhere up the tree", () => {
    const dir = path.join(TMP, "no-config", "deep");
    mkdirSync(dir, { recursive: true });
    assert.throws(() => loadConfig(dir), /decanter\.config\.json not found \(searched from .* upward\)/);
  });

  it("errors on malformed config JSON, naming the file", () => {
    const dir = configDir("{ not json");
    assert.throws(() => loadConfig(dir), (err: Error) => {
      assert.match(err.message, /decanter\.config\.json: invalid JSON \(/);
      assert.ok(err.message.includes(dir), "message names the offending file");
      return true;
    });
  });

  it("requires credentials unless requireCredentials is false", () => {
    const dir = configDir({});
    assert.throws(() => loadConfig(dir), /N8N_HOST and N8N_API_KEY must be set/);
    const cfg = loadConfig(dir, { requireCredentials: false });
    assert.equal(cfg.host, "");
    assert.equal(cfg.apiKey, "");
  });
});
