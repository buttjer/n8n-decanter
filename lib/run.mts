import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { compileNode, isManagedSource } from "./compile.mts";
import { buildGlobals, commonJsHint, executeBody, type Fixture, referenceErrorIdent, serializeRaw } from "./globals.mts";
import type { SandboxMessage, SandboxRequest } from "./runsandbox.mts";
import { nodeFileContextDir } from "./state.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { isJsCodeNode, placeholderFile, splitMarker } from "./util.mts";

// Re-exported: the emulated surface moved to lib/globals.mts (Plan 31), and
// callers — test/unit/globals.test.mts among them — import it from here.
export { buildGlobals };

/**
 * Locate the node whose //@file: placeholder points at the given file (for
 * its run mode) plus the workflow's staticData. workflow.json sits next to
 * the file, or — code/ layout — one level up. `node` is null when there is
 * no workflow.json or no matching node (a bare file can still be run).
 */
function findNodeContext(resolved: string): { node: WorkflowNode | null; staticData: unknown } {
  const dir = nodeFileContextDir(resolved, "workflow.json");
  if (dir === null) return { node: null, staticData: undefined };
  const wfFile = path.join(dir, "workflow.json");
  let wf: Workflow;
  try {
    wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  } catch {
    return { node: null, staticData: undefined };
  }
  const ref = path.relative(dir, resolved).split(path.sep).join("/");
  const node = (wf.nodes ?? []).find((n) => isJsCodeNode(n) && placeholderFile(n) === ref) ?? null;
  return { node, staticData: wf.staticData };
}

/** Load and shape a fixture file; every field is optional. */
function loadFixture(fixturePath: string | undefined): Fixture {
  if (!fixturePath) return {};
  const resolved = path.resolve(fixturePath);
  if (!existsSync(resolved)) throw new Error(`fixture not found: ${fixturePath}`);
  let raw: Fixture;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8")) as Fixture;
  } catch (err) {
    throw new Error(`fixture is not valid JSON (${(err as Error).message})`);
  }
  return raw;
}

/** What one `node run` hands the execution boundary. */
interface ExecRequest {
  code: string;
  mode: string;
  fixture: Fixture;
  node: WorkflowNode | null;
  staticData: unknown;
  /** The CLI's environment snapshot, only under `--allow-env`. */
  env?: Record<string, string | undefined>;
}

/** What comes back: the item count of the RAW return, and its `JSON.stringify(…, null, 2)`. */
interface ExecResult {
  count: number;
  text: string | undefined;
}

/**
 * The execution boundary (Plan 31 task 1). Both sides build the same globals
 * and run the same `executeBody` loop; they differ only in WHERE. Results
 * cross as JSON text either way, so stdout is byte-identical between them.
 */
type Execute = (req: ExecRequest) => Promise<ExecResult>;

/**
 * `--unsafe`: today's in-process AsyncFunction, with full host access. Still
 * maps a CommonJS name (Plan 31, "Friendly boundary errors", operator
 * decision 1) — `require`/`module`/`exports`/`__dirname`/`__filename` are
 * undefined here too (the CLI is ESM), and `--unsafe` would not fix that, so
 * the hint applies without the `--unsafe` text the sandbox message carries.
 */
const executeInProcess: Execute = async (req) => {
  const globals = await buildGlobals(req.fixture, { node: req.node, staticData: req.staticData, env: req.env, console });
  let raw: unknown;
  try {
    raw = await executeBody(req.code, req.mode, globals);
  } catch (err) {
    const ident = referenceErrorIdent(err);
    const hint = ident === undefined ? undefined : commonJsHint(ident);
    throw hint === undefined ? err : new Error(hint);
  }
  return { count: Array.isArray(raw) ? raw.length : raw === undefined ? 0 : 1, text: serializeRaw(raw) };
};

/**
 * Whether this process's `console` colours what it prints to `stream` — the
 * worker formats console arguments but runs with `env: {}`, so it is told.
 * Mirrors Node's own console (`shouldColorize`): FORCE_COLOR decides when set,
 * otherwise a TTY with more than 2 colour depth. `getColorDepth` reads only
 * the env it is given, so calling it off the prototype works for a non-TTY.
 */
