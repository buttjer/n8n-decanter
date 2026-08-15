import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkNodeImports, findBundleContext, scanNodeImports } from "./compile.mts";
import { LEGACY_FIXTURES_DIR, SCENARIOS_DIR } from "./executions.mts";
import { readState } from "./state.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { CODE_DIR, FILE_PLACEHOLDER_PREFIX, findNodeRefs, forEachConnectionTarget, isJsCodeNode, type NodeRef, placeholderFile, splitMarker } from "./util.mts";

const execFile = promisify(execFileCb);

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  /**
   * Which node file each error is attributable to, for the callers that push
   * ONE file rather than the folder (`pushSingleNode`, i.e. every watch save).
   *
   * `errors` still carries every message; this is a lookup, not a partition, so
   * existing callers are unaffected. Built where the errors are produced rather
   * than by matching message text after the fact — a substring hunt would
   * silently re-classify itself the next time a message is reworded.
   *
   * Folder-level errors (duplicate names, connection integrity, orphans, and a
   * Code node whose snapshot carries inline code and therefore names no file at
   * all) appear in `errors` and in no bucket: they belong to the folder, not to
   * a save.
   */
  errorsByFile?: Record<string, string[]>;
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
    // compiler runs, so check and push can't disagree. Blocking vs advisory
    // is the checker's call (Plan 79 task 7): builtins and un-opted-in
    // packages block, sync-dir escapes and absolute paths warn.
    const { specifiers, body } = scanNodeImports(readFileSync(filePath, "utf8"));
    if (specifiers.length > 0) {
      const verdict = checkNodeImports(filePath, specifiers, findBundleContext(dir));
      for (const p of verdict.blocking) errors.push(`${label}: ${p}`);
      for (const p of verdict.advisory) warnings.push(`${label}: ${p}`);
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

/** Dangling node references in one string of source/expression text. */
function danglingRefs(text: string, nodeNames: Set<string>): NodeRef[] {
  return findNodeRefs(text).filter((r) => !nodeNames.has(r.name));
}

/** De-dupe by the name AND the form it was written in — both are worth reporting. */
const uniqueRefs = (refs: NodeRef[]): NodeRef[] => [...new Map(refs.map((r) => [r.ref, r])).values()];

/**
 * One dangling node reference, and which half of the repair it belongs to
 * (Plan 64): `code` is ours — edit the file and push; `parameter` is n8n's
 * structure — only an MCP write or the editor can fix it.
 */
export interface DanglingRef {
  node: string;
  name: string;
  /** As written — `$('X')`, `$node["X"]`, `$node.X`, `$items('X')`. */
  ref: string;
  where: "code" | "parameter";
}

/**
 * Scan a workflow's nodes for dangling `$('…')` references — **source-agnostic**
 * (Plan 64 task 3b). The local mirror and the instance's draft carry the same
 * workflow in two shapes: locally a Code node's `jsCode` is a `//@file:`
 * placeholder with the real source in a file, remotely it is inline on the node.
 * This takes whatever nodes it is handed, so `test`/`publish` can grade the
 * instance's draft with the exact rule `validateWorkflowDir` applies to the repo.
 *
 * Placeholders are skipped, not scanned: locally the source lives in the file,
 * which `validateWorkflowDir` reads separately.
 */
export function danglingNodeRefs(nodes: WorkflowNode[]): DanglingRef[] {
  const nodeNames = new Set(nodes.map((n) => n.name));
  const out: DanglingRef[] = [];
  for (const node of nodes) {
    const jsCode = node.parameters?.jsCode;
    if (typeof jsCode === "string" && !jsCode.startsWith(FILE_PLACEHOLDER_PREFIX)) {
      for (const r of uniqueRefs(danglingRefs(jsCode, nodeNames))) out.push({ node: node.name, name: r.name, ref: r.ref, where: "code" });
    }
    const texts = parameterStrings(node.parameters, "jsCode");
    for (const r of uniqueRefs(texts.flatMap((t) => danglingRefs(t, nodeNames)))) {
      out.push({ node: node.name, name: r.name, ref: r.ref, where: "parameter" });
    }
  }
  return out;
}

/**
 * Shared wording for dangling refs found on the INSTANCE's draft — used by
 * `test`'s static tier and by `publish`'s gate so both say the same thing.
 *
 * The order is load-bearing, not cosmetic: fixing the code half first and the
 * parameter half second loses the code edit, because the MCP write that fixes a
 * parameter schedules a background pull that overwrites unpushed `.js` files.
 */
export function describeDanglingRefs(refs: DanglingRef[]): string[] {
  const params = refs.filter((r) => r.where === "parameter");
  const code = refs.filter((r) => r.where === "code");
  const lines: string[] = [];
  if (params.length > 0) {
    lines.push("expression parameters (structure — fix in n8n, not in workflow.json):");
    for (const r of params) lines.push(`  node "${r.node}" references ${r.ref}`);
  }
  if (code.length > 0) {
    lines.push("Code-node source (yours — edit the file here, then push):");
    for (const r of code) lines.push(`  node "${r.node}" references ${r.ref}`);
  }
  lines.push(
    params.length > 0 && code.length > 0
      ? "fix the expression parameters FIRST (update_workflow / updateNodeParameters, or the editor), then the code files, then push — the other order loses the code edit to the background snapshot refresh"
      : params.length > 0
        ? "fix them in n8n (update_workflow / updateNodeParameters, or the editor) — editing workflow.json changes nothing on the instance"
        : "edit the file(s) here, then `n8n-decanter push`",
  );
  return lines;
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
  const errorsByFile: Record<string, string[]> = {};
  /** Blame an error on the node file it came from — see `ValidationResult.errorsByFile`. */
  const blame = (file: string, ...messages: string[]): void => {
    if (messages.length === 0) return;
    if (errorsByFile[file] === undefined) errorsByFile[file] = [];
    errorsByFile[file].push(...messages);
  };
  try {
    if (!readState(dir)) errors.push("missing .decanter.json — pull first");
  } catch (err) {
    errors.push((err as Error).message); // "corrupt .decanter.json (…)"
  }
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) {
    errors.push("missing workflow.json — pull first");
    return { errors, warnings, errorsByFile };
  }
  let wf: Workflow;
  try {
    wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  } catch (err) {
    errors.push(`workflow.json: invalid JSON (${(err as Error).message})`);
    return { errors, warnings, errorsByFile };
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
    blame(file, ...result.errors);
    referencedFiles.add(file);
    coveredRemoteFiles.add(file.replace(/\.(ts|js)$/, ".remote.js"));

    // Dangling $('…') in the node's source (marker line can't contain a ref).
    // Usually the fallout of a rename: n8n's `renameNode` MCP op rewrites the
    // node name and connections ONLY (verified live on 2.30.7/2.33.3), so refs
    // are the caller's to repair. This half is ours — edit the file and push.
    const filePath = path.join(dir, file);
    if (existsSync(filePath)) {
      for (const r of uniqueRefs(danglingRefs(readFileSync(filePath, "utf8"), nodeNames))) {
        const message = `node "${node.name}": ${file} references ${r.ref} — no node by that name` +
          ` (renamed? edit ${file} to the new name, then push)`;
        errors.push(message);
        blame(file, message);
      }
    }
  }

  // Local work that hasn't been registered with the instance yet.
  //
  // `.decanter.json`'s id→file map is rewritten by push/pull
  // (reconcileFileMapFromSnapshot); the snapshot's //@file: placeholders are the
  // authoritative map. So a placeholder that has moved off what the state
  // records — the shape of a `.js`→`.ts` conversion — means "converted, not yet
  // pushed", and a state entry naming a file that no longer exists means the
  // same thing from the other side.
  //
  // This MUST stay a warning. `push` runs this guard (assertCompliant, which
  // throws on errors) BEFORE it reconciles the map, so making this an error
  // would refuse the exact command that heals it. A field-test agent hit this
  // state, read the green offline line as "done", and never pushed (Plan 35).
  try {
    const state = readState(dir);
    if (state) {
      for (const node of nodes) {
        if (!isJsCodeNode(node)) continue;
        const recorded = state.nodes[node.id]?.file;
        if (recorded === undefined) continue;
        const placeholder = placeholderFile(node);
        if (placeholder !== null && placeholder !== recorded) {
          warnings.push(`node "${node.name}": .decanter.json still records ${recorded}, but the placeholder now points at ${placeholder} — push to register the change with n8n`);
        } else if (placeholder === recorded && !existsSync(path.join(dir, recorded))) {
          warnings.push(`node "${node.name}": .decanter.json records ${recorded}, which is missing on disk — pull to restore it, or push to register the change`);
        }
      }
    }
  } catch {
    // corrupt state already reported above
  }

  // Dangling $('…') inside expression parameters of any node. The n8n EDITOR
  // rewrites these on rename (client-side, before it saves); the `renameNode`
  // MCP op does NOT — verified live on 2.30.7/2.33.3. A dangling one breaks at
  // run time. Unlike the source half above this is STRUCTURE: it lives in the
  // read-only workflow.json and push never sends it, so the message must route
  // the fix to the instance — hand-editing workflow.json turns this check green
  // while n8n stays broken, and the next pull reverts it.
  for (const node of nodes) {
    const texts = parameterStrings(node.parameters, "jsCode");
    for (const r of uniqueRefs(texts.flatMap((t) => danglingRefs(t, nodeNames)))) {
      errors.push(
        `node "${node.name}": a parameter references ${r.ref} — no node by that name` +
          ` (renamed? this is structure — fix it in n8n (updateNodeParameters over MCP, or the editor), not in workflow.json)`,
      );
    }
  }

  // Orphans and strays. Only the folder root and code/ are scanned: other
  // subdirs are reserved for artifacts (executions/, scenarios/, backups/ —
  // see plans 3, 7/37 and 51) and must not trip the guard.
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
    errors.push(`${LEGACY_FIXTURES_DIR}/ dir is retired — per-node fixtures and the old \`--pin\` flag were removed (Plan 37); recreate the data as a scenario (\`scenario create --execution <id>\`), then delete ${LEGACY_FIXTURES_DIR}/`);
  }
  return { errors, warnings, errorsByFile };
}

