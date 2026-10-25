// Unit tests for the node compiler (lib/compile.mts) — the plans/14 bundling
// path and, critically, the byte-identity of the no-import fast path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { transform } from "esbuild";
import { checkNodeImports, compileNode, findBundleContext, isManagedSource, localBody, scanNodeImports } from "../../lib/compile.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-compile-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** A minimal sync dir: config + shared helper + one workflow code dir. */
function makeSyncDir(name: string, config: object = {}): { root: string; codeDir: string } {
  const root = path.join(TMP, name);
  const codeDir = path.join(root, "workflows", "WF", "code");
  mkdirSync(codeDir, { recursive: true });
  mkdirSync(path.join(root, "shared"), { recursive: true });
  writeFileSync(path.join(root, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: [], ...config }));
  writeFileSync(
    path.join(root, "shared", "money.ts"),
    "export interface Line { qty: number; price: number }\nexport function total(lines: Line[]): number {\n  return lines.reduce((s, l) => s + l.qty * l.price, 0);\n}\n",
  );
  return { root, codeDir };
}

describe("scanNodeImports", () => {
  it("returns an empty block for import-free source", () => {
    const r = scanNodeImports("const a = 1;\nreturn [];\n");
    assert.equal(r.importBlock, "");
    assert.deepEqual(r.specifiers, []);
    assert.equal(r.importLines, 0);
  });

  it("collects specifiers across forms, leaves the body verbatim", () => {
    const src = '// leading comment\nimport def from "./a";\nimport { b,\n  c as d } from "../b";\nimport type { T } from "./t";\nimport "./side";\nconst x = 1;\nreturn [x];\n';
    const r = scanNodeImports(src);
    assert.deepEqual(r.specifiers, ["./a", "../b", "./t", "./side"]);
    assert.equal(r.body, "\nconst x = 1;\nreturn [x];\n");
    assert.equal(r.importBlock + r.body, src, "split is lossless");
    assert.equal(r.importLines, 6);
  });

  it("does not treat dynamic import, import.meta, or identifiers as declarations", () => {
    assert.deepEqual(scanNodeImports('import("./x");\nreturn [];\n').specifiers, []);
    assert.deepEqual(scanNodeImports("import.meta.url;\nreturn [];\n").specifiers, []);
    assert.deepEqual(scanNodeImports("importantThing();\nreturn [];\n").specifiers, []);
  });

  it("counts partial last lines (no trailing newline) as occupied", () => {
    const r = scanNodeImports('import x from "./a"');
    assert.equal(r.importLines, 1);
    assert.equal(r.body, "");
  });
});

describe("checkNodeImports", () => {
  const ctx = { syncRoot: "/sync", bundleDependencies: ["tiny-add", "@scope/pkg"] };
  const file = "/sync/workflows/WF/code/node.ts";

  it("blocks builtins and unlisted packages; escapes and absolute paths are advisory (Plan 79 task 7)", () => {
    assert.match(checkNodeImports(file, ["node:crypto"], ctx).blocking[0], /builtin/);
    assert.match(checkNodeImports(file, ["fs/promises"], ctx).blocking[0], /builtin/);
    assert.match(checkNodeImports(file, ["lodash"], ctx).blocking[0], /bundleDependencies/);
    const abs = checkNodeImports(file, ["/etc/x"], ctx);
    assert.match(abs.advisory[0], /absolute/);
    assert.deepEqual(abs.blocking, [], "an absolute path must not block");
    const escaped = checkNodeImports(file, ["../../../../outside"], ctx);
    assert.match(escaped.advisory[0], /outside the sync dir/);
    assert.deepEqual(escaped.blocking, [], "a sync-dir escape must not block");
  });

  it("accepts contained relatives and allowlisted packages (incl. scoped subpaths)", () => {
    assert.deepEqual(checkNodeImports(file, ["../../../shared/money", "./sibling", "tiny-add", "@scope/pkg/sub"], ctx), { blocking: [], advisory: [] });
  });

  it("skips containment when no sync root is in reach", () => {
    assert.deepEqual(checkNodeImports(file, ["../../anywhere"], { syncRoot: null, bundleDependencies: [] }), { blocking: [], advisory: [] });
  });
});

