#!/usr/bin/env node
// Typecheck wrapper around tsc: n8n Code node source is a *function body*
// (top-level `return` / `await`), which plain `tsc` rejects in .ts files
// (TS1108). This script wraps node files in `async function () { ... }`
// in memory only — files on disk stay verbatim — and maps diagnostic line
// numbers back. Node files are recognized by a .decanter.json sibling, or —
// code/ layout — one in the parent of their code/ dir.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { scanNodeImports } from "../lib/compile.mts";
import { nodeFileContextDir } from "../lib/state.mts";
import { NO_TYPESCRIPT } from "../lib/validate.mts";

// `typescript` is a devDependency of *this* package, never a runtime one —
// a plain `import ts from "typescript"` resolves relative to this script's
// own location, which for a globally-installed CLI is nowhere near the sync
// dir being typechecked, so it can never find the sync dir's scaffolded
// `typescript` devDependency (plans/13). Resolve from cwd (the sync dir —
// lib/validate.mts spawns this script with cwd set to it) first, falling
// back to this script's own location for setups where the sync dir has no
// `typescript` of its own (e.g. this repo's own dev/test tree, where the
// CLI's own node_modules carries it).
function resolveTypescript(): typeof import("typescript") {
  try {
    return createRequire(path.join(process.cwd(), "package.json"))("typescript");
  } catch {
    try {
      return createRequire(import.meta.url)("typescript");
    } catch {
      // Neither the sync dir nor the CLI's own install has it. A globally
      // installed decanter ships no `typescript` (it is a devDependency), and
      // `init` leaves an EXISTING package.json alone — so a user who scaffolded
      // into a project they already had lands here. Without this branch the
      // module-resolution stack trace surfaced as a failed *typecheck*, reading
      // like a type error in the user's own code (seen in round ftrun-73440,
      // where the agent guessed its way to `npm i -D typescript`).
      console.error(`${NO_TYPESCRIPT} in ${process.cwd()} — node-file typechecking needs it: npm i -D typescript`);
      process.exit(3);
    }
  }
}
const ts = resolveTypescript();

const PREFIX = "async function __n8nNode() {\n";
const SUFFIX = "\n}\nvoid __n8nNode;\n";

// Optional dir arguments scope the *output*: the whole project is still
// compiled (cross-file types need the full graph), but only diagnostics whose
// file lives under one of the given dirs are reported and counted. Global
// (file-less) diagnostics are always reported — a broken tsconfig must not
// pass as green just because a scope was given. Neither may a diagnostic in a
// NON-node file inside the project (a shared helper): scoping exists to stop
// one workflow inheriting another workflow's *node* errors, but shared code
// is common infrastructure — an error there fails `push` for every workflow,
// so a scoped run reporting green on it would be a gate that lies (Plan 79).
// Realpath the scope dirs: they arrive in the caller's spelling, but the
// compiler's file names live under the REALPATHED cwd (the OS resolves
// process.cwd()), so a symlinked sync-dir path (macOS /tmp -> /private/tmp,
// a symlinked checkout) would otherwise never prefix-match — and every node
// diagnostic would be silently dropped from a scoped run (Plan 79 task 4).
const scopeDirs = process.argv.slice(2).map((d) => {
  const resolved = path.resolve(d);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
});
function inScope(fileName: string): boolean {
  if (scopeDirs.length === 0) return true;
  const file = path.resolve(fileName);
  if (scopeDirs.some((dir) => file === dir || file.startsWith(dir + path.sep))) return true;
  if (file.includes(`${path.sep}node_modules${path.sep}`) || isNodeFile(file)) return false;
  return file === projectDir || file.startsWith(projectDir + path.sep);
}

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error("tsconfig.json not found");
  process.exit(2);
}
const projectDir = path.dirname(path.resolve(configPath));
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