/** Outcome of a typecheck run as a fact (no logging, no throw). */
export interface TypecheckResult {
  status: "ok" | "skipped" | "failed";
  /** `tsc` diagnostics on failure, or the reason on a skip. */
  output?: string;
}

/** Nearest tsconfig.json at or above `startDir` — the typecheck's project root. */
function findTsconfigDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "tsconfig.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * ONE typecheck for a whole multi-workflow run, attributed back to each dir
 * (Plan 59). `scripts/typecheck.mts` compiles the entire project every time and
 * only *filters* which diagnostics it reports, so preflight's old per-workflow
 * call recompiled the project once per workflow — measured at 3× the cost of
 * the retired `check` verb on a 3-workflow dir, and linear from there. Running
 * it once and splitting the output by path prefix restores parity.
 *
 * A diagnostic with no file (a broken tsconfig, a global error) belongs to
 * every workflow — it blocks all of them — so it is attributed to each. So
 * does a diagnostic in a file NO workflow owns (a shared helper): it fails
 * the unscoped typecheck `push` runs, for every workflow alike, so dropping
 * it here would grade `ready` on code `push` rejects (Plan 79 F1).
 */
export async function runTypecheckPerDir(startDir: string, dirs: string[]): Promise<Map<string, TypecheckResult>> {
  const result = await runTypecheckResult(startDir, dirs);
  const out = new Map<string, TypecheckResult>();
  if (result.status !== "failed") {
    for (const d of dirs) out.set(d, result);
    return out;
  }
  const tsconfigDir = findTsconfigDir(startDir)!;
  const lines = (result.output ?? "").split("\n");
  // `<rel/path>(line,col): error TS…` — everything else (file-less diagnostics,
  // the "N error(s)" tally) has no path to attribute and goes to everyone.
  const owner = (line: string): string | undefined => {
    const m = line.match(/^(.+?)\(\d+,\d+\): /);
    if (!m) return undefined;
    const abs = path.resolve(tsconfigDir, m[1]);
    return dirs.find((d) => abs === d || abs.startsWith(path.resolve(d) + path.sep));
  };
  const shared = lines.filter((l) => {
    const t = l.trim();
    if (t === "" || /^\d+ error\(s\)$/.test(t)) return false;
    if (!/^(.+?)\(\d+,\d+\): /.test(l)) return true;
    return owner(l) === undefined;
  });
  for (const d of dirs) {
    const mine = lines.filter((l) => owner(l) === path.resolve(d));
    const all = [...mine, ...shared];
    out.set(d, all.length > 0 ? { status: "failed", output: all.join("\n") } : { status: "ok" });
  }
  return out;
}

