import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { nodeFileContextDir } from "./state.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { isJsCodeNode, placeholderFile, splitMarker } from "./util.mts";

// biome-ignore lint/complexity/useArrowFunction: need a function-expression handle to reach the AsyncFunction constructor.
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
  /** Pins the instance-scoped `$vars`/`$secrets` (otherwise they signpost `test`). */
  vars?: Record<string, string>;
  secrets?: Record<string, unknown>;
  workflow?: unknown;
  execution?: unknown;
  prevNode?: unknown;
  /** Overrides the workflow.json staticData seed, per slice. `node` means the node being run. */
  staticData?: { global?: unknown; node?: unknown };
}

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

/**
 * The two staticData slices a node can see. Workflow JSON stores them as
 * `{ global: …, "node:<node name>": … }` (n8n's own key scheme); a fixture's
 * `staticData.global` / `staticData.node` replaces the matching slice whole.
 * The returned objects are mutable during the run — like in n8n — but `run`
 * never persists them (offline by design).
 */
function staticDataSlices(raw: unknown, nodeName: string | undefined, fixture: Fixture): { global: Record<string, unknown>; node: Record<string, unknown> } {
  let parsed = raw;
  if (typeof parsed === "string") {
    // the API may deliver staticData in its DB-serialized string form
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }
  const seed = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const slice = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  return {
    global: slice(fixture.staticData?.global ?? seed.global),
    node: slice(fixture.staticData?.node ?? (nodeName === undefined ? undefined : seed[`node:${nodeName}`])),
  };
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
    // Approximation: offline `run` has no paired-item graph, so `.item` /
    // `.itemMatching` read the fixture by position rather than resolving the
    // true linked item. Documented as "partial" in docs/cli/node-run.md.
    item: list[0],
    itemMatching: (i: number) => list[i],
    params: {},
    context: {},
    isExecuted: true,
  };
}

/**
 * The friendly boundary (Plan 43). A global whose value is genuinely
 * instance-scoped — n8n workflow variables, external secrets, the expression
 * engine — has no honest offline meaning, so `run` refuses it with one
 * consistent message that names the global and points at the escape hatches
 * (`test` against the real instance, or pinning it in the fixture) instead of
 * letting it surface as a bare `ReferenceError` at the call site.
 */
function signpost(name: string, why: string, fixtureField?: string): never {
  const pin = fixtureField ? `, or pin \`${fixtureField}\` in the fixture` : "";
  throw new Error(`${name} is not emulated in \`run\` — ${why}. Run against the real instance with \`n8n-decanter test\`${pin}.`);
}

/** A function-shaped signpost (e.g. `$evaluateExpression`). */
const signpostFn = (name: string, why: string, fixtureField?: string) => (): never => signpost(name, why, fixtureField);

/**
 * Keys that serializers/inspectors probe (JSON.stringify's `toJSON`, thenable
 * detection's `then`, and every well-known symbol like `Symbol.toStringTag`) —
 * an emulated Proxy must return `undefined` for these rather than treat them as
 * a real access, so `JSON.stringify`/`console.log` of the proxy don't throw.
 */
const isProbeKey = (prop: string | symbol): boolean => typeof prop !== "string" || prop === "toJSON" || prop === "then";

/** A value-shaped signpost (e.g. `$vars`/`$secrets`): any real property read throws. */
function signpostValue(name: string, why: string, fixtureField: string): Record<string, never> {
  return new Proxy({} as Record<string, never>, {
    get: (_t, prop) => (isProbeKey(prop) ? undefined : signpost(name, why, fixtureField)),
  });
}

/**
 * Build the globals an n8n Code node sees (Plan 43 — the emulated surface). Each
 * global is one of: **emulated** (a pure/offline meaning — `$jmespath`, `$items`,
 * `$node`, Luxon), **pinnable** from the fixture (`$input`/`$json`/`$env`/`$vars`/…),
 * or a friendly **signpost** to `test` for genuinely instance-scoped values
 * (`$vars`/`$secrets` unpinned, `$evaluateExpression`). The set of keys returned
 * here is held in lock-step with `n8n-globals.d.ts` by the parity test. The
 * each-item loop in `runNode` overrides `$json`/`$binary`/`$itemIndex`/`$input.item`.
 */
