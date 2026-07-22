import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkNodeImports, findBundleContext, scanNodeImports } from "./compile.mts";
import { LEGACY_FIXTURES_DIR, SCENARIOS_DIR } from "./executions.mts";
import { readState } from "./state.mts";
import type { Log, Workflow } from "./types.mts";
import { CODE_DIR, FILE_PLACEHOLDER_PREFIX, findNodeRefs, forEachConnectionTarget, isJsCodeNode, placeholderFile, splitMarker } from "./util.mts";

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
  if (!file.startsWith(CODE_DIR + "/") || file.slice(CODE_DIR.length + 1).includes("/")) {
    errors.push(`${label}: node file ${file} sits outside ${CODE_DIR}/ — node sources live directly in the ${CODE_DIR}/ subdir (a fresh pull migrates old layouts)`);
  }
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) {
    errors.push(`${label}: referenced file ${file} is missing`);
    return { errors, warnings };
  }
  if (file.endsWith(".js")) {
    const jsSource = readFileSync(filePath, "utf8");
    if (splitMarker(jsSource).marker) {
      errors.push(`${label}: ${file} ends with an @ts-n8n marker — that line is reserved for compiled TS pushes and would make the node look TS-managed on the next pull; remove it`);
    }
    // .js is pushed verbatim — an import would reach n8n unbundled and fail
    // at runtime (imports are a .ts feature, bundled on push; plans/14)
    if (scanNodeImports(jsSource).specifiers.length > 0) {
      errors.push(`${label}: ${file} has an import — .js nodes run verbatim in n8n, where import/require fail; convert the node to .ts (imports are bundled on push) or inline the code`);
    }
  }
  if (file.endsWith(".ts")) {
    // bundling rules (plans/14), offline lexical subset: same checker the
    // compiler runs, so check and push can't disagree
    const { specifiers, body } = scanNodeImports(readFileSync(filePath, "utf8"));
    if (specifiers.length > 0) {
      for (const p of checkNodeImports(filePath, specifiers, findBundleContext(dir))) {
        errors.push(`${label}: ${p}`);
      }
    }
    if (/^import[ \t]/m.test(body)) {
      warnings.push(`${label}: ${file} has an import below the first statement — only imports at the top of the file are bundled; the push compile will fail on it`);
    }
  }
  const remoteSibling = file.replace(/\.(ts|js)$/, ".remote.js");
  if (existsSync(path.join(dir, remoteSibling))) {
    warnings.push(`${label}: unresolved remote copy ${remoteSibling} — its remote edits will be overwritten on push; port them, then delete the file`);
  }
  return { errors, warnings };
}

/** Dangling literal `$('…')` references in one string of source/expression text. */
function danglingRefs(text: string, nodeNames: Set<string>): string[] {
  return findNodeRefs(text).filter((name) => !nodeNames.has(name));
}

/** Every string inside a node's parameters, skipping the jsCode placeholder. */
function parameterStrings(value: unknown, skipKey?: string): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => parameterStrings(v));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => (k === skipKey ? [] : parameterStrings(v)));
  }
  return [];
}

/**
 * Validate a pulled workflow folder against the decanter layout:
 * every Code node behind a //@file: placeholder, referenced files present and
 * well-formed, no marker inside .js files, unique node names/ids, connection
 * integrity, no orphan code files, no dangling literal $('…') references;
 * warn on *.remote.js / workflow.remote.json leftovers.
 */
