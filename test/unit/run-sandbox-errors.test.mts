// Plan 31 Task 4 + the JSON hand-off: how errors that ESCAPE a node body look
// at the CLI surface once `node run` is sandboxed by default.
//
// - A removed global or a refused `import()` gets one friendly message that
//   names the thing and points at `--unsafe` (sandboxed mode only).
// - A CommonJS name (`require`, `__dirname`, …) gets its own message in BOTH
//   modes, pointing at `import` — `--unsafe` would not fix it (operator
//   decision 1, 2026-11-03).
// - Every other error keeps today's message.
// - Values JSON refuses (circular, BigInt) name the item, never DataCloneError.
// - A body that never settles must not hang the CLI or exit 0.
//
// Driven through the real CLI as an async subprocess, cwd in a mkdtemp dir —
// never by importing lib/. Escape-vector, reachability and byte-identity
// coverage lives in run-sandbox.test.mts, not here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(PROJECT, "n8n-decanter.mts");
const ROOT = mkdtempSync(path.join(os.tmpdir(), "decanter-runsandbox-errors-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

interface Run {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");

/** Run the CLI; never rejects — the exit code is what the tests assert. */
function cli(cwd: string, args: string[], timeout = 30_000): Promise<Run> {
  const env = { ...process.env };
  delete env.DEBUG; // DEBUG=1 appends a stack, which would change the message lines
  // Colour switches change console formatting; keep the output independent
  // of the environment the suite happens to run in.
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; signal?: string | null }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        signal: e?.signal ?? null,
        stdout: plain(stdout),
        stderr: plain(stderr),
      });
    });
  });
}

let seq = 0;
/** A fresh directory with the given files (relative path → content). */
function workdir(files: Record<string, string>): string {
  const dir = path.join(ROOT, `case-${++seq}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** A workflow.json that puts `file` in runOnceForEachItem mode. */
const perItemWorkflow = (file: string) =>
  JSON.stringify({
    nodes: [
      {
        id: "n1",
        name: "Node",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [0, 0],
        parameters: { mode: "runOnceForEachItem", jsCode: `//@file:${file}` },
      },
    ],
  });

const fixture = (n: number) => JSON.stringify({ input: Array.from({ length: n }, (_, i) => ({ json: { i } })) });

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sandbox message, exactly as the contract words it, as a whole line. */
const sandboxMsg = (name: string) =>
  new RegExp(`^✗ \`${esc(name)}\` is not available in sandboxed \`node run\` — pass \`--unsafe\` to allow host access\\.$`, "m");

/** The CommonJS message, exactly, as a whole line. */
const cjsMsg = (name: string) =>
  new RegExp(
    `^✗ \`${esc(name)}\` is not available in \`node run\` — node files are ES modules: use a top-level \`import\` \\(npm packages need \`bundleDependencies\` in decanter\\.config\\.json\\)\\.$`,
    "m",
  );

const SANDBOX_TEXT = /is not available in sandboxed `node run`/;
const UNSAFE_HINT = /pass `--unsafe`/;

describe("node run: a removed global or a refused import() gets the sandbox message", () => {
  it("uncaught process.env.X names `process`", async () => {
    const dir = workdir({ "n.js": "return [{ json: { x: process.env.X } }];\n" });
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, sandboxMsg("process"));
  });

  it("the same node under --unsafe reads process.env and never prints the sandbox text", async () => {
    const dir = workdir({ "n.js": "return [{ json: { t: typeof process.env.PATH } }];\n" });
    const r = await cli(dir, ["node", "run", "n.js", "--unsafe"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /"t": "string"/);
    assert.doesNotMatch(r.stdout + r.stderr, SANDBOX_TEXT);
  });

  it("uncaught fetch(…) names `fetch`", async () => {
    // Loopback discard port, not a hostname: if fetch were reachable the call
    // fails fast on a refused connection instead of waiting on DNS.
    const dir = workdir({ "n.js": 'await fetch("http://127.0.0.1:9/");\nreturn [];\n' });
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, sandboxMsg("fetch"));
  });

  it("a top-level await import(\"node:fs\") names `import()`", async () => {
    const dir = workdir({ "n.js": 'const fs = await import("node:fs");\nreturn [{ json: { t: typeof fs.readFileSync } }];\n' });
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, sandboxMsg("import()"));
  });
});