export async function buildGlobals(fixture: Fixture, context: { node?: WorkflowNode | null; staticData?: unknown; allowEnv?: boolean } = {}) {
  const node = context.node ?? null;
  const staticData = staticDataSlices(context.staticData, node?.name, fixture);
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
  const nodeRef = (name: string) => {
    if (!nodes[name]) {
      throw new Error(`node "${name}" has no fixture data — add it under "nodes" in the fixture JSON`);
    }
    return nodes[name];
  };
  // Legacy views over the same fixture `nodes` map: `$node.Name` mirrors
  // `$("Name")`; `$items("Name")` is that node's `.all()` items array (and,
  // with no name, the current input — n8n's own default).
  const $node = new Proxy({} as Record<string, ReturnType<typeof makeNodeRef>>, {
    get: (_t, prop) => (isProbeKey(prop) ? undefined : nodeRef(prop as string)),
  });
  const $items = (name?: string, _outputIndex?: number, _runIndex?: number) => (name === undefined ? input : nodeRef(name).all());

  // Luxon backs DateTime/Duration/Interval; jmespath backs `$jmespath` (n8n
  // pins 0.16.0, data-first `search(data, expr)`). Both are hard deps, so a
  // normal install always has them — imported eagerly because a Code node calls
  // them synchronously.
  const { DateTime, Duration, Interval } = await import("luxon");
  const { search: jmespathSearch } = await import("jmespath");
  const $jmespath = (data: unknown, expression: string) => {
    // Mirror n8n's arg guard so bad-arg errors match (the security guard it also
    // wraps `search` in is Plan 31's concern, not needed offline).
    if (typeof data !== "object" || typeof expression !== "string") {
      throw new Error("expected two arguments (Object, string) for this function");
    }
    return jmespathSearch(data, expression);
  };

  return {
    $input,
    $: nodeRef,
    $json: input[0]?.json ?? {},
    $binary: input[0]?.binary ?? {},
    $node,
    $items,
    // n8n's $env is scoped, not the whole host environment. A fixture's env
    // always wins; otherwise $env is empty unless --allow-env opts into
    // inheriting process.env (which can carry N8N_API_KEY and other secrets).
    $env: fixture.env ?? (context.allowEnv ? { ...process.env } : {}),
    // Instance-scoped: pinned from the fixture, else a friendly signpost to `test`.
    $vars: fixture.vars ?? signpostValue("$vars", "n8n workflow variables live on the running instance", "vars"),
    $secrets: fixture.secrets ?? signpostValue("$secrets", "external secrets live on the running instance", "secrets"),
    // Single-item offline run: both pinned at 0 (the each-item loop advances
    // $itemIndex). Stated as such in docs/cli/node-run.md.
    $itemIndex: 0,
    $runIndex: 0,
    $now: DateTime.now(),
    $today: DateTime.now().startOf("day"),
    DateTime,
    Duration,
    Interval,
    $workflow: fixture.workflow ?? { id: "local", name: "local", active: false },
    $getWorkflowStaticData: (type: string) => {
      if (type !== "global" && type !== "node") {
        throw new Error(`$getWorkflowStaticData: type must be "global" or "node", got ${JSON.stringify(type)}`);
      }
      return staticData[type];
    },
    $execution: fixture.execution ?? { id: "local", mode: "test" },
    $prevNode: fixture.prevNode ?? { name: "", outputIndex: 0, runIndex: 0 },
    // Node identity, read straight from workflow.json's node entry (cheap and
    // honest); stubbed when no placeholder points at the file being run.
    $nodeId: node?.id ?? "local",
    $nodeVersion: (node?.typeVersion as number | undefined) ?? 1,
    $webhookId: node?.webhookId as string | undefined,
    $jmespath,
    $jmesPath: $jmespath,
    // Needs n8n's expression engine — no offline meaning, so it signposts.
    $evaluateExpression: signpostFn("$evaluateExpression", "it needs n8n's expression engine"),
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
export async function runNode(file: string, fixturePath: string | undefined, log: Log, opts: { allowEnv?: boolean } = {}): Promise<unknown> {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) throw new Error(`node file not found: ${file}`);
  if (!/\.(ts|js)$/.test(resolved)) throw new Error(`not a node source file (need .js or .ts): ${file}`);

  const basename = path.basename(resolved);
  const { node, staticData } = findNodeContext(resolved);
  const mode = node?.parameters?.mode ?? "runOnceForAllItems";
  if (!node) log.warn(`no workflow.json placeholder points at ${basename} — assuming ${mode}`);

  const code = resolved.endsWith(".ts")
    ? await compileTs(resolved, log)
    : splitMarker(readFileSync(resolved, "utf8")).body;

  const fixture = loadFixture(fixturePath);
  const globals = await buildGlobals(fixture, { node, staticData, allowEnv: opts.allowEnv });

  log.info(`running ${basename} (${mode})${fixturePath ? ` with fixture ${path.basename(fixturePath)}` : ""}`);
  log.info("─".repeat(48));

  let output: unknown;
  if (mode === "runOnceForEachItem") {
    const input = globals.$input.all();
    const collected: unknown[] = [];
    for (let i = 0; i < input.length; i++) {
      const perItem = {
        ...globals,
        $json: input[i].json,
        $binary: input[i].binary ?? {},
        $itemIndex: i,
        $input: { ...globals.$input, item: input[i] },
      };
      const ret = await invoke(code, perItem);
      if (ret !== undefined) collected.push(ret);
    }
    output = collected;
  } else {
    output = await invoke(code, globals);
  }

  log.info("─".repeat(48));
  const count = Array.isArray(output) ? output.length : output === undefined ? 0 : 1;
  log.info(`returned ${count} item${count === 1 ? "" : "s"}:`);
  console.log(JSON.stringify(output, null, 2));
  return output;
}
