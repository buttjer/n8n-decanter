// The emulated n8n Code-node surface (Plan 43), split out of lib/run.mts for
// Plan 31: the sandbox worker (lib/runsandbox.mts) calls `buildGlobals` in its
// own realm, and must load neither esbuild nor run.mts to do it. Keep this
// module free of runtime imports beyond Luxon and jmespath, which
// `buildGlobals` loads itself — the worker calls it before its import lock.
import type { WorkflowNode } from "./types.mts";

/** An n8n item ({ json, binary? }); json stays untyped — it's user data. */
export interface Item {
  json: any;
  binary?: any;
}

/**
 * Fixture file shape; every field is optional.
 *
 * `input` and each `nodes` entry take **either** a plain items array (one
 * output — the common case) **or** an array of items arrays, one per output
 * (Plan 66): `[[…output 0…], [], […output 2…]]`. The nested form is what makes
 * `$('Node').all(1)` / `$items('Node', 1)` / `$input.all(1)` answerable offline.
 */
export interface Fixture {
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

/** Normalize a value into an n8n item ({ json, binary? }). */
function asItem(value: unknown): Item {
  if (value && typeof value === "object" && "json" in value) return value as Item;
  return { json: value ?? {} };
}

/**
 * A branch the fixture does not pin has no honest answer (Plan 63 task 5).
 *
 * `all(branchIndex)` and `$items(name, outputIndex)` once accepted the argument
 * and **ignored** it, handing back output 0's items — so a Code node reading an
 * IF's false branch got the true branch's data and looked like it worked. That
 * is *wrong* data, not missing data: nothing fails, and the node is graded
 * against a shape it will never see live.
 *
 * Plan 66 turns the refusal into an answer wherever the fixture supplies one —
 * a per-output fixture entry (`[[…], […]]`) makes the branch readable — so this
 * now fires only when the asked-for output genuinely isn't pinned, and says how
 * many are.
 */
function branchSignpost(call: string, requested: number, pinnedOutputs: number): never {
  throw new Error(
    `${call} asks for output ${requested}, which this fixture does not pin — it supplies ${pinnedOutputs} output(s). ` +
      `Pin that branch by giving the node one items array PER OUTPUT: "nodes": { "Name": [[…output 0…], […output 1…]] } (an empty array is a valid output). ` +
      `Or run it for real with \`n8n-decanter test\`.`,
  );
}

/**
 * Read a fixture value as **outputs**: `[[…output 0…], […output 1…]]`.
 *
 * A plain items array is one output, the shape every fixture used before
 * Plan 66. The nested form is recognised when *every* element is an array — so
 * to pin a single output whose items are themselves arrays, write the explicit
 * item form (`[{ "json": [1, 2] }]`), which is not an array of arrays.
 */
function asOutputs(value: unknown[] | undefined): Item[][] {
  if (value === undefined) return [[]];
  if (value.length > 0 && value.every((v) => Array.isArray(v))) return (value as unknown[][]).map((out) => out.map(asItem));
  return [value.map(asItem)];
}

function makeNodeRef(outputs: Item[][], label = "$('Node')") {
  const list = outputs[0] ?? [];
  // A branch the fixture DOES pin is answered; one it doesn't still refuses,
  // because handing back output 0's items there is wrong data that looks right
  // (Plan 63 task 5 — the refusal this builds on).
  const branch = (branchIndex: number | undefined, method: string): Item[] => {
    const i = branchIndex ?? 0;
    const out = outputs[i];
    if (out === undefined) branchSignpost(`${label}.${method}(${i})`, i, outputs.length);
    return out;
  };
  return {
    all: (branchIndex?: number) => branch(branchIndex, "all"),
    first: (branchIndex?: number) => branch(branchIndex, "first")[0],
    last: (branchIndex?: number) => {
      const out = branch(branchIndex, "last");
      return out[out.length - 1];
    },
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
 *
 * Plan 31: this runs inside the sandbox worker, whose `process.env` is empty and
 * whose real `console` must never reach the body, so neither is read here.
 * `env` is the snapshot the CLI process took under `--allow-env` (absent
 * otherwise); `console` is the object the body gets as `console`.
 */
export interface GlobalsContext {
  node?: WorkflowNode | null;
  staticData?: unknown;
  /** The CLI's environment snapshot, passed only under `--allow-env`. */
  env?: Record<string, string | undefined>;
  /** What the body sees as `console`; left `undefined` rather than defaulted to the host one. */
  console?: unknown;
}

export async function buildGlobals(fixture: Fixture, context: GlobalsContext = {}) {
  const node = context.node ?? null;
  const staticData = staticDataSlices(context.staticData, node?.name, fixture);
  // `$input`'s branch index is the node's INPUT index (a Merge node's second
  // input), and it reads from the fixture the same way a node's outputs do.
  const inputs = asOutputs(fixture.input ?? [{ json: {} }]);
  const input = inputs[0];
  const nodes: Record<string, ReturnType<typeof makeNodeRef>> = {};
  for (const [name, items] of Object.entries(fixture.nodes ?? {})) {
    nodes[name] = makeNodeRef(asOutputs(items), `$(${JSON.stringify(name)})`);
  }
  const $inputRef = makeNodeRef(inputs, "$input");
  const $input = {
    all: $inputRef.all,
    first: $inputRef.first,
    last: $inputRef.last,
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
  const $items = (name?: string, outputIndex?: number, _runIndex?: number) =>
    name === undefined ? $input.all(outputIndex) : nodeRef(name).all(outputIndex);

  // Luxon backs DateTime/Duration/Interval; jmespath backs `$jmespath` (n8n
  // pins 0.16.0, data-first `search(data, expr)`). Both are hard deps, so a
  // normal install always has them — imported eagerly because a Code node calls
  // them synchronously.
  const { DateTime, Duration, Interval } = await import("luxon");
  const { search: jmespathSearch } = await import("jmespath");
  const $jmespath = (data: unknown, expression: string) => {
    // Mirror n8n's arg guard so bad-arg errors match. n8n also wraps `search`
    // in a security guard; that guard keeps an expression from reaching host
    // objects across n8n's vm boundary. Not mirrored, deliberately (Plan 31): in
    // the sandbox the body already holds every object jmespath could hand it —
    // one scrubbed realm, nothing host-capable in it — and under `--unsafe` the
    // body has full host access anyway, so the guard would add nothing in either.
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
    // always wins; otherwise $env is empty unless --allow-env opts into the
    // CLI's environment snapshot (which can carry N8N_API_KEY and other secrets).
    $env: fixture.env ?? (context.env ? { ...context.env } : {}),
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
    console: context.console,
  };
}

// Everything below runs AFTER user code has started (the second item of a
// per-item run starts after the first body returned), so it uses built-ins
// captured at module load — before any body could patch them (Plan 31,
// "Post-body code"). Module code is strict, so no frame here hands a function
// or a `this` to a body's `Error.prepareStackTrace`.
const ReflectApply = Reflect.apply;
const ReflectConstruct = Reflect.construct;
const ReflectDefineProperty = Reflect.defineProperty;
const ObjectKeys = Object.keys;
const ArrayIsArray = Array.isArray;
const JSONStringify = JSON.stringify;
const StringCtor = String;
const ErrorCtor = Error;
const StringEndsWith = String.prototype.endsWith;
const StringSlice = String.prototype.slice;
// biome-ignore lint/complexity/useArrowFunction: need a function-expression handle to reach the AsyncFunction constructor.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const isObjectLikeG = (v: unknown): v is Record<string, unknown> => v !== null && (typeof v === "object" || typeof v === "function");

/** A property read that never throws (a body may have put a throwing getter on its own thrown object). */
function readProp(obj: unknown, key: PropertyKey): unknown {
  if (!isObjectLikeG(obj)) return undefined;
  try {
    return (obj as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The bare identifier V8 names in an uncaught `<name> is not defined`
 * ReferenceError, else `undefined` — any other error (a typo, a thrown
 * value, a different error type) falls through untouched (Plan 31, "Friendly
 * boundary errors": only a plain "is not defined" ReferenceError is a
 * candidate for remapping).
 */
export function referenceErrorIdent(err: unknown): string | undefined {
  if (readProp(err, "name") !== "ReferenceError") return undefined;
  const message = readProp(err, "message");
  if (typeof message !== "string") return undefined;
  const suffix = " is not defined";
  if (!ReflectApply(StringEndsWith, message, [suffix])) return undefined;
  return ReflectApply(StringSlice, message, [0, message.length - suffix.length]) as string;
}

/** The five names a `.mts`/`.ts`/`.js` node file never has, in either run mode (operator decision 1). */
const COMMONJS_NAMES = ["require", "module", "exports", "__dirname", "__filename"];

/**
 * The CommonJS boundary message for a `referenceErrorIdent` result, else
 * `undefined`. Applies in BOTH run modes — the CLI is ESM, so these five
 * names are undefined in-process too, and `--unsafe` would not fix it.
 */
export function commonJsHint(ident: string): string | undefined {
  for (let i = 0; i < COMMONJS_NAMES.length; i++) {
    if (ident === COMMONJS_NAMES[i]) {
      return `\`${ident}\` is not available in \`node run\` — node files are ES modules: use a top-level \`import\` (npm packages need \`bundleDependencies\` in decanter.config.json).`;
    }
  }
  return undefined;
}

/** A marker key on a per-item `executeBody` result (never exposed to the body) carrying each collected item's INPUT index — an item an earlier call dropped (an `undefined` return) shifts later ones off their position in the returned array. */
const ITEM_INDICES: unique symbol = Symbol("decanter.itemIndices");

/**
 * `JSON.stringify(raw, null, 2)`, but a value JSON refuses (circular, BigInt)
 * is re-thrown naming the offending item (Plan 31, "Values JSON refuses"):
 * the index in the returned array for all-items mode, or — per-item mode —
 * the ORIGINAL INPUT index, read back off the `ITEM_INDICES` marker
 * `executeBody` attaches, so a dropped `undefined` item doesn't shift later
 * ones' reported index.
 */
export function serializeRaw(raw: unknown): string {
  try {
    return ReflectApply(JSONStringify, undefined, [raw, null, 2]) as string;
  } catch (err) {
    throw itemBoundaryError(raw, err);
  }
}

function itemBoundaryError(raw: unknown, err: unknown): unknown {
  if (ArrayIsArray(raw)) {
    const indices = readProp(raw, ITEM_INDICES) as number[] | undefined;
    for (let i = 0; i < (raw as unknown[]).length; i++) {
      try {
        ReflectApply(JSONStringify, undefined, [(raw as unknown[])[i]]);
      } catch (e) {
        const idx = indices ? indices[i] : i;
        const msg = isObjectLikeG(e) ? StringCtor(readProp(e, "message")) : StringCtor(e);
        return new ErrorCtor(`item ${idx}: ${msg}`);
      }
    }
    return err;
  }
  // A single non-array return (all-items mode's most common shape, e.g.
  // `return { json }`) still counts as one item (`run.mts`'s `count`), so it
  // gets the same "item <index>" framing rather than the raw JSON.stringify
  // error leaking past the boundary unnamed.
  const msg = isObjectLikeG(err) ? StringCtor(readProp(err, "message")) : StringCtor(err);
  return new ErrorCtor(`item 0: ${msg}`);
}

/**
 * Append without `Array.prototype.push` and without a `[[Set]]` — a body can
 * put a setter for an index on `Array.prototype`; a defined own property never
 * consults it.
 */
export function append(list: unknown[], value: unknown): void {
  ReflectDefineProperty(list, list.length, { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
}

async function invoke(code: string, globals: Record<string, unknown>): Promise<unknown> {
  const names = ObjectKeys(globals);
  const params: unknown[] = [];
  const values: unknown[] = [];
  for (let i = 0; i < names.length; i++) {
    append(params, names[i]);
    append(values, globals[names[i]]);
  }
  append(params, code);
  const fn = ReflectConstruct(AsyncFunction, params) as (...args: unknown[]) => Promise<unknown>;
  // `undefined` receiver, as the plain call `fn(...)` this replaced: a sloppy
  // body's `this` is then the global object, the same in both modes.
  return await ReflectApply(fn, undefined, values);
}

/**
 * The execution boundary's single body loop (Plan 31 task 1): both run modes
 * and both execution paths — in-process under `--unsafe`, in the sandbox
 * worker by default — run the body through this, so they cannot drift.
 * Per-item mode drops `undefined` returns, as n8n does.
 */
export async function executeBody(code: string, mode: string, globals: Awaited<ReturnType<typeof buildGlobals>>): Promise<unknown> {
  if (mode !== "runOnceForEachItem") return await invoke(code, globals);
  const input = globals.$input.all();
  const collected: unknown[] = [];
  // Parallel to `collected`: which INPUT index each collected entry came
  // from — a dropped `undefined` return shifts later entries off their input
  // position, so `serializeRaw` reads this back to name the right item.
  const indices: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const perItem = {
      ...globals,
      $json: item.json,
      $binary: item.binary ?? {},
      $itemIndex: i,
      $input: { ...globals.$input, item },
    };
    const ret = await invoke(code, perItem);
    if (ret !== undefined) {
      append(collected, ret);
      append(indices, i);
    }
  }
  ReflectDefineProperty(collected, ITEM_INDICES, { __proto__: null, value: indices, writable: false, enumerable: false, configurable: false } as PropertyDescriptor);
  return collected;
}