function colorsFor(stream: NodeJS.WriteStream): boolean {
  const depth = (): number => tty.WriteStream.prototype.getColorDepth.call(stream, process.env);
  if (process.env.FORCE_COLOR !== undefined) return depth() > 2;
  return stream.isTTY === true && depth() > 2;
}

/**
 * The default: one worker per invocation (lib/runsandbox.mts), resolved with
 * this module's own extension — `.mts` from the checkout, `.mjs` from the
 * built dist/ the npm package ships.
 */
const executeSandboxed: Execute = (req) => {
  const ext = path.extname(fileURLToPath(import.meta.url));
  const entry = new URL(`./runsandbox${ext}`, import.meta.url);
  const workerData: SandboxRequest = {
    ...req,
    colors: { stdout: colorsFor(process.stdout), stderr: colorsFor(process.stderr) },
    debug: Boolean(process.env.DEBUG),
  };
  return new Promise<ExecResult>((resolve, reject) => {
    // defence in depth: the worker deletes `process` anyway (requirement 4)
    const worker = new Worker(entry, { workerData, env: {} });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      // a body may leave timers running; they must not hold the CLI open
      void worker.terminate();
      settle();
    };
    worker.on("message", (m: SandboxMessage) => {
      if (settled) return;
      if (m.k === "stdout") console.log(m.s);
      else if (m.k === "stderr") console.error(m.s);
      else if (m.k === "done") finish(() => resolve({ count: m.count, text: m.text }));
      else {
        const err = new Error(m.message) as Error & { code?: string };
        if (m.name !== undefined) err.name = m.name;
        if (m.code !== undefined) err.code = m.code;
        if (m.stack !== undefined) err.stack = m.stack;
        finish(() => reject(err));
      }
    });
    worker.on("error", (err) => finish(() => reject(err)));
    // Messages posted before the worker ended are delivered before `exit`, so
    // reaching this unsettled means the body never returned. Without it the
    // CLI would drain its own loop and exit 0 on nothing.
    worker.on("exit", (code) => finish(() => reject(new Error(`the node never returned (sandbox worker exited with code ${code})`))));
  });
};

/**
 * Execute a Code node's body locally against a (fake) n8n context and print
 * what it returns. Offline; no credentials, no network. A managed source
 * (`.ts`, or a `.js` with a top-level import) is compiled with the same
 * esbuild pass as push; a plain `.js` runs verbatim (marker stripped if any
 * — though a non-managed file never carries one). The body runs sandboxed
 * unless `unsafe` (Plan 31).
 */
export async function runNode(file: string, fixturePath: string | undefined, log: Log, opts: { allowEnv?: boolean; unsafe?: boolean } = {}): Promise<unknown> {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) throw new Error(`node file not found: ${file}`);
  if (!/\.(ts|js)$/.test(resolved)) throw new Error(`not a node source file (need .js or .ts): ${file}`);

  const basename = path.basename(resolved);
  const { node, staticData } = findNodeContext(resolved);
  const mode = node?.parameters?.mode ?? "runOnceForAllItems";
  if (!node) log.warn(`no workflow.json placeholder points at ${basename} — assuming ${mode}`);

  const code = isManagedSource(resolved)
    ? await compileNode(resolved, log)
    : splitMarker(readFileSync(resolved, "utf8")).body;

  const fixture = loadFixture(fixturePath);
  const execute = opts.unsafe ? executeInProcess : executeSandboxed;
  if (opts.unsafe) log.warn("running with full host access — no sandbox (--unsafe)");

  log.info(`running ${basename} (${mode})${fixturePath ? ` with fixture ${path.basename(fixturePath)}` : ""}`);
  log.info("─".repeat(48));

  const { count, text } = await execute({ code, mode, fixture, node, staticData, env: opts.allowEnv ? { ...process.env } : undefined });

  log.info("─".repeat(48));
  log.info(`returned ${count} item${count === 1 ? "" : "s"}:`);
  console.log(text);
  return text === undefined ? undefined : JSON.parse(text);
}