describe("compileNode", () => {
  it("fast path: no-import output is byte-identical to a plain esbuild transform", async () => {
    const { codeDir } = makeSyncDir("fast");
    const src = "interface Row { id: number }\nconst rows: Row[] = [];\nreturn rows;\n";
    const file = path.join(codeDir, "plain.ts");
    writeFileSync(file, src);
    const direct = await transform(src, { loader: "ts", format: "cjs", target: "node18", sourcefile: file });
    const expected = direct.code.endsWith("\n") ? direct.code : direct.code + "\n";
    assert.equal(await compileNode(file), expected);
  });

  it("bundles a shared import into an executable function body, deterministically", async () => {
    const { codeDir } = makeSyncDir("bundle");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(
      file,
      'import { total, type Line } from "../../../shared/money";\nconst lines: Line[] = $input.all().map((i: any) => i.json);\nreturn [{ json: { total: total(lines) } }];\n',
    );
    const code = await compileNode(file);
    assert.match(code, /function total/, "helper inlined");
    assert.match(code, /shared\/money\.ts/, "sync-root-relative module label");
    assert.match(code, /return __n8n_node\.default\(\);\n$/, "re-enter footer keeps it a function body");
    assert.match(code, /\n {2}\/\/ workflows\/WF\/code\/node\.ts\n/, "a .ts entry keeps its node.ts label");
    // Golden: sha256 of compileTs's bundle output for exactly this fixture,
    // captured 2026-10-25 from main @ 291b3a3 (Plan 24 phase 0). A .ts node's
    // compiled bytes are its marker hash, so any drift here reads as a code
    // change on every bundled .ts node in every user's project.
    assert.equal(
      createHash("sha256").update(code).digest("hex"),
      "97cf7b5750729a5a572ff779d0e7ca723e3ce3151e58a034037c078234ab44aa",
      "a .ts bundle must stay byte-identical to the pre-Plan-24 compiler",
    );
    assert.equal(await compileNode(file), code, "deterministic");
    const $input = { all: () => [{ json: { qty: 2, price: 10 } }, { json: { qty: 1, price: 5 } }] };
    const out = await new AsyncFunction("$input", code)($input);
    assert.deepEqual(out, [{ json: { total: 25 } }]);
  });

  it("bundled output is rename-stable: the same source under a different filename compiles byte-identically", async () => {
    // Regression: esbuild labels every bundled module with a `// <path>`
    // comment, and the entry used to be labelled with the node's own filename.
    // That put the filename inside the compiled bytes -> inside the
    // `@ts-n8n sha256:` marker, so a pure remote rename (which makes `pull`
    // rename the local .ts) left the node reading "push pending" on a
    // comment-only diff. Only the smoke suite caught it, and that runs on
    // release PRs alone.
    const { codeDir } = makeSyncDir("rename");
    const src = 'import { total, type Line } from "../../../shared/money";\nconst lines: Line[] = $input.all().map((i: any) => i.json);\nreturn [{ json: { total: total(lines) } }];\n';
    const before = path.join(codeDir, "compute.ts");
    writeFileSync(before, src);
    const compiledBefore = await compileNode(before);

    // exactly what `pull` does when the node is renamed in n8n — same dir,
    // same bytes, new name (unicode, as the smoke suite renames it)
    const after = path.join(codeDir, "ümläut-nödé.ts");
    writeFileSync(after, src);
    const compiledAfter = await compileNode(after);

    assert.equal(compiledAfter, compiledBefore, "a rename must not change the compiled artifact");
    assert.doesNotMatch(compiledBefore, /compute\.ts/, "the node filename must not leak into the bundle");
    assert.doesNotMatch(compiledAfter, /ümläut-nödé\.ts/, "the node filename must not leak into the bundle");
  });

  it("pure type-only imports bundle to an executable body with nothing inlined", async () => {
    const { codeDir } = makeSyncDir("typeonly");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import type { Line } from "../../../shared/money";\nconst l: Line[] = [];\nreturn [{ json: { n: l.length } }];\n');
    const code = await compileNode(file);
    assert.doesNotMatch(code, /function total/, "no runtime code pulled in");
    assert.match(code, /return __n8n_node\.default\(\);\n$/);
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { n: 0 } }]);
  });

  it("bundles an allowlisted npm package from node_modules", async () => {
    const { root, codeDir } = makeSyncDir("npm", { bundleDependencies: ["tiny-add"] });
    const pkg = path.join(root, "node_modules", "tiny-add");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "tiny-add", version: "1.0.0", main: "index.js" }));
    writeFileSync(path.join(pkg, "index.js"), "exports.add = (a, b) => a + b;\n");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import { add } from "tiny-add";\nreturn [{ json: { n: add(20, 22) } }];\n');
    const code = await compileNode(file);
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { n: 42 } }]);
  });

  it("rejects unlisted packages and builtins with the guard message", async () => {
    const { codeDir } = makeSyncDir("reject");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import x from "lodash";\nreturn [x];\n');
    await assert.rejects(() => compileNode(file), /bundleDependencies/);
    writeFileSync(file, 'import { createHash } from "node:crypto";\nreturn [];\n');
    await assert.rejects(() => compileNode(file), /builtin/);
  });

  it("compiles byte-identically through a symlinked sync-dir path (Plan 79 task 4)", async () => {
    // esbuild resolves bundled modules to their REALPATHS; without realpathing
    // the label base too, a symlink anywhere in the sync dir's own path (macOS
    // /tmp, a symlinked checkout) yields machine-specific `../…`-climbing
    // module labels inside the hashed bytes — cross-machine "push pending"
    // ping-pong with nobody touching code.
    const { root, codeDir } = makeSyncDir("realpath");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(
      file,
      'import { total, type Line } from "../../../shared/money";\nconst lines: Line[] = [];\nreturn [{ json: { total: total(lines) } }];\n',
    );
    const direct = await compileNode(file);
    const alias = path.join(TMP, "realpath-alias");
    symlinkSync(root, alias, "dir");
    const viaAlias = await compileNode(path.join(alias, "workflows", "WF", "code", "node.ts"));
    assert.equal(viaAlias, direct, "a symlinked path to the sync dir must not change the compiled bytes");
    assert.match(viaAlias, /\/\/ shared\/money\.ts/, "labels stay sync-root-relative");
    assert.doesNotMatch(viaAlias, /\/\/ \.\.\//, "no ..-climbing module labels");
  });

  it("a sync-dir escape warns and still bundles; the push paths can silence the repeat (Plan 79 task 7)", async () => {
    const { codeDir } = makeSyncDir("escape");
    // the escape target lives NEXT TO the sync dir — outside it
    const outside = path.join(TMP, "escape-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "vat.ts"), "export const VAT = 0.19;\n");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import { VAT } from "../../../../escape-outside/vat";\nreturn [{ json: { vat: VAT } }];\n');
    const warned: string[] = [];
    const log = { info() {}, ok() {}, warn: (m: string) => warned.push(m), error() {} };
    const code = await compileNode(file, log as never);
    assert.equal(warned.filter((w) => /outside the sync dir/.test(w)).length, 1, "advisory, exactly once");
    assert.match(code, /0\.19/, "the escape target still bundles");
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { vat: 0.19 } }]);
    // the guard-owning callers silence the compile-time repeat
    warned.length = 0;
    await compileNode(file, log as never, { quietImportWarnings: true });
    assert.deepEqual(warned, [], "quietImportWarnings must suppress the advisory channel");
    // and a genuinely missing target still fails loudly, advisory or not
    writeFileSync(file, 'import { X } from "../../../../escape-nowhere/x";\nreturn [X];\n');
    await assert.rejects(() => compileNode(file), /bundling failed/);
  });

  it("guard and bundler agree when a symlink sits BETWEEN the sync root and the node file", async () => {
    // The other symlink direction: workflows/ itself points out of the sync
    // dir's real tree. The import guard approves ../../../shared/money in the
    // SPELLED space, so the bundler must resolve it there too — realpathing
    // resolveDir made esbuild resolve from the symlink target and disagree
    // with the guard (failing, or worse, silently bundling a sibling
    // checkout's file). Only the LABEL base may be realpathed.
    const root = path.join(TMP, "midlink");
    mkdirSync(path.join(root, "shared"), { recursive: true });
    writeFileSync(path.join(root, "decanter.config.json"), JSON.stringify({ root: "./workflows", workflows: [] }));
    writeFileSync(
      path.join(root, "shared", "money.ts"),
      "export function total(l: { qty: number; price: number }[]): number {\n  return l.reduce((s, x) => s + x.qty * x.price, 0);\n}\n",
    );
    const realWfs = path.join(TMP, "midlink-wfs-real");
    mkdirSync(path.join(realWfs, "WF", "code"), { recursive: true });
    symlinkSync(realWfs, path.join(root, "workflows"), "dir");
    const file = path.join(root, "workflows", "WF", "code", "node.ts");
    writeFileSync(file, 'import { total } from "../../../shared/money";\nreturn [{ json: { t: total([{ qty: 2, price: 3 }]) } }];\n');
    const code = await compileNode(file);
    assert.match(code, /function total/, "the guard-approved helper is what gets bundled");
    assert.match(code, /\/\/ shared\/money\.ts/, "label stays sync-root-relative");
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { t: 6 } }]);
  });

  it("surfaces esbuild resolution failures with the node file named", async () => {
    const { codeDir } = makeSyncDir("missing");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import { nope } from "./does-not-exist";\nreturn [nope];\n');
    await assert.rejects(() => compileNode(file), /bundling failed/);
  });
});

