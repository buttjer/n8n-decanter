#!/usr/bin/env node
// Typecheck wrapper around tsc: n8n Code node source is a *function body*
// (top-level `return` / `await`), which plain `tsc` rejects in .ts files
// (TS1108). This script wraps node files in `async function () { ... }`
// in memory only — files on disk stay verbatim — and maps diagnostic line
// numbers back. Node files are recognized by a .decanter.json sibling, or —
// code/ layout — one in the parent of their code/ dir.
import path from "node:path";
import ts from "typescript";
import { scanNodeImports } from "../lib/compile.mts";
import { nodeFileContextDir } from "../lib/state.mts";

const PREFIX = "async function __n8nNode() {\n";
const SUFFIX = "\n}\nvoid __n8nNode;\n";

// Optional dir arguments scope the *output*: the whole project is still
// compiled (cross-file types need the full graph), but only diagnostics whose
// file lives under one of the given dirs are reported and counted. Global
// (file-less) diagnostics are always reported — a broken tsconfig must not
// pass as green just because a scope was given.
const scopeDirs = process.argv.slice(2).map((d) => path.resolve(d));
function inScope(fileName: string): boolean {
  if (scopeDirs.length === 0) return true;
  const file = path.resolve(fileName);
  return scopeDirs.some((dir) => file === dir || file.startsWith(dir + path.sep));
}

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error("tsconfig.json not found");
  process.exit(2);
}
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    console.error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    process.exit(2);
  },
});
if (!parsed) process.exit(2);

function isNodeFile(fileName: string): boolean {
  if (fileName.endsWith(".d.ts") || fileName.endsWith(".remote.js")) return false;
  if (!/\.(ts|js)$/.test(fileName)) return false;
  // .decanter.json sibling, or — kebab-case layout — in the parent of code/
  return nodeFileContextDir(fileName) !== null;
}

// Wrapped node files map to their import-block line count: imports must stay
// at module scope (plans/14 bundling), so the wrapper is inserted *after*
// them — lines up to importLines are unshifted, later lines shift by one.
const wrapped = new Map<string, number>();
const host = ts.createCompilerHost(parsed.options);
const originalReadFile = host.readFile.bind(host);
host.readFile = (fileName) => {
  const text = originalReadFile(fileName);
  if (text === undefined || !isNodeFile(fileName)) return text;
  const { importBlock, body, importLines } = scanNodeImports(text);
  wrapped.set(path.resolve(fileName), importLines);
  return importBlock + PREFIX + body + SUFFIX;
};

const program = ts.createProgram(parsed.fileNames, parsed.options, host);
let problems = 0;
for (const d of ts.getPreEmitDiagnostics(program)) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file) {
    console.error(`error TS${d.code}: ${message}`);
    problems++;
    continue;
  }
  if (!inScope(d.file.fileName)) continue;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start!);
  const importLines = wrapped.get(path.resolve(d.file.fileName));
  let displayLine = line + 1;
  if (importLines !== undefined && displayLine > importLines) displayLine -= 1;
  if (importLines !== undefined && displayLine < 1) continue; // diagnostic on the injected wrapper itself
  const rel = path.relative(process.cwd(), d.file.fileName);
  const category = ts.DiagnosticCategory[d.category].toLowerCase();
  console.error(`${rel}(${displayLine},${character + 1}): ${category} TS${d.code}: ${message}`);
  if (d.category === ts.DiagnosticCategory.Error) problems++;
}

if (problems > 0) {
  console.error(`\n${problems} error(s)`);
  process.exit(1);
}
console.log("typecheck OK");