export function validateWorkflowDir(dir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    if (!readState(dir)) errors.push("missing .decanter.json — pull first");
  } catch (err) {
    errors.push((err as Error).message); // "corrupt .decanter.json (…)"
  }
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

  const nodes = wf.nodes ?? [];
  const nodeNames = new Set(nodes.map((n) => n.name));

  // Uniqueness: duplicate names corrupt connections and $('…') resolution,
  // duplicate ids corrupt the id→file map.
  for (const key of ["name", "id"] as const) {
    const seen = new Set<string>();
    for (const node of nodes) {
      const value = node[key];
      if (seen.has(value)) errors.push(`duplicate node ${key} "${value}" — node ${key}s must be unique`);
      seen.add(value);
    }
  }

  // Connection integrity: every source key and every target must be a real node.
  const connectionErrors = new Set<string>();
  for (const source of Object.keys(wf.connections ?? {})) {
    if (!nodeNames.has(source)) connectionErrors.add(`connections: source "${source}" is not a node in this workflow`);
  }
  forEachConnectionTarget(wf.connections ?? {}, (target, source, type) => {
    if (typeof target.node === "string" && !nodeNames.has(target.node)) {
      connectionErrors.add(`connections: "${source}" (${type}) targets missing node "${target.node}"`);
    }
  });
  errors.push(...connectionErrors);

  const referencedFiles = new Set<string>();
  const coveredRemoteFiles = new Set<string>();
  for (const node of nodes) {
    if (!isJsCodeNode(node)) continue;
    const file = placeholderFile(node);
    if (file === null) {
      errors.push(`node "${node.name}": inline code in workflow.json — node code belongs in its own file behind a ${FILE_PLACEHOLDER_PREFIX} placeholder (a fresh pull extracts it)`);
      continue;
    }
    const result = validateNodeFile(dir, file, `node "${node.name}"`);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    referencedFiles.add(file);
    coveredRemoteFiles.add(file.replace(/\.(ts|js)$/, ".remote.js"));

    // Dangling $('…') in the node's source (marker line can't contain a ref).
    const filePath = path.join(dir, file);
    if (existsSync(filePath)) {
      for (const name of danglingRefs(readFileSync(filePath, "utf8"), nodeNames)) {
        errors.push(`node "${node.name}": ${file} references $('${name}') — no node by that name`);
      }
    }
  }

  // Dangling $('…') inside expression parameters of any node (the n8n UI
  // rewrites these on rename; a dangling one breaks at run time).
  for (const node of nodes) {
    const texts = parameterStrings(node.parameters, "jsCode");
    const dangling = new Set(texts.flatMap((t) => danglingRefs(t, nodeNames)));
    for (const name of dangling) {
      errors.push(`node "${node.name}": a parameter references $('${name}') — no node by that name`);
    }
  }

  // Orphans and strays. Only the folder root and code/ are scanned: other
  // subdirs are reserved for artifacts (executions/, scenarios/ — see
  // plans 3 and 7/37) and must not trip the guard.
  const codeDir = path.join(dir, CODE_DIR);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  if (existsSync(codeDir)) {
    entries.push(...readdirSync(codeDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${CODE_DIR}/${e.name}`));
  }
  for (const entry of entries) {
    if (entry.endsWith(".remote.js")) {
      if (!coveredRemoteFiles.has(entry)) {
        warnings.push(`stray remote copy ${entry} — no placeholder references its node; port or delete it`);
      }
    } else if (/\.(ts|js)$/.test(entry) && !entry.endsWith(".d.ts") && !referencedFiles.has(entry)) {
      errors.push(`orphan code file ${entry} — no ${FILE_PLACEHOLDER_PREFIX} placeholder references it; delete it or point a Code node at it`);
    }
  }
  if (existsSync(path.join(dir, "workflow.remote.json"))) {
    warnings.push("unresolved structural conflict workflow.remote.json — reconcile into workflow.json, then delete it");
  }

  // Snapshot-invariant honesty (Plan 33): the "no Code-node source inline in
  // git" rule has two known loopholes — say so instead of silently passing.
  for (const node of nodes) {
    const params = node.parameters as Record<string, unknown> | undefined;
    if (typeof params?.pythonCode === "string" && params.pythonCode.trim() !== "") {
      warnings.push(`node "${node.name}": Python Code node — its pythonCode stays inline in workflow.json (decanter extracts JS/TS only; Python extraction is a planned feature)`);
    }
  }
  const scenariosDir = path.join(dir, SCENARIOS_DIR);
  if (existsSync(scenariosDir)) {
    for (const entry of readdirSync(scenariosDir).filter((e) => e.endsWith(".json"))) {
      try {
        const scenario = JSON.parse(readFileSync(path.join(scenariosDir, entry), "utf8")) as { workflowData?: { nodes?: Array<{ parameters?: Record<string, unknown> }> } };
        const inline = scenario.workflowData?.nodes?.some((n) => {
          const code = n.parameters?.jsCode;
          return typeof code === "string" && code.trim() !== "" && !code.startsWith(FILE_PLACEHOLDER_PREFIX);
        });
        if (inline === true) {
          warnings.push(`${SCENARIOS_DIR}/${entry}: embeds inline Code-node source under workflowData — committed scenarios must not duplicate node code; delete the scenario's "workflowData" block (freshly created ones omit it)`);
        }
      } catch {
        // corrupt scenario JSON — `scenario check` owns that error
      }
    }
  }

  // Retired per-node fixtures (Plan 37): a leftover fixtures/ dir is a hard error
  // naming the replacement — no deprecation read-path.
  const fixturesDir = path.join(dir, LEGACY_FIXTURES_DIR);
  if (existsSync(fixturesDir) && readdirSync(fixturesDir).some((e) => e.endsWith(".json"))) {
    errors.push(`${LEGACY_FIXTURES_DIR}/ dir is retired — per-node fixtures and \`simulate --pin\` were removed (Plan 37); recreate the data as a scenario (\`scenario create --execution <id>\`), then delete ${LEGACY_FIXTURES_DIR}/`);
  }
  return { errors, warnings };
}

