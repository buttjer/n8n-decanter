import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { CODE_DIR, isJsCodeNode, placeholderFile, splitMarker } from "./util.mts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** An n8n item ({ json, binary? }); json stays untyped — it's user data. */
interface Item {
  json: any;
  binary?: any;
}

/** Fixture file shape; every field is optional. */
interface Fixture {
  input?: unknown[];
  nodes?: Record<string, unknown[]>;
  params?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  workflow?: unknown;
  execution?: unknown;
  prevNode?: unknown;
}

/**
 * Locate the node whose //@file: placeholder points at the given file, so we
 * can read its run mode. workflow.json sits next to the file, or — code/
 * layout — one level up. Returns null when there is no workflow.json or no
 * matching node (a bare file can still be run).
 */
function findNode(resolved: string): WorkflowNode | null {
  let dir = path.dirname(resolved);
  if (!existsSync(path.join(dir, "workflow.json")) && path.basename(dir) === CODE_DIR) {
    dir = path.dirname(dir);
  }
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) return null;
  let wf: Workflow;
  try {
    wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  } catch {
    return null;
  }
  const ref = path.relative(dir, resolved).split(path.sep).join("/");
  for (const node of wf.nodes ?? []) {
    if (isJsCodeNode(node) && placeholderFile(node) === ref) return node;
  }
  return null;
}

/** Load and shape a fixture file; every field is optional. */
function loadFixture(fixturePath: string | undefined, log: Log): Fixture {
  if (!fixturePath) return {};
  const resolved = path.resolve(fixturePath);
  if (!existsSync(resolved)) throw new Error(`fixture not found: ${fixturePath}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8")) as Fixture;
  } catch (err) {
    throw new Error(`fixture is not valid JSON (${(err as Error).message})`);
  }
  return raw;
}

/** Normalize a value into an n8n item ({ json, binary? }). */
function asItem(value: unknown): Item {
  if (value && typeof value === "object" && "json" in value) return value as Item;
  return { json: value ?? {} };
}

function makeNodeRef(items: unknown[]) {
  const list = items.map(asItem);
  return {
    all: () => list,
    first: () => list[0],
    last: () => list[list.length - 1],
    item: list[0],
    itemMatching: (i: number) => list[i],
    params: {},
    context: {},
    isExecuted: true,
  };
}

/**
 * Build the globals an n8n Code node sees. `perItem` overrides the each-item
 * fields ($json, $binary, $itemIndex, $input.item) for "Run Once for Each Item".
 */
async function buildGlobals(fixture: Fixture, log: Log) {
  const input = (fixture.input ?? [{ json: {} }]).map(asItem);
  const nodes: Record<string, ReturnType<typeof makeNodeRef>> = {};
  for (const [name, items] of Object.entries(fixture.nodes ?? {})) {
    nodes[name] = makeNodeRef(items);
  }
  const $input = {
    all: () => input,
    first: () => input[0],
    last: () => input[input.length - 1],
    item: input[0],
    params: fixture.params ?? {},
  };
  const $ = (name: string) => {
    if (!nodes[name]) {
      throw new Error(`node "${name}" has no fixture data — add it under "nodes" in the fixture JSON`);
    }
    return nodes[name];
  };

  // Luxon is what n8n exposes for DateTime/Duration/Interval. Optional: run
  // still works for pure-logic nodes when it isn't installed.
  let DateTime: typeof import("luxon").DateTime | undefined;
  let Duration: typeof import("luxon").Duration | undefined;
  let Interval: typeof import("luxon").Interval | undefined;
  try {
    ({ DateTime, Duration, Interval } = await import("luxon"));
  } catch {
    log.warn("luxon not installed — DateTime/$now/$today are unavailable in this run");
  }

  return {
    $input,
    $,
    $json: input[0]?.json ?? {},
    $binary: input[0]?.binary ?? {},
    $env: fixture.env ?? { ...process.env },
    $itemIndex: 0,
    $runIndex: 0,
    $now: DateTime ? DateTime.now() : undefined,
    $today: DateTime ? DateTime.now().startOf("day") : undefined,
    DateTime,
    Duration,
    Interval,
    $workflow: fixture.workflow ?? { id: "local", name: "local", active: false },
    $execution: fixture.execution ?? { id: "local", mode: "test" },
    $prevNode: fixture.prevNode ?? { name: "", outputIndex: 0, runIndex: 0 },
    $jmespath: (data: unknown, expr: unknown) => {
      throw new Error("$jmespath is not implemented in `run` — assert on the data directly");
    },
    console,
  };
}

async function invoke(code: string, globals: Record<string, unknown>): Promise<unknown> {
  const names = Object.keys(globals);
  const fn = new AsyncFunction(...names, code);
  return fn(...names.map((n) => globals[n]));
}

/**
 * Execute a Code node's body locally against a (fake) n8n context and print
 * what it returns. Offline; no credentials, no network. `.ts` is compiled with
 * the same esbuild pass as push; `.js` runs verbatim (marker stripped if any).
 */
export async function runNode(file: string, fixturePath: string | undefined, log: Log): Promise<unknown> {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) throw new Error(`node file not found: ${file}`);
  if (!/\.(ts|js)$/.test(resolved)) throw new Error(`not a node source file (need .js or .ts): ${file}`);

  const basename = path.basename(resolved);
  const node = findNode(resolved);
  const mode = node?.parameters?.mode ?? "runOnceForAllItems";
  if (!node) log.warn(`no workflow.json placeholder points at ${basename} — assuming ${mode}`);

  const code = resolved.endsWith(".ts")
    ? await compileTs(resolved)
    : splitMarker(readFileSync(resolved, "utf8")).body;

  const fixture = loadFixture(fixturePath, log);
  const globals = await buildGlobals(fixture, log);

  log.info(`running ${basename} (${mode})${fixturePath ? ` with fixture ${path.basename(fixturePath)}` : ""}`);
  log.info("─".repeat(48));

  let output;
  if (mode === "runOnceForEachItem") {
    const input = globals.$input.all();
    output = [];
    for (let i = 0; i < input.length; i++) {
      const perItem = {
        ...globals,
        $json: input[i].json,
        $binary: input[i].binary ?? {},
        $itemIndex: i,
        $input: { ...globals.$input, item: input[i] },
      };
      const ret = await invoke(code, perItem);
      if (ret !== undefined) output.push(ret);
    }
  } else {
    output = await invoke(code, globals);
  }

  log.info("─".repeat(48));
  const count = Array.isArray(output) ? output.length : output === undefined ? 0 : 1;
  log.info(`returned ${count} item${count === 1 ? "" : "s"}:`);
  console.log(JSON.stringify(output, null, 2));
  return output;
}