/**
 * Run scripts/typecheck.mts against the nearest tsconfig.json at or above
 * startDir and RETURN the outcome instead of logging/throwing. Missing tsconfig
 * (e.g. an init'ed sync dir without one) is a `skipped` result. `scopeDirs`
 * limits which files' diagnostics are reported (the whole project still
 * compiles). This is the quiet fact seam `preflight` consumes; `runTypecheck`
 * below wraps it to keep `push`'s console behavior byte-identical.
 */
/**
 * Marker `scripts/typecheck.mts` prints when it cannot resolve `typescript` at
 * all, and the only thing that turns that into a named skip below.
 *
 * It lives HERE, not in the script, because the direction matters: the script
 * imports `lib/`, and `lib/` importing the script would execute its top-level
 * `resolveTypescript()` — which may `process.exit`. One definition, imported by
 * the producer, so the string cannot drift out from under the matcher.
 */
export const NO_TYPESCRIPT = "decanter: typescript is not installed";

/**
 * The install command we hand a user whose project has no `typescript`.
 *
 * **The `@^5` is load-bearing.** A bare `npm i -D typescript` installs 7.x,
 * whose package `exports` maps `"."` to `lib/version.cjs`: `require("typescript")`
 * yields `{ version, versionMajorMinor }` and nothing else, so the
 * `createCompilerHost`/`createProgram` pair this typecheck drives is `undefined`
 * (verified on 7.0.2, 2026-08-08). The API is not gone — it moved behind
 * `typescript/unstable/{sync,async}`, and the name is the point. So unpinned
 * advice would replace a skipped check with a broken one; a blind round walked
 * into exactly that and pinned `5.9.3` by hand.
 *
 * 6.x would work — 6.0.0-beta still exports both functions — but it is
 * beta-only today (`latest` is 7.x), so `^5` is what a user should be told.
 * One definition, shared by the skip message and preflight's unlock.
 */