/** Outcome of a typecheck run as a fact (no logging, no throw). */
export interface TypecheckResult {
  status: "ok" | "skipped" | "failed";
  /** `tsc` diagnostics on failure, or the reason on a skip. */
  output?: string;
}

/**
 * Run scripts/typecheck.mts against the nearest tsconfig.json at or above
 * startDir and RETURN the outcome instead of logging/throwing. Missing tsconfig
 * (e.g. an init'ed sync dir without one) is a `skipped` result. `scopeDirs`
 * limits which files' diagnostics are reported (the whole project still
 * compiles). This is the quiet fact seam `preflight` consumes; `runTypecheck`
 * below wraps it to keep `check`/`push`'s console behavior byte-identical.
 */
export async function runTypecheckResult(startDir: string, scopeDirs?: string[]): Promise<TypecheckResult> {
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
  if (!tsconfigDir) return { status: "skipped", output: "no tsconfig.json found" };
  // dev runs the .mts sources directly; the published package ships compiled
  // .mjs (Node won't type-strip under node_modules), so mirror our own extension
  const ext = import.meta.url.endsWith(".mjs") ? ".mjs" : ".mts";
  const script = fileURLToPath(new URL(`../scripts/typecheck${ext}`, import.meta.url));
  // absolute paths: the script resolves its arguments against tsconfigDir's cwd
  const scopeArgs = (scopeDirs ?? []).map((d) => path.resolve(d));
  try {
    await execFile(process.execPath, [script, ...scopeArgs], { cwd: tsconfigDir, encoding: "utf8" });
    return { status: "ok" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const output = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
    return { status: "failed", output };
  }
}

/**
 * Thin logging/throwing wrapper over `runTypecheckResult`: missing tsconfig is
 * an info-level skip, a pass logs `typecheck OK`, and type errors throw. Used by
 * `check`/`push`; behavior is unchanged from before the seam extraction.
 */
export async function runTypecheck(startDir: string, log: Log, scopeDirs?: string[]): Promise<void> {
  const result = await runTypecheckResult(startDir, scopeDirs);
  if (result.status === "skipped") {
    log.info("no tsconfig.json found — skipping typecheck");
    return;
  }
  if (result.status === "ok") {
    log.ok("typecheck OK");
    return;
  }
  throw new Error(`typecheck failed:\n${result.output ?? ""}`);
}