describe("node run: CommonJS names get the import message in both modes, without the --unsafe hint", () => {
  // All five names the operator's plan lists, each in both modes — the CLI is
  // ESM, so none of them exists in-process either.
  const cases: Array<[string, string]> = [
    ["require", 'const fs = require("fs");\nreturn [{ json: { t: typeof fs } }];\n'],
    ["module", "module.exports = 1;\nreturn [];\n"],
    ["exports", "exports.x = 1;\nreturn [];\n"],
    ["__dirname", "return [{ json: { d: __dirname } }];\n"],
    ["__filename", "return [{ json: { f: __filename } }];\n"],
  ];
  for (const [name, body] of cases) {
    for (const mode of ["sandboxed", "--unsafe"] as const) {
      it(`${name} (${mode})`, async () => {
        const dir = workdir({ "n.js": body });
        const args = ["node", "run", "n.js", ...(mode === "--unsafe" ? ["--unsafe"] : [])];
        const r = await cli(dir, args);
        assert.equal(r.code, 1, r.stdout + r.stderr);
        assert.match(r.stderr, cjsMsg(name));
        assert.doesNotMatch(r.stdout + r.stderr, UNSAFE_HINT);
        assert.doesNotMatch(r.stdout + r.stderr, SANDBOX_TEXT);
      });
    }
  }
});

describe("node run: every other error keeps its message", () => {
  for (const mode of ["sandboxed", "--unsafe"] as const) {
    it(`an unknown name stays a plain ReferenceError (${mode})`, async () => {
      const dir = workdir({ "n.js": "return [{ json: { v: fooo } }];\n" });
      const r = await cli(dir, ["node", "run", "n.js", ...(mode === "--unsafe" ? ["--unsafe"] : [])]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /^✗ fooo is not defined$/m);
      assert.doesNotMatch(r.stdout + r.stderr, UNSAFE_HINT);
      assert.doesNotMatch(r.stdout + r.stderr, /is not available/);
    });
  }

  it("throw new Error(\"boom\") prints boom", async () => {
    const dir = workdir({ "n.js": 'throw new Error("boom");\n' });
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^✗ boom$/m);
  });

  it("a missing $() fixture keeps its message", async () => {
    const dir = workdir({ "n.js": "return $('Up').all();\n" });
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /node "Up" has no fixture data/);
    assert.doesNotMatch(r.stdout + r.stderr, /is not available/);
  });

  it("a body that catches its own ReferenceError gets the raw message, not the friendly one", async () => {
    // Red today for a different reason than later: today `process` exists, so
    // nothing throws and `msg` is null. Sandboxed, the body must see V8's own
    // text — the mapping applies only to errors that escape the body.
    const dir = workdir({
      "n.js":
        'let msg = null;\ntry { process.env.X; } catch (e) { msg = e instanceof ReferenceError ? e.message : "other: " + e; }\nreturn [{ json: { msg } }];\n',
    });
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /"msg": "process is not defined"/);
    assert.doesNotMatch(r.stdout + r.stderr, SANDBOX_TEXT);
  });
});

