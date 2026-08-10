// Unit tests for the node compiler (lib/compile.mts) — the plans/14 bundling
// path and, critically, the byte-identity of the no-import fast path.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { transform } from "esbuild";
import { checkNodeImports, compileTs, findBundleContext, scanNodeImports } from "../../lib/compile.mts";

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
    const escape = checkNodeImports(file, ["../../../../outside"], ctx);
    assert.match(escape.advisory[0], /outside the sync dir/);
    assert.deepEqual(escape.blocking, [], "a sync-dir escape must not block");
  });

  it("accepts contained relatives and allowlisted packages (incl. scoped subpaths)", () => {
    assert.deepEqual(checkNodeImports(file, ["../../../shared/money", "./sibling", "tiny-add", "@scope/pkg/sub"], ctx), { blocking: [], advisory: [] });
  });

  it("skips containment when no sync root is in reach", () => {
    assert.deepEqual(checkNodeImports(file, ["../../anywhere"], { syncRoot: null, bundleDependencies: [] }), { blocking: [], advisory: [] });
  });
});

describe("compileTs", () => {
  it("fast path: no-import output is byte-identical to a plain esbuild transform", async () => {
    const { codeDir } = makeSyncDir("fast");
    const src = "interface Row { id: number }\nconst rows: Row[] = [];\nreturn rows;\n";
    const file = path.join(codeDir, "plain.ts");
    writeFileSync(file, src);
    const direct = await transform(src, { loader: "ts", format: "cjs", target: "node18", sourcefile: file });
    const expected = direct.code.endsWith("\n") ? direct.code : direct.code + "\n";
    assert.equal(await compileTs(file), expected);
  });

  it("bundles a shared import into an executable function body, deterministically", async () => {
    const { codeDir } = makeSyncDir("bundle");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(
      file,
      'import { total, type Line } from "../../../shared/money";\nconst lines: Line[] = $input.all().map((i: any) => i.json);\nreturn [{ json: { total: total(lines) } }];\n',
    );
    const code = await compileTs(file);
    assert.match(code, /function total/, "helper inlined");
    assert.match(code, /shared\/money\.ts/, "sync-root-relative module label");
    assert.match(code, /return __n8n_node\.default\(\);\n$/, "re-enter footer keeps it a function body");
    assert.equal(await compileTs(file), code, "deterministic");
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
    const compiledBefore = await compileTs(before);

    // exactly what `pull` does when the node is renamed in n8n — same dir,
    // same bytes, new name (unicode, as the smoke suite renames it)
    const after = path.join(codeDir, "ümläut-nödé.ts");
    writeFileSync(after, src);
    const compiledAfter = await compileTs(after);

    assert.equal(compiledAfter, compiledBefore, "a rename must not change the compiled artifact");
    assert.doesNotMatch(compiledBefore, /compute\.ts/, "the node filename must not leak into the bundle");
    assert.doesNotMatch(compiledAfter, /ümläut-nödé\.ts/, "the node filename must not leak into the bundle");
  });

  it("pure type-only imports bundle to an executable body with nothing inlined", async () => {
    const { codeDir } = makeSyncDir("typeonly");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import type { Line } from "../../../shared/money";\nconst l: Line[] = [];\nreturn [{ json: { n: l.length } }];\n');
    const code = await compileTs(file);
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
    const code = await compileTs(file);
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { n: 42 } }]);
  });

  it("rejects unlisted packages and builtins with the guard message", async () => {
    const { codeDir } = makeSyncDir("reject");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import x from "lodash";\nreturn [x];\n');
    await assert.rejects(() => compileTs(file), /bundleDependencies/);
    writeFileSync(file, 'import { createHash } from "node:crypto";\nreturn [];\n');
    await assert.rejects(() => compileTs(file), /builtin/);
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
    const direct = await compileTs(file);
    const alias = path.join(TMP, "realpath-alias");
    symlinkSync(root, alias, "dir");
    const viaAlias = await compileTs(path.join(alias, "workflows", "WF", "code", "node.ts"));
    assert.equal(viaAlias, direct, "a symlinked path to the sync dir must not change the compiled bytes");
    assert.match(viaAlias, /\/\/ shared\/money\.ts/, "labels stay sync-root-relative");
    assert.doesNotMatch(viaAlias, /\/\/ \.\.\//, "no ..-climbing module labels");
  });

  it("a sync-dir escape warns and still bundles; the push paths can silence the repeat (Plan 79 task 7)", async () => {
    const { root, codeDir } = makeSyncDir("escape");
    // the escape target lives NEXT TO the sync dir — outside it
    const outside = path.join(TMP, "escape-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "vat.ts"), "export const VAT = 0.19;\n");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import { VAT } from "../../../../escape-outside/vat";\nreturn [{ json: { vat: VAT } }];\n');
    const warned: string[] = [];
    const log = { info() {}, ok() {}, warn: (m: string) => warned.push(m), error() {} };
    const code = await compileTs(file, log as never);
    assert.equal(warned.filter((w) => /outside the sync dir/.test(w)).length, 1, "advisory, exactly once");
    assert.match(code, /0\.19/, "the escape target still bundles");
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { vat: 0.19 } }]);
    // the guard-owning callers silence the compile-time repeat
    warned.length = 0;
    await compileTs(file, log as never, { quietImportWarnings: true });
    assert.deepEqual(warned, [], "quietImportWarnings must suppress the advisory channel");
    // and a genuinely missing target still fails loudly, advisory or not
    writeFileSync(file, 'import { X } from "../../../../escape-nowhere/x";\nreturn [X];\n');
    await assert.rejects(() => compileTs(file), /bundling failed/);
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
    const code = await compileTs(file);
    assert.match(code, /function total/, "the guard-approved helper is what gets bundled");
    assert.match(code, /\/\/ shared\/money\.ts/, "label stays sync-root-relative");
    const out = await new AsyncFunction(code)();
    assert.deepEqual(out, [{ json: { t: 6 } }]);
  });

  it("surfaces esbuild resolution failures with the node file named", async () => {
    const { codeDir } = makeSyncDir("missing");
    const file = path.join(codeDir, "node.ts");
    writeFileSync(file, 'import { nope } from "./does-not-exist";\nreturn [nope];\n');
    await assert.rejects(() => compileTs(file), /bundling failed/);
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
