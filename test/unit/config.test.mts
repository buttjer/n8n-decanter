// Unit tests for config/env loading (lib/config.mts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { HOST_UNSET, loadConfig, loadEnv, parseEnvFile, requireApiKey, resolveSearchStart } from "../../lib/config.mts";

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

/** A sync dir nested under a plain project root — the Plan 81 shape. */
function nestedSyncDir(sub = "flows"): { root: string; sync: string } {
  const root = path.join(TMP, `nest-${seq++}`);
  const sync = path.join(root, sub);
  mkdirSync(sync, { recursive: true });
  writeFileSync(path.join(sync, "decanter.config.json"), JSON.stringify({ root: "./workflows" }));
  writeFileSync(path.join(sync, ".env"), "N8N_HOST=http://nested\n");
  return { root, sync };
}

// loadEnv writes into process.env; keep the credential vars clean per test.
beforeEach(() => {
  delete process.env.N8N_HOST;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_MCP_TOKEN;
  delete process.env.N8N_DECANTER_DIR;
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
  it("resolves defaults: root, commit flags", () => {
    const dir = configDir({}, "N8N_HOST=http://localhost:5678\nN8N_API_KEY=k\n");
    const cfg = loadConfig(dir);
    assert.equal(cfg.configDir, dir);
    assert.equal(cfg.root, path.join(dir, "workflows"));
    assert.deepEqual(cfg.workflows, []);
    assert.equal(cfg.commitOnPush, true);
    assert.equal(cfg.commitOnPull, true);
    assert.equal(cfg.dataTables, true);
    assert.equal(cfg.host, "http://localhost:5678");
    assert.equal(cfg.apiKey, "k");
  });

  it("ignores a stale browserReload/proxyPort (Plan 52 removal) rather than erroring", () => {
    const dir = configDir(
      { browserReload: "proxy", proxyPort: 7000 },
      "N8N_HOST=http://localhost:5678\nN8N_API_KEY=k\n",
    );
    const cfg = loadConfig(dir) as unknown as Record<string, unknown>;
    assert.equal(cfg.browserReload, undefined);
    assert.equal(cfg.proxyPort, undefined);
  });

  it("dataTables defaults on and only false switches it off", () => {
    const on = configDir({}, "N8N_HOST=http://localhost:5678\nN8N_API_KEY=k\n");
    assert.equal(loadConfig(on).dataTables, true);
    const off = configDir({ dataTables: false }, "N8N_HOST=http://localhost:5678\nN8N_API_KEY=k\n");
    assert.equal(loadConfig(off).dataTables, false);
    // any non-false value keeps it on (parsed as `!== false`)
    const explicitOn = configDir({ dataTables: true }, "N8N_HOST=http://localhost:5678\nN8N_API_KEY=k\n");
    assert.equal(loadConfig(explicitOn).dataTables, true);
  });

  it("honors explicit settings and strips trailing slashes off the host", () => {
    const dir = configDir(
      { root: "./flows", workflows: ["a", "b"], commitOnPush: false },
      "N8N_HOST=http://localhost:5678///\nN8N_API_KEY=k\n",
    );
    const cfg = loadConfig(dir);
    assert.equal(cfg.root, path.join(dir, "flows"));
    assert.deepEqual(cfg.workflows, ["a", "b"]);
    assert.equal(cfg.commitOnPush, false);
    assert.equal(cfg.commitOnPull, true);
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
    assert.throws(() => loadConfig(dir), (err: Error) => {
      assert.match(err.message, /decanter\.config\.json not found \(searched from .* upward\)/);
      // The recovery command, not just the diagnosis: a hand-written .env is
      // the usual reason to land here, so the message names the prompt-free
      // init that scaffolds everything else.
      assert.match(err.message, /init \. --host <host-url> --token <mcp-token>/);
      // …and NOT the nested advice: there is nothing below to point at, so
      // `--dir` would be a wild goose chase (Plan 81).
      assert.doesNotMatch(err.message, /--dir/);
      return true;
    });
  });

  // Plan 81: the same "not found" walks out of two different situations, and
  // the advice inverts between them. A sync dir BELOW cwd means the setup is
  // fine and the search merely started too high (an agent launched at the repo
  // root) — sending that user to `init` would scaffold a second sync dir on top
  // of the working one.
  it("the not-found error advises --dir (not init) when a sync dir sits below cwd", () => {
    const { root, sync } = nestedSyncDir();
    assert.throws(() => loadConfig(root), (err: Error) => {
      assert.match(err.message, /decanter\.config\.json not found \(searched from .* upward\)/);
      assert.ok(err.message.includes(sync), "names the sync dir it actually found");
      // `--dir=flows`, not `--dir flows`: the space form refuses to consume a
      // value that is also a verb, so a sync dir named `test/` would make the
      // copy-paste answer with "--dir needs a value".
      assert.match(err.message, /--dir=flows/);
      assert.match(err.message, /N8N_DECANTER_DIR=flows/);
      assert.doesNotMatch(err.message, /n8n-decanter init/, "the sync dir is initialised — init is the wrong advice");
      return true;
    });
  });

  it("the descendant scan skips node_modules and stops short of deep trees", () => {
    const root = path.join(TMP, `nest-${seq++}`);
    // A vendored copy of someone else's sync dir is not this project's, and a
    // depth-4 hit is past the bounded scan — both must fall back to cold-start
    // advice rather than pointing at the wrong (or a very slow) answer.
    for (const buried of [path.join(root, "node_modules", "pkg"), path.join(root, "a", "b", "c", "d")]) {
      mkdirSync(buried, { recursive: true });
      writeFileSync(path.join(buried, "decanter.config.json"), "{}");
    }
    assert.throws(() => loadConfig(root), (err: Error) => {
      assert.match(err.message, /init \. --host <host-url> --token <mcp-token>/);
      assert.doesNotMatch(err.message, /--dir/);
      return true;
    });
  });

  it("errors on malformed config JSON, naming the file", () => {
    const dir = configDir("{ not json");
    assert.throws(() => loadConfig(dir), (err: Error) => {
      assert.match(err.message, /decanter\.config\.json: invalid JSON \(/);
      assert.ok(err.message.includes(dir), "message names the offending file");
      return true;
    });
  });

  it("requires only the host (requireHost); the API key is optional since Plan 32", () => {
    const dir = configDir({});
    assert.throws(() => loadConfig(dir), /N8N_HOST must be set/);
    const cfg = loadConfig(dir, { requireHost: false });
    assert.equal(cfg.host, "");
    assert.equal(cfg.apiKey, "");
    // a host alone satisfies the default load — no API key needed for MCP sync
    const withHost = configDir({}, "N8N_HOST=http://n8n.local\n");
    const cfg2 = loadConfig(withHost);
    assert.equal(cfg2.host, "http://n8n.local");
    assert.equal(cfg2.apiKey, "");
  });

  // Plan 75: a blind agent diagnosed the missing .env in one command and then
  // sent its human to the INTERACTIVE `init`, because the only message it read
  // said what was wrong and not how to fix it without a prompt. This message is
  // the cold-start entry point — it has to carry the flag form.
  it("the missing-host error names the non-interactive init (the cold-start entry point)", () => {
    assert.match(HOST_UNSET, /--host <host-url>/);
    assert.match(HOST_UNSET, /--token <mcp-token>/);
    assert.throws(() => loadConfig(configDir({})), (err: Error) => {
      assert.equal(err.message, HOST_UNSET, "loadConfig throws the shared message, not a private copy");
      return true;
    });
  });

  it("requireApiKey guards the REST-only verbs, naming the verb", () => {
    const dir = configDir({}, "N8N_HOST=http://n8n.local\n");
    const cfg = loadConfig(dir);
    assert.throws(() => requireApiKey(cfg, "executions"), /`executions` uses the n8n public REST API/);
    assert.throws(() => requireApiKey(cfg, "data-tables"), /N8N_API_KEY/);
    const withKey = { ...cfg, apiKey: "k" };
    assert.equal(requireApiKey(withKey, "executions"), withKey, "passes the config through when the key exists");
  });
});

// Plan 81: `--dir` > N8N_DECANTER_DIR > cwd, moving only where the upward
// search BEGINS. The env var is the load-bearing half — every agent's MCP
// server entry has an `env` block, a `cwd` key is not guaranteed.
describe("resolveSearchStart", () => {
  it("falls back to cwd, absolutised", () => {
    const { root } = nestedSyncDir();
    assert.equal(resolveSearchStart(undefined, root, {}), root);
    assert.equal(resolveSearchStart("", root, { N8N_DECANTER_DIR: "" }), root, "empty values count as unset");
  });

  it("resolves a relative N8N_DECANTER_DIR against cwd, so a committed repo-relative value travels", () => {
    const { root, sync } = nestedSyncDir();
    assert.equal(resolveSearchStart(undefined, root, { N8N_DECANTER_DIR: "flows" }), sync);
    assert.equal(resolveSearchStart(undefined, root, { N8N_DECANTER_DIR: "./flows" }), sync);
    assert.equal(resolveSearchStart(undefined, root, { N8N_DECANTER_DIR: sync }), sync, "an absolute value is used as-is");
  });

  it("reads N8N_DECANTER_DIR off process.env by default", () => {
    const { root, sync } = nestedSyncDir();
    process.env.N8N_DECANTER_DIR = "flows";
    try {
      assert.equal(resolveSearchStart(undefined, root), sync);
    } finally {
      delete process.env.N8N_DECANTER_DIR;
    }
  });

  it("--dir beats N8N_DECANTER_DIR", () => {
    const { root, sync } = nestedSyncDir("chosen");
    mkdirSync(path.join(root, "ignored"), { recursive: true });
    assert.equal(resolveSearchStart("chosen", root, { N8N_DECANTER_DIR: "ignored" }), sync);
  });

  it("rejects a path that is not a directory, naming the source that set it", () => {
    const { root } = nestedSyncDir();
    writeFileSync(path.join(root, "a-file"), "");
    // Left alone these walk to the filesystem root and surface as
    // "not found (searched from … upward)" — a message about the wrong problem.
    assert.throws(() => resolveSearchStart("nope", root, {}), /^Error: --dir nope is not a directory/);
    assert.throws(() => resolveSearchStart("a-file", root, {}), /^Error: --dir a-file is not a directory/);
    assert.throws(() => resolveSearchStart(undefined, root, { N8N_DECANTER_DIR: "nope" }), /^Error: N8N_DECANTER_DIR nope is not a directory/);
  });

  it("moves only the START of the search — loadConfig still walks up from there", () => {
    const { root, sync } = nestedSyncDir();
    const deeper = path.join(sync, "workflows", "some-flow", "code");
    mkdirSync(deeper, { recursive: true });
    const fromRoot = loadConfig(resolveSearchStart(undefined, root, { N8N_DECANTER_DIR: "flows" }));
    assert.equal(fromRoot.configDir, sync);
    assert.equal(fromRoot.host, "http://nested", "the sync dir's own .env is read once the dir is found");
    // A dir below the sync dir keeps working: the override sets the origin, the
    // upward walk still does the finding.
    assert.equal(loadConfig(resolveSearchStart("workflows/some-flow/code", sync, {})).configDir, sync);
  });
});