// Plan 24: a .js node that imports is bundled exactly like a .ts node.
// "Managed" is the one predicate push, pull, status, run and diff share, so
// what counts as an import here decides which tier a .js file lands in.
describe("isManagedSource", () => {
  it("a .ts path is managed without reading the file", () => {
    assert.equal(isManagedSource(path.join(TMP, "never-written", "node.ts")), true);
  });

  it("a .js file with a top-level static import is managed", () => {
    const { codeDir } = makeSyncDir("managed-js");
    const file = path.join(codeDir, "node.js");
    writeFileSync(file, 'import { total } from "../../../shared/money";\nreturn [{ json: { t: total([]) } }];\n');
    assert.equal(isManagedSource(file), true);
  });

  it("a .js file without a static import declaration stays verbatim", () => {
    const { codeDir } = makeSyncDir("verbatim-js");
    const cases: Record<string, string> = {
      // editor-only type: the scanner stops at the first statement, and a
      // JSDoc comment is never a declaration
      "jsdoc-type.js": "/** @typedef {import('../shared/x').Y} Y */\nconst y = 1;\nreturn [{ json: { y } }];\n",
      "dynamic.js": 'const m = await import("../../../shared/money");\nreturn [{ json: { m: typeof m } }];\n',
      "line-comment.js": '// import { total } from "../../../shared/money";\nreturn [];\n',
      "block-comment.js": '/* import { total } from "../../../shared/money"; */\nreturn [];\n',
      "plain.js": "const a = 1;\nreturn [{ json: { a } }];\n",
      // a line-anchored regex would take each of these for a declaration
      "mid-file.js": 'const x = 1;\nimport y from "./y";\nreturn [x];\n',
      "dynamic-top.js": 'import("../../../shared/money").then((m) => m.total([]));\nreturn [];\n',
      "import-meta.js": "import.meta.url;\nreturn [];\n",
      "multiline-comment.js": '/*\nimport { a } from "./a";\n*/\nconst b = 1;\nreturn [{ json: { b } }];\n',
    };
    for (const [name, src] of Object.entries(cases)) {
      const file = path.join(codeDir, name);
      writeFileSync(file, src);
      assert.equal(isManagedSource(file), false, name);
    }
  });

  it("a missing .js file is not managed, and does not throw", () => {
    assert.equal(isManagedSource(path.join(TMP, "never-written", "node.js")), false);
  });

  it("any other extension is not managed", () => {
    const { codeDir } = makeSyncDir("other-ext");
    const file = path.join(codeDir, "node.py");
    writeFileSync(file, 'import { total } from "../../../shared/money";\n');
    assert.equal(isManagedSource(file), false);
  });
});

