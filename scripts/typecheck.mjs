#!/usr/bin/env node
// Typecheck wrapper around tsc: n8n Code node source is a *function body*
// (top-level `return` / `await`), which plain `tsc` rejects in .ts files
// (TS1108). This script wraps node files in `async function () { ... }`
// in memory only — files on disk stay verbatim — and maps diagnostic line
// numbers back. Node files are recognized by a .decanter.json sibling.
import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const PREFIX = "async function __n8nNode() {\n";
const SUFFIX = "\n}\nvoid __n8nNode;\n";

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

function isNodeFile(fileName) {
  if (fileName.endsWith(".d.ts") || fileName.endsWith(".remote.js")) return false;
  if (!/\.(ts|js)$/.test(fileName)) return false;
  return existsSync(path.join(path.dirname(fileName), ".decanter.json"));
}

const wrapped = new Set();
const host = ts.createCompilerHost(parsed.options);
const originalReadFile = host.readFile.bind(host);
host.readFile = (fileName) => {
  const text = originalReadFile(fileName);
  if (text === undefined || !isNodeFile(fileName)) return text;
  wrapped.add(path.resolve(fileName));
  return PREFIX + text + SUFFIX;
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
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  const shift = wrapped.has(path.resolve(d.file.fileName)) ? 1 : 0;
  const displayLine = line + 1 - shift;
  if (shift && displayLine < 1) continue; // diagnostic on the injected wrapper itself
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