export const TS_INSTALL_HINT = "npm i -D typescript@^5";

export async function runTypecheckResult(startDir: string, scopeDirs?: string[]): Promise<TypecheckResult> {
  const tsconfigDir = findTsconfigDir(startDir);
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
    // No `typescript` anywhere is a check that CANNOT RUN, not a check that
    // failed — the same class as a missing tsconfig, and it must read that way.
    // A globally installed decanter ships none (devDependency), and `init`
    // leaves an existing package.json alone, so scaffolding into a project you
    // already had lands here.
    // The `@^5` is load-bearing, not decoration: a bare `npm i -D typescript`
    // installs **7.x** today, whose compiler is the native rewrite and no longer
    // exposes the programmatic CompilerHost API this typecheck drives — so the
    // advice would hand you a worse break than the one it fixes. A blind round
    // walked straight into it and had to pin 5.9.3 by hand.
    if (output.includes(NO_TYPESCRIPT)) {
      return { status: "skipped", output: `typescript is not installed — node-file typechecking needs it: ${TS_INSTALL_HINT} (7.x drops the compiler API this uses)` };
    }
    return { status: "failed", output };
  }
}

/**
 * Thin logging/throwing wrapper over `runTypecheckResult`: missing tsconfig is
 * an info-level skip, a pass logs `typecheck OK`, and type errors throw. Used by
 * `push`; behavior is unchanged from before the seam extraction.
 */
export async function runTypecheck(startDir: string, log: Log, scopeDirs?: string[]): Promise<void> {
  const result = await runTypecheckResult(startDir, scopeDirs);
  if (result.status === "skipped") {
    // the reason travels with the result now — "no tsconfig" is no longer the
    // only way a typecheck can be un-runnable (missing `typescript` is another)
    log.info(`${result.output ?? "typecheck not runnable"} — skipping typecheck`);
    return;
  }
  if (result.status === "ok") {
    log.ok("typecheck OK");
    return;
  }
  throw new Error(`typecheck failed:\n${result.output ?? ""}`);
}