describe("compileNode — a .js entry", () => {
  const JS_SRC = 'import { total } from "../../../shared/money";\nconst lines = $input.all().map((i) => i.json);\nreturn [{ json: { total: total(lines) } }];\n';

  it("bundles a shared helper into an executable function body", async () => {
    const { codeDir } = makeSyncDir("js-bundle");
    const file = path.join(codeDir, "node.js");
    writeFileSync(file, JS_SRC);
    const code = await compileNode(file);
    assert.match(code, /function total/, "helper inlined");
    assert.match(code, /\/\/ shared\/money\.ts/, "sync-root-relative module label");
    assert.match(code, /return __n8n_node\.default\(\);\n$/, "re-enter footer keeps it a function body");
    const $input = { all: () => [{ json: { qty: 2, price: 10 } }, { json: { qty: 1, price: 5 } }] };
    const out = await new AsyncFunction("$input", code)($input);
    assert.deepEqual(out, [{ json: { total: 25 } }]);
  });

  it("is byte-identical across two sync dirs at different paths", async () => {
    const a = makeSyncDir("js-det-a");
    const b = makeSyncDir(path.join("js-det-b", "somewhere", "deeper"));
    writeFileSync(path.join(a.codeDir, "node.js"), JS_SRC);
    writeFileSync(path.join(b.codeDir, "node.js"), JS_SRC);
    const codeA = await compileNode(path.join(a.codeDir, "node.js"));
    const codeB = await compileNode(path.join(b.codeDir, "node.js"));
    assert.equal(codeA, codeB, "no absolute path may leak into the bundle");
    assert.equal(await compileNode(path.join(a.codeDir, "node.js")), codeA, "deterministic");
  });

  it("labels the entry node.js, whatever the file is called", async () => {
    const { codeDir } = makeSyncDir("js-rename");
    const before = path.join(codeDir, "compute.js");
    const after = path.join(codeDir, "ümläut-nödé.js");
    writeFileSync(before, JS_SRC);
    writeFileSync(after, JS_SRC);
    const compiledBefore = await compileNode(before);
    assert.equal(await compileNode(after), compiledBefore, "a rename must not change the compiled artifact");
    assert.match(compiledBefore, /\/\/ workflows\/WF\/code\/node\.js\n/, "fixed .js entry label");
    assert.doesNotMatch(compiledBefore, /node\.ts|compute\.js/, "neither the .ts label nor the real filename");
  });

  it("parses a .js entry as JavaScript, not TypeScript", async () => {
    // the loader follows the extension: a type annotation is a syntax error
    // in a .js file, in the bundle branch and the no-import branch alike
    const { codeDir } = makeSyncDir("js-loader");
    const bundled = path.join(codeDir, "bundled.js");
    writeFileSync(bundled, 'import { total } from "../../../shared/money";\nconst n: number = total([]);\nreturn [{ json: { n } }];\n');
    await assert.rejects(() => compileNode(bundled));
    const plain = path.join(codeDir, "plain.js");
    writeFileSync(plain, "const n: number = 1;\nreturn [{ json: { n } }];\n");
    await assert.rejects(() => compileNode(plain));
  });

  it("no-import .js output is a plain esbuild js transform", async () => {
    const { codeDir } = makeSyncDir("js-fast");
    const src = "const rows = [];\nreturn rows;\n";
    const file = path.join(codeDir, "plain.js");
    writeFileSync(file, src);
    const direct = await transform(src, { loader: "js", format: "cjs", target: "node18", sourcefile: file });
    const expected = direct.code.endsWith("\n") ? direct.code : direct.code + "\n";
    assert.equal(await compileNode(file), expected);
  });

  it("applies the same import checks as a .ts entry", async () => {
    const { codeDir } = makeSyncDir("js-guard");
    const file = path.join(codeDir, "node.js");
    writeFileSync(file, 'import x from "lodash";\nreturn [x];\n');
    await assert.rejects(() => compileNode(file), /bundleDependencies/);
    writeFileSync(file, 'import { createHash } from "node:crypto";\nreturn [];\n');
    await assert.rejects(() => compileNode(file), /builtin/);
  });
});

