// Unit tests for template/decanter-ts-plugin — the editor-only language-service
// plugin that hides false TS1108/TS1375/TS1378 on n8n node files. The plugin is
// CommonJS and ships as an inert .example in template/, so it is copied to a
// temp dir as index.js and require()d from there.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type PluginFactory = (mod: { typescript: typeof ts }) => {
  create(info: {
    languageService: ts.LanguageService;
    languageServiceHost: Partial<ts.LanguageServiceHost>;
  }): ts.LanguageService;
};

const TEMPLATE_PLUGIN = fileURLToPath(
  new URL("../../template/decanter-ts-plugin/index.js.example", import.meta.url),
);
const tmp = mkdtempSync(path.join(tmpdir(), "decanter-ts-plugin-"));
copyFileSync(TEMPLATE_PLUGIN, path.join(tmp, "index.js"));
const init = createRequire(import.meta.url)(path.join(tmp, "index.js")) as PluginFactory;

const FILTERED = [1108, 1375, 1378];
const codes = (diags: readonly ts.Diagnostic[]): number[] => diags.map((d) => d.code).sort();

describe("decanter-ts-plugin: recognition and filtering (stub language service)", () => {
  const CANNED = [1108, 1375, 1378, 2322].map((code) => ({ code }) as ts.Diagnostic);

  const proxyOver = (existingFiles: Iterable<string>) => {
    const existing = new Set(existingFiles);
    const stub = {
      getSemanticDiagnostics: () => [...CANNED],
      getSyntacticDiagnostics: () => [...CANNED],
      getQuickInfoAtPosition: (fileName: string, position: number) => ({ fileName, position }),
    } as unknown as ts.LanguageService;
    return init({ typescript: ts }).create({
      languageService: stub,
      languageServiceHost: { fileExists: (p) => existing.has(p) },
    });
  };

  it("filters 1108/1375/1378 for code/-layout node files (state file in the parent)", () => {
    const proxy = proxyOver(["/ws/wf/.decanter.json"]);
    assert.deepEqual(codes(proxy.getSemanticDiagnostics("/ws/wf/code/parse-order.js")), [2322]);
    assert.deepEqual(codes(proxy.getSyntacticDiagnostics("/ws/wf/code/parse-order.js")), [2322]);
  });

  it("filters for flat-layout node files (direct .decanter.json sibling)", () => {
    const proxy = proxyOver(["/ws/wf/.decanter.json"]);
    assert.deepEqual(codes(proxy.getSemanticDiagnostics("/ws/wf/parse.ts")), [2322]);
  });

  it("leaves files without a .decanter.json untouched", () => {
    const proxy = proxyOver([]);
    assert.deepEqual(codes(proxy.getSemanticDiagnostics("/ws/wf/code/parse.js")), [1108, 1375, 1378, 2322]);
  });

  it("never filters .remote.js conflict files or .d.ts, even beside a .decanter.json", () => {
    const proxy = proxyOver(["/ws/wf/.decanter.json"]);
    assert.deepEqual(codes(proxy.getSemanticDiagnostics("/ws/wf/code/parse.remote.js")), [1108, 1375, 1378, 2322]);
    assert.deepEqual(codes(proxy.getSemanticDiagnostics("/ws/wf/code/globals.d.ts")), [1108, 1375, 1378, 2322]);
  });

  it("handles Windows path separators", () => {
    const proxy = proxyOver(["C:/ws/wf/.decanter.json"]);
    assert.deepEqual(codes(proxy.getSemanticDiagnostics("C:\\ws\\wf\\code\\parse.js")), [2322]);
  });

  it("delegates every other language-service method untouched", () => {
    const proxy = proxyOver([]);
    assert.deepEqual(proxy.getQuickInfoAtPosition("/ws/a.ts", 7), { fileName: "/ws/a.ts", position: 7 });
  });

  it("falls back to ts.sys.fileExists when the host lacks fileExists", () => {
    const wf = path.join(tmp, "wf");
    mkdirSync(path.join(wf, "code"), { recursive: true });
    writeFileSync(path.join(wf, ".decanter.json"), "{}");
    const stub = { getSemanticDiagnostics: () => [...CANNED] } as unknown as ts.LanguageService;
    const proxy = init({ typescript: ts }).create({ languageService: stub, languageServiceHost: {} });
    assert.deepEqual(codes(proxy.getSemanticDiagnostics(path.join(wf, "code", "a.js"))), [2322]);
  });
});

describe("decanter-ts-plugin: against a real language service", () => {
  // In-memory project mirroring the template tsconfig; /ws/wf is a workflow
  // folder (has .decanter.json), /ws/other is not.
  const NODE_FILE = "/ws/wf/code/node.js";
  const PLAIN_FILE = "/ws/other/plain.js";
  const files = new Map<string, string>([
    [NODE_FILE, "await Promise.resolve(1);\nconst n = 1;\nn();\nreturn [];\n"],
    [PLAIN_FILE, "return 1;\n"],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      const text = files.get(f) ?? ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "/ws",
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => files.has(f) || f === "/ws/wf/.decanter.json" || ts.sys.fileExists(f),
    readFile: (f) => files.get(f) ?? ts.sys.readFile(f),
  };
  const ls = ts.createLanguageService(host);
  const proxy = init({ typescript: ts }).create({ languageService: ls, languageServiceHost: host });

  it("the raw service does report the false positives (pins the channel: semantic)", () => {
    const raw = codes(ls.getSemanticDiagnostics(NODE_FILE));
    assert.ok(raw.includes(1108), `expected TS1108 in ${raw}`);
    assert.ok(raw.includes(1375) || raw.includes(1378), `expected TS1375/1378 in ${raw}`);
  });

  it("the proxy drops them for the node file but keeps genuine type errors", () => {
    const all = [...proxy.getSemanticDiagnostics(NODE_FILE), ...proxy.getSyntacticDiagnostics(NODE_FILE)];
    for (const code of FILTERED) assert.ok(!codes(all).includes(code), `TS${code} not filtered`);
    assert.ok(codes(all).includes(2349), `genuine error TS2349 lost: ${codes(all)}`); // n() — not callable
  });

  it("the proxy keeps TS1108 for a file outside any workflow folder", () => {
    assert.ok(codes(proxy.getSemanticDiagnostics(PLAIN_FILE)).includes(1108));
  });
});
