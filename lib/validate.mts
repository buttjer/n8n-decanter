import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readState } from "./state.mts";
import type { Log, Workflow } from "./types.mts";
import { FILE_PLACEHOLDER_PREFIX, isJsCodeNode, splitMarker } from "./util.mts";

const execFile = promisify(execFileCb);

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/** Compliance checks for one referenced node file. */
export function validateNodeFile(dir: string, file: string, label: string = file): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (file.endsWith(".remote.js")) {
    errors.push(`${label}: placeholder references the conflict artifact ${file} — resolve it into the real node file instead`);
    return { errors, warnings };
  }
  if (!/\.(ts|js)$/.test(file)) {
    errors.push(`${label}: referenced file ${file} must be .js or .ts`);
    return { errors, warnings };
  }
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) {
    errors.push(`${label}: referenced file ${file} is missing`);
    return { errors, warnings };
  }
  if (file.endsWith(".js") && splitMarker(readFileSync(filePath, "utf8")).marker) {
    errors.push(`${label}: ${file} ends with an @ts-n8n marker — that line is reserved for compiled TS pushes and would make the node look TS-managed on the next pull; remove it`);
  }
  const remoteSibling = file.replace(/\.(ts|js)$/, ".remote.js");
  if (existsSync(path.join(dir, remoteSibling))) {
    warnings.push(`${label}: unresolved remote copy ${remoteSibling} — its remote edits will be overwritten on push; port them, then delete the file`);
  }
  return { errors, warnings };
}

/**
 * Validate a pulled workflow folder against the decanter layout:
 * every Code node behind a //@file: placeholder, referenced files present and
 * well-formed, no marker inside .js files; warn on *.remote.js leftovers.
 */
export function validateWorkflowDir(dir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!readState(dir)) errors.push("missing .decanter.json — pull first");
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) {
    errors.push("missing workflow.json — pull first");
    return { errors, warnings };
  }
  let wf: Workflow;
  try {
    wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  } catch (err) {
    errors.push(`workflow.json: invalid JSON (${(err as Error).message})`);
    return { errors, warnings };
  }

  const coveredRemoteFiles = new Set<string>();
  for (const node of wf.nodes ?? []) {
    if (!isJsCodeNode(node)) continue;
    const jsCode = node.parameters.jsCode;
    if (!jsCode.startsWith(FILE_PLACEHOLDER_PREFIX)) {
      errors.push(`node "${node.name}": inline code in workflow.json — node code belongs in its own file behind a ${FILE_PLACEHOLDER_PREFIX} placeholder (a fresh pull extracts it)`);
      continue;
    }
    const file = jsCode.slice(FILE_PLACEHOLDER_PREFIX.length).trim();
    const result = validateNodeFile(dir, file, `node "${node.name}"`);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    coveredRemoteFiles.add(file.replace(/\.(ts|js)$/, ".remote.js"));
  }

  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".remote.js") && !coveredRemoteFiles.has(entry)) {
      warnings.push(`stray remote copy ${entry} — no placeholder references its node; port or delete it`);
    }
  }
  return { errors, warnings };
}

/**
 * Run scripts/typecheck.mts against the nearest tsconfig.json at or above
 * startDir. Missing tsconfig (e.g. an init'ed sync dir without one) is an
 * info-level skip, not an error. Throws on type errors.
 */
export async function runTypecheck(startDir: string, log: Log): Promise<void> {
  let dir = path.resolve(startDir);
  let tsconfigDir: string | null = null;
  for (;;) {
    if (existsSync(path.join(dir, "tsconfig.json"))) {
      tsconfigDir = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!tsconfigDir) {
    log.info("no tsconfig.json found — skipping typecheck");
    return;
  }
  const script = fileURLToPath(new URL("../scripts/typecheck.mts", import.meta.url));
  try {
    await execFile(process.execPath, [script], { cwd: tsconfigDir, encoding: "utf8" });
    log.info("typecheck OK");
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const output = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
    throw new Error(`typecheck failed:\n${output}`);
  }
}