describe("localBody", () => {
  it("returns null for a missing file", async () => {
    const { codeDir } = makeSyncDir("lb-missing");
    assert.equal(await localBody(codeDir, "nope.js"), null);
  });

  it("returns a no-import .js file's raw bytes exactly", async () => {
    const { codeDir } = makeSyncDir("lb-raw");
    // no trailing newline, CRLF and a non-ASCII literal: a compile would
    // normalise all three, so only an untouched read survives this
    const src = 'const t = "kompatibilní s";\r\nreturn [{ json: { t } }];';
    writeFileSync(path.join(codeDir, "plain.js"), src);
    assert.equal(await localBody(codeDir, "plain.js"), src);
  });

  it("returns an importing .js file's compiled bundle", async () => {
    const { codeDir } = makeSyncDir("lb-bundle");
    writeFileSync(path.join(codeDir, "node.js"), 'import { total } from "../../../shared/money";\nreturn [{ json: { t: total([]) } }];\n');
    const body = await localBody(codeDir, "node.js");
    assert.equal(body, await compileNode(path.join(codeDir, "node.js")));
    assert.notEqual(body, readFileSync(path.join(codeDir, "node.js"), "utf8"));
  });

  it("returns a .ts file's compiled output", async () => {
    const { codeDir } = makeSyncDir("lb-ts");
    writeFileSync(path.join(codeDir, "node.ts"), "const n: number = 1;\nreturn [{ json: { n } }];\n");
    assert.equal(await localBody(codeDir, "node.ts"), await compileNode(path.join(codeDir, "node.ts")));
  });
});

describe("findBundleContext", () => {
  it("finds the nearest config upward and reads the allowlist", () => {
    const { codeDir } = makeSyncDir("ctx", { bundleDependencies: ["zod"] });
    const ctx = findBundleContext(codeDir);
    assert.ok(ctx.syncRoot !== null && codeDir.startsWith(ctx.syncRoot));
    assert.deepEqual(ctx.bundleDependencies, ["zod"]);
  });

  it("returns a null root when nothing is in reach", () => {
    const ctx = findBundleContext(os.tmpdir());
    assert.equal(ctx.syncRoot, null);
  });
});