describe("node run: an opted-in npm dependency that reads process at load", () => {
  // n8n's JS task runner `require`s an allowlisted external module
  // (NODE_FUNCTION_ALLOW_EXTERNAL) through its require resolver in the
  // runner's HOST realm: the module's own code sees the runner's real
  // `process`, so `process.env.NODE_ENV` at load works there. Only the Code
  // node's vm context lacks `process`. decanter inlines the dependency into
  // the node bundle instead, so the same read runs inside the scrubbed realm
  // and fails — the friendly-error path, by decision (no `process` stub).
  const files = {
    "decanter.config.json": JSON.stringify({ bundleDependencies: ["env-reader"] }),
    "node_modules/env-reader/package.json": JSON.stringify({ name: "env-reader", version: "1.0.0", main: "index.js" }),
    "node_modules/env-reader/index.js": 'const mode = process.env.NODE_ENV || "development";\nexports.mode = () => mode;\n',
    "n.js": 'import { mode } from "env-reader";\nreturn [{ json: { mode: mode() } }];\n',
  };

  it("sandboxed: the sandbox message names `process`", async () => {
    const dir = workdir(files);
    const r = await cli(dir, ["node", "run", "n.js"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, sandboxMsg("process"));
  });

  it("--unsafe: the bundle runs (positive control for the fixture)", async () => {
    const dir = workdir(files);
    const r = await cli(dir, ["node", "run", "n.js", "--unsafe"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /"mode": "/);
  });
});

describe("node run: values JSON refuses name the item", () => {
  /** `notIndex`: the index a wrong implementation would report instead. */
  const assertNamesItem = (r: Run, index: number, notIndex?: number) => {
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, new RegExp(`\\bitem ${index}\\b`));
    if (notIndex !== undefined) assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`\\bitem ${notIndex}\\b`));
    assert.doesNotMatch(r.stdout + r.stderr, /DataCloneError/);
  };

  it("all-items: a circular item at index 1", async () => {
    const dir = workdir({
      "n.js": "const o = { json: {} };\no.json.self = o;\nreturn [{ json: { ok: 1 } }, o];\n",
    });
    assertNamesItem(await cli(dir, ["node", "run", "n.js"]), 1);
  });

  it("all-items: a BigInt field at index 2", async () => {
    const dir = workdir({ "n.js": "return [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { big: 10n } }];\n" });
    assertNamesItem(await cli(dir, ["node", "run", "n.js"]), 2);
  });

  // Per-item: input item 0 returns undefined and is dropped, so the input
  // index differs from the index in the collected output. The contract names
  // the INPUT index; a worker that serializes the collected array at the end
  // and reports that array's index fails here.
  it("per-item: a circular return for input item 2 (output index 1)", async () => {
    const dir = workdir({
      "workflow.json": perItemWorkflow("n.js"),
      "fx.json": fixture(3),
      "n.js":
        "if ($itemIndex === 0) return undefined;\nif ($itemIndex === 2) { const o = {}; o.self = o; return { json: o }; }\nreturn { json: { i: $itemIndex } };\n",
    });
    assertNamesItem(await cli(dir, ["node", "run", "n.js", "fx.json"]), 2, 1);
  });

  it("per-item: a BigInt field for input item 1 (output index 0)", async () => {
    const dir = workdir({
      "workflow.json": perItemWorkflow("n.js"),
      "fx.json": fixture(3),
      "n.js": "if ($itemIndex === 0) return undefined;\nif ($itemIndex === 1) return { json: { big: 10n } };\nreturn { json: { i: $itemIndex } };\n",
    });
    assertNamesItem(await cli(dir, ["node", "run", "n.js", "fx.json"]), 1, 0);
  });
});

describe("node run: a body that never settles", () => {
  it("terminates with exit 1 and says the node never returned", async () => {
    const dir = workdir({ "n.js": "await new Promise(() => {});\nreturn [];\n" });
    const r = await cli(dir, ["node", "run", "n.js"], 15_000);
    assert.equal(r.signal, null, "the CLI must exit on its own, not be killed by the test timeout");
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /never returned/);
  });

  it("an error thrown outside the body's promise (a worker error event) is reported, not swallowed", async () => {
    // Green today: in-process, the uncaught throw crashes the CLI with exit 1.
    // Sandboxed, it surfaces as the worker's `error` event, which must not be
    // dropped in favour of the never-returned path or an exit 0.
    const dir = workdir({ "n.js": 'setTimeout(() => { throw new Error("late-boom"); });\nawait new Promise(() => {});\nreturn [];\n' });
    const r = await cli(dir, ["node", "run", "n.js"], 15_000);
    assert.equal(r.signal, null, "the CLI must exit on its own, not be killed by the test timeout");
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /late-boom/);
  });
});
