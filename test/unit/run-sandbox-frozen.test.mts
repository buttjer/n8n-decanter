// Plan 31 Task 8 — the sandbox freezes every shared object the body can reach
// before the body's first statement. The end review of Tasks 1–7 found a
// verified escape: the scrub left the built-in prototypes writable, and Node's
// own warning code reads `process.noDeprecation` (and three siblings) through
// `Object.prototype` while holding the real `process`. A getter planted there
// is called with `this === process`. These tests pin the freeze that closes
// that whole class: a shared object Node's internals also touch.
//
// Every test drives the real CLI as a subprocess (never imports lib/): the
// boundary is a property of the process the user runs. Probe outcomes are
// returned from the body as data, and every refusal asserts the specific
// failure (a TypeError, `Object.isFrozen`), never just "it threw".
//
// Every refusal has an `--unsafe` twin that asserts the same write SUCCEEDS
// there: without it, a probe that is "refused" because the probe is broken
// would read the same as one refused by the freeze. `--unsafe` runs in the
// CLI's own realm, so each twin uses a unique non-enumerable key where it can
// and removes every patch in the same synchronous step that made it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI = path.join(ROOT, "n8n-decanter.mts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-run-frozen-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

interface Res {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI; never throws on a non-zero exit. */
async function cli(args: string[], opts: { cwd?: string } = {}): Promise<Res> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.N8N_DECANTER_DIR;
  // colour must not depend on the caller's shell, or byte-identity holds by luck
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;
  try {
    const r = await execFileP(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? TMP, env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; signal?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: (e.stderr ?? "") + (e.signal ? `\n[killed by ${e.signal}]` : "") };
  }
}

/** Write a file under TMP (creating directories) and return its absolute path. */
function put(rel: string, content: string): string {
  const file = path.join(TMP, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** The JSON `node run` prints after its `returned N item(s):` line. */
function printed(r: Res): unknown {
  const m = /returned \d+ items?:[^\n]*\n/.exec(r.stdout);
  assert.ok(m, `no "returned … item(s):" line (exit ${r.code}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(m.index + m[0].length));
}

/** The `json` of the single item a probe body returns. */
function probeResult<T>(r: Res): T {
  assert.equal(r.code, 0, `probe run failed:\n${r.stdout}\n${r.stderr}`);
  const out = printed(r) as Array<{ json: T }>;
  assert.equal(out.length, 1, "a probe body returns exactly one item");
  return out[0].json;
}

/** Run one body sandboxed and under --unsafe, in parallel. */
async function both(rel: string, body: string, extra: string[] = []): Promise<[Res, Res]> {
  const file = put(rel, body);
  return Promise.all([cli(["node", "run", file, ...extra]), cli(["node", "run", file, ...extra, "--unsafe"])]);
}

interface Outcome {
  ok: boolean;
  v?: unknown;
  name?: string | null;
  msg?: string;
}

// `probe(k, f)` runs f() and records its value (JSON-safe) or the error's name
// and message. The body is sloppy code, so a strict probe wraps its own
// function in "use strict".
const PROBE_PRELUDE = `
const r = {};
const probe = (k, f) => {
  try { const v = f(); r[k] = { ok: true, v: v === undefined ? null : v }; }
  catch (e) { r[k] = { ok: false, name: e?.name ?? null, msg: String(e?.message ?? e) }; }
};
`;

function assertTypeError(o: Outcome | undefined, label: string): void {
  assert.ok(o, `no result for ${label}`);
  assert.equal(o.ok, false, `must be refused — ${label}: ${JSON.stringify(o)}`);
  assert.equal(o.name, "TypeError", `must be a TypeError — ${label}: ${JSON.stringify(o)}`);
}

// ---------------------------------------------------------------------------
// 1. The reported vector, in the shape it was found.

const VECTOR_BODY = `
${PROBE_PRELUDE}
const KEYS = ["noDeprecation", "traceProcessWarnings", "throwDeprecation", "traceDeprecation"];
const seen = [];
const isProcess = (o) => o !== null && typeof o === "object" && (Object.hasOwn(o, "dlopen") || Object.hasOwn(o, "binding"));
const defined = [];
for (const k of KEYS) {
  probe("define " + k, () => {
    Object.defineProperty(Object.prototype, k, { get() { if (isProcess(this)) seen.push(k); return undefined; }, configurable: true });
    defined.push(k);
    return true;
  });
}
// DEP0005: Node's warning path reads the four keys off the real process
let buf;
try { buf = Buffer(1); } catch (e) { buf = String(e?.name) + ": " + String(e?.message); }
// --unsafe hygiene: the getters live on the CLI's own Object.prototype
for (const k of defined) delete Object.prototype[k];
return [{ json: { r, seen, buffer: Buffer.isBuffer(buf) ? { len: buf.length } : buf, left: KEYS.filter((k) => Object.hasOwn(Object.prototype, k)) } }];
`;

interface VectorResult {
  r: Record<string, Outcome>;
  seen: string[];
  buffer: { len: number } | string;
  left: string[];
}

describe("node run frozen: the Object.prototype deprecation-getter escape", () => {
  let sandboxed: VectorResult;
  let unsafe: VectorResult;
  before(async () => {
    const [a, b] = await both("vector/vector.js", VECTOR_BODY);
    sandboxed = probeResult<VectorResult>(a);
    unsafe = probeResult<VectorResult>(b);
  });

  it("refuses each getter on Object.prototype with a TypeError", () => {
    for (const k of ["noDeprecation", "traceProcessWarnings", "throwDeprecation", "traceDeprecation"]) assertTypeError(sandboxed.r[`define ${k}`], `define ${k}`);
  });

  it("no getter ever sees the real process", () => {
    assert.deepEqual(sandboxed.seen, [], "a getter on Object.prototype was called with the worker's process");
  });

  it("Buffer(1) still returns a one-byte buffer (the DEP0005 path survives the freeze)", () => {
    assert.deepEqual(sandboxed.buffer, { len: 1 });
  });

  it("--unsafe twin: the same body does reach the real process (the trigger fires)", () => {
    assert.ok(unsafe.seen.length > 0, `the deprecation path never read a planted key: ${JSON.stringify(unsafe)}`);
    assert.deepEqual(unsafe.buffer, { len: 1 });
    assert.deepEqual(unsafe.left, [], "the --unsafe control must remove its getters");
  });
});

// ---------------------------------------------------------------------------
// 2. The class, as a walk.

// BFS over the reachable set as contract point 1 defines it: globalThis and
// every global, the injected `$…` values, Luxon, jmespath and the injected
// console (b), the prototypes no global name leads to (c), and the instances
// that carry such prototypes, created here and walked as data (d). It is
// strictly BROADER than the freeze's own walk in one way: on built-ins it calls
// every getter along the whole prototype chain with the reached object as the
// receiver, so a freeze that misses a prototype only a getter leads to
// (`crypto.subtle`, a stream's reader) fails here.
//
// Injected values and Luxon are walked in a second phase that calls no getter
// at all. Luxon's getters cache onto whatever `this` is — `fastNumbers` called
// on Locale.prototype would write there — and `$node`, `$vars` and `$secrets`
// are Proxies that throw on any string-key read. Descriptor reads never reach
// those traps, because the Proxies' targets are empty.
//
// Reported, when not frozen: every object reached through a [[Prototype]]
// link or a `.prototype` property, every namespace object (a global whose
// prototype is Object.prototype and that carries its own Symbol.toStringTag —
// JSON, Math, Reflect, Intl, Atomics, WebAssembly, Temporal), and every
// function reached through a SHARED object: a global, a prototype, a
// `.prototype`, a namespace, or an accessor or getter result of one. Under an
// instance root, its per-instance state is per-run data — a stream
// controller's pull algorithm, a reader's close resolvers — so only the
// prototypes found there are reported: no other run shares those functions,
// so freezing them would protect nothing. Data objects (fixture items,
// `$json`, instances) are walked, never reported. Every extension returns a counter, so a walk whose root silently
// broke reads as broken rather than as clean.
// Paths that have no constructor name to match (the Intl segment prototypes,
// the Iterator.from wrapper, the Node error-code class levels): checked by the
// label the walk gave them.
const WALK_LABELS = ["Intl.Segments<proto>", "Intl.SegmentIterator<proto>", "Iterator.from wrapper<proto>", "Buffer.alloc(-1) error<proto>", "GeneratorFunction.prototype", "IteratorHelper<proto>"];

const WALK_BODY = `
const MAX_VISITED = 100000;
const unfrozen = [];
const reported = new Set();
const protos = new Set();
const rootFailures = [];
const roots = {};
let gettersTaken = 0;
let sharedFunctions = 0;
const PromiseThen = Promise.prototype.then;
const report = (v, p) => { if (!reported.has(v) && !Object.isFrozen(v)) { reported.add(v); unfrozen.push(p); } };
const isObj = (v) => v !== null && (typeof v === "object" || typeof v === "function");
// --unsafe only: the CLI's own process has getters (stdin, …) that would hold
// the run open; under the sandbox it is gone, so this skips nothing there
const isHostProcess = (v) => { try { return Object.hasOwn(v, "dlopen") || Object.hasOwn(v, "reallyExit"); } catch { return false; } };
// what each global name is under the sandbox: these are the injected ones
const INJECTED = new Set(["DateTime", "Duration", "Interval", "console"]);
const isInjectedKey = (k) => typeof k === "string" && (k.startsWith("$") || INJECTED.has(k));

const builtins = [];
const injected = [];
// \`shared\`: v was reached through a shared object. A function is checked the
// first time a shared path reaches it, whichever path reached it first.
const fnChecked = new Set();
const enqueue = (getters, p, v, shared) => {
  if (shared && typeof v === "function" && !fnChecked.has(v)) { fnChecked.add(v); sharedFunctions++; report(v, p); }
  (getters ? builtins : injected).push([p, v, shared]);
};
const viaProto = (getters, p, v) => { if (!isObj(v)) return; protos.add(v); report(v, p); enqueue(getters, p, v, true); };
// a root is walked as data, then its prototype; a root that cannot be built is
// a failure the test reads, not a silently smaller walk
const root = (getters, label, make) => {
  let v;
  try { v = make(); } catch (e) { rootFailures.push(label + ": " + String(e?.message ?? e)); roots[label] = false; return undefined; }
  if (!isObj(v)) { rootFailures.push(label + ": not an object (" + typeof v + ")"); roots[label] = false; return undefined; }
  roots[label] = true;
  enqueue(getters, label, v, false);
  viaProto(getters, label + "<proto>", Reflect.getPrototypeOf(v));
  return v;
};

enqueue(true, "globalThis", globalThis, true);
for (const k of Reflect.ownKeys(globalThis)) {
  const d = Reflect.getOwnPropertyDescriptor(globalThis, k);
  if (!d || !("value" in d) || !isObj(d.value) || typeof d.value === "function" || isInjectedKey(k)) continue;
  if (Reflect.getPrototypeOf(d.value) !== Object.prototype) continue;
  const tag = Reflect.getOwnPropertyDescriptor(d.value, Symbol.toStringTag);
  if (tag && typeof tag.value === "string") report(d.value, "namespace " + String(k));
}

// (c) prototypes no global name leads to
viaProto(true, "GeneratorFunction.prototype", Reflect.getPrototypeOf(function* () {}));
viaProto(true, "AsyncGeneratorFunction.prototype", Reflect.getPrototypeOf(async function* () {}));
viaProto(true, "AsyncFunction.prototype", Reflect.getPrototypeOf(async () => {}));
root(true, "ArrayIterator", () => [].values());
root(true, "StringIterator", () => ""[Symbol.iterator]());
root(true, "MapIterator", () => new Map().entries());
root(true, "SetIterator", () => new Set().values());
root(true, "RegExpStringIterator", () => "a".matchAll(/a/g));
root(true, "IteratorHelper", () => [].values().map(Math.abs));
viaProto(true, "globalThis<proto>", Reflect.getPrototypeOf(globalThis));

// (d) built-in instances; the timers stay live during the walk so their lists
// (TimersList) are reachable, and are cleared in the finally below
let tmo;
let imm;
try {
  tmo = root(true, "setTimeout()", () => setTimeout(Math.max, 600000));
  imm = root(true, "setImmediate()", () => setImmediate(Math.max));
  root(true, "performance.mark()", () => performance.mark("sbx-frozen-mark"));
  root(true, "performance.measure()", () => performance.measure("sbx-frozen-measure"));
  root(true, "AbortController", () => new AbortController());
  root(true, "Buffer.alloc(-1) error", () => { try { Buffer.alloc(-1); } catch (e) { return e; } throw new Error("Buffer.alloc(-1) did not throw"); });
  const tes = root(true, "TextEncoderStream", () => new TextEncoderStream());
  if (tes) {
    root(true, "ReadableStream", () => tes.readable);
    root(true, "WritableStream", () => tes.writable);
    root(true, "ReadableStreamDefaultReader", () => tes.readable.getReader());
    root(true, "WritableStreamDefaultWriter", () => tes.writable.getWriter());
  }
  let key;
  try { key = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]); } catch (e) { key = e; }
  root(true, "CryptoKey", () => { if (key instanceof Error) throw key; return key; });
  const segs = root(true, "Intl.Segments", () => new Intl.Segmenter("en", { granularity: "word" }).segment("a b"));
  if (segs) root(true, "Intl.SegmentIterator", () => segs[Symbol.iterator]());
  root(true, "Iterator.from wrapper", () => Iterator.from({ next: Math.random }));

  // (b) the injected values the body names directly (some are not on globalThis)
  for (const [p, v] of [["$input", $input], ["$", $], ["$node", $node], ["$items", $items], ["$vars", $vars], ["$secrets", $secrets], ["$env", $env], ["$json", $json], ["$now", $now], ["$today", $today], ["DateTime", DateTime], ["Duration", Duration], ["Interval", Interval], ["$jmespath", $jmespath], ["$getWorkflowStaticData", $getWorkflowStaticData], ["$evaluateExpression", $evaluateExpression], ["console", console], ["$workflow", $workflow], ["$execution", $execution], ["$prevNode", $prevNode]]) enqueue(false, p, v, true);
  // (d) Luxon instances whose classes no global names
  root(false, "Luxon IANAZone", () => DateTime.fromISO("2024-01-01T00:00:00Z").setZone("Europe/Berlin").zone);
  root(false, "Luxon Invalid", () => Reflect.getOwnPropertyDescriptor(DateTime.invalid("sbx-frozen"), "invalid")?.value);

  const seen = new Map();
  let visited = 0;
  for (const [queue, getters] of [[builtins, true], [injected, false]]) {
    while (queue.length > 0 && visited < MAX_VISITED) {
      const [p, v, shared] = queue.shift();
      if (!isObj(v) || (seen.has(v) && (seen.get(v) || !shared))) continue;
      seen.set(v, shared);
      visited++;
      if (isHostProcess(v)) continue;
      let keys;
      try { keys = Reflect.ownKeys(v); } catch { continue; }
      for (const k of keys) {
        let d;
        try { d = Reflect.getOwnPropertyDescriptor(v, k); } catch { continue; }
        if (!d) continue;
        const kp = p + "." + String(k);
        // the injected names on globalThis belong to the getter-free phase
        const g = getters && !(v === globalThis && isInjectedKey(k));
        if ("value" in d) {
          if (k === "prototype") viaProto(g, kp, d.value);
          else enqueue(g, kp, d.value, shared);
        }
        if (d.get) enqueue(g, kp + "<get>", d.get, shared);
        if (d.set) enqueue(g, kp + "<set>", d.set, shared);
      }
      if (getters) {
        // getters anywhere on the chain, called with this object as the receiver
        let o = v;
        for (let depth = 0; o !== null && depth < 32; depth++) {
          let ks;
          try { ks = Reflect.ownKeys(o); } catch { break; }
          for (const k of ks) {
            if (o === globalThis && isInjectedKey(k)) continue;
            let d;
            try { d = Reflect.getOwnPropertyDescriptor(o, k); } catch { continue; }
            if (!d?.get) continue;
            let got;
            try { got = Reflect.apply(d.get, v, []); } catch { continue; }
            gettersTaken++;
            // a getter called on the wrong receiver may hand back a rejected
            // promise (a stream reader's \`closed\`); unhandled, it ends the run
            if (got instanceof Promise) Reflect.apply(PromiseThen, got, [undefined, () => {}]);
            enqueue(true, p + "." + String(k) + "<got>", got, shared);
          }
          try { o = Reflect.getPrototypeOf(o); } catch { break; }
        }
      }
      try { viaProto(getters, p + "<proto>", Reflect.getPrototypeOf(v)); } catch {}
    }
  }

  // the constructor name of each checked prototype: what the test reads to see
  // that a getter- or instance-only prototype was really reached
  const ctorName = (o) => {
    let d;
    try { d = Reflect.getOwnPropertyDescriptor(o, "constructor"); } catch { return null; }
    let c = d && ("value" in d ? d.value : undefined);
    if (d?.get) { try { c = Reflect.apply(d.get, o, []); } catch { c = undefined; } }
    if (typeof c !== "function") return null;
    const n = Reflect.getOwnPropertyDescriptor(c, "name");
    return n && typeof n.value === "string" ? n.value : null;
  };
  const names = (list) => [...new Set(list.map(ctorName).filter((n) => n))].sort();
  // kept small: under --unsafe thousands of paths are unfrozen, and the
  // output is cut at 64 KiB when piped (see the report of this phase)
  const result = {
    unfrozenCount: unfrozen.length,
    unfrozen: unfrozen.slice(0, 60),
    labelsUnfrozen: ${JSON.stringify(WALK_LABELS)}.filter((l) => unfrozen.includes(l)),
    visited,
    protos: protos.size,
    gettersTaken,
    sharedFunctions,
    roots,
    rootFailures,
    protoNames: names([...protos]),
    unfrozenProtoNames: names([...protos].filter((o) => !Object.isFrozen(o))),
  };
  return [{ json: result }];
} finally {
  clearTimeout(tmo);
  clearImmediate(imm);
}
`;

// Measured 2026-11-06 on Node 26.7.0, sandboxed, before the freeze: 2035
// objects visited, 270 prototypes checked, 1882 getter results taken, 1619
// shared functions checked (--unsafe: 2593 / 399 / 2442 / 2058). About half of the sandboxed counts leaves room for other
// Node and Luxon versions without letting a walk that broke early pass.
const VISITED_FLOOR = 1000;
const PROTOS_FLOOR = 135;
const GETTERS_FLOOR = 900;
const FUNCTIONS_FLOOR = 800;

// (d) roots: each must be built in both modes
const WALK_ROOTS = [
  "ArrayIterator", "StringIterator", "MapIterator", "SetIterator", "RegExpStringIterator", "IteratorHelper",
  "setTimeout()", "setImmediate()", "performance.mark()", "performance.measure()", "AbortController", "Buffer.alloc(-1) error",
  "TextEncoderStream", "ReadableStream", "WritableStream", "ReadableStreamDefaultReader", "WritableStreamDefaultWriter",
  "CryptoKey", "Intl.Segments", "Intl.SegmentIterator", "Iterator.from wrapper", "Luxon IANAZone", "Luxon Invalid",
];
// prototypes the walk must reach, by constructor name. SubtleCrypto is only
// reachable through the `crypto.subtle` getter and TimersList only through a
// live timer handle, so these two prove the walk's extensions are on.
const WALK_PROTO_NAMES = [
  "SubtleCrypto", "TimersList", "Timeout", "Immediate", "PerformanceMark", "PerformanceMeasure", "AbortSignal", "EventTarget",
  "ReadableStream", "WritableStream", "ReadableStreamDefaultReader", "WritableStreamDefaultWriter", "TextEncoderStream",
  "CryptoKey", "IANAZone", "Invalid", "Locale", "DateTime",
];

interface WalkResult {
  unfrozenCount: number;
  unfrozen: string[];
  labelsUnfrozen: string[];
  visited: number;
  protos: number;
  gettersTaken: number;
  sharedFunctions: number;
  roots: Record<string, boolean>;
  rootFailures: string[];
  protoNames: string[];
  unfrozenProtoNames: string[];
}

/** The walk's own health, the same in both modes: every extension really ran. */
function assertWalkRan(w: WalkResult, mode: string): void {
  assert.deepEqual(w.rootFailures, [], `${mode}: walk roots that could not be built`);
  assert.deepEqual(WALK_ROOTS.filter((k) => w.roots[k] !== true), [], `${mode}: walk roots not reached`);
  const missing = WALK_PROTO_NAMES.filter((n) => !w.protoNames.includes(n));
  assert.deepEqual(missing, [], `${mode}: prototypes the walk never reached (reached: ${w.protoNames.join(", ")})`);
  // a walk that visited nothing would also find nothing — make "off" readable
  assert.ok(w.visited > VISITED_FLOOR, `${mode}: the walk must actually walk (visited ${w.visited})`);
  assert.ok(w.protos > PROTOS_FLOOR, `${mode}: the walk must check prototypes (checked ${w.protos})`);
  assert.ok(w.gettersTaken > GETTERS_FLOOR, `${mode}: the walk must call getters on built-ins (took ${w.gettersTaken})`);
  assert.ok(w.sharedFunctions > FUNCTIONS_FLOOR, `${mode}: the walk must check shared functions (checked ${w.sharedFunctions})`);
}

describe("node run frozen: every shared object the body can reach is frozen", () => {
  let sandboxed: WalkResult;
  let unsafe: WalkResult;
  before(async () => {
    const [a, b] = await both("walk/walk.js", WALK_BODY);
    sandboxed = probeResult<WalkResult>(a);
    unsafe = probeResult<WalkResult>(b);
  });

  it("the walk reaches every root and extension (sandboxed)", () => assertWalkRan(sandboxed, "sandboxed"));

  it("the reachability walk finds no unfrozen prototype, function or namespace object", () => {
    const w = sandboxed;
    assert.equal(w.unfrozenCount, 0, `${w.unfrozenCount} unfrozen and reachable from the sandboxed body; first ${w.unfrozen.length}:\n  ${w.unfrozen.join("\n  ")}`);
  });

  it("--unsafe control: the same walk reaches every root and extension", () => assertWalkRan(unsafe, "--unsafe"));

  it("--unsafe control: the getter- and instance-only prototypes are found unfrozen there", () => {
    const missing = WALK_PROTO_NAMES.filter((n) => !unsafe.unfrozenProtoNames.includes(n));
    assert.deepEqual(missing, [], "each must read as unfrozen in the CLI's own realm, or the sandboxed check proves nothing about it");
    assert.deepEqual(unsafe.labelsUnfrozen, WALK_LABELS, "each labelled prototype must read as unfrozen under --unsafe");
  });
});

// ---------------------------------------------------------------------------
// 3. Write attempts against representative shared objects.

// Each target is an expression the body evaluates. The three instance-only
// ones (EventTarget, Timeout, the array iterator) have no global name in the
// sandbox, so they are reached the way an attacker would: through an instance.
const TARGETS: Array<[string, string]> = [
  ["Object.prototype", "Object.prototype"],
  ["Function.prototype", "Function.prototype"],
  ["Array.prototype", "Array.prototype"],
  ["Promise.prototype", "Promise.prototype"],
  ["String.prototype", "String.prototype"],
  ["RegExp.prototype", "RegExp.prototype"],
  ["Error", "Error"],
  ["Error.prototype", "Error.prototype"],
  ["JSON", "JSON"],
  ["Reflect", "Reflect"],
  ["Math", "Math"],
  ["Intl.DateTimeFormat.prototype", "Intl.DateTimeFormat.prototype"],
  ["EventTarget.prototype", "Object.getPrototypeOf(Object.getPrototypeOf(new AbortController().signal))"],
  ["Buffer.prototype", "Buffer.prototype"],
  ["Timeout.prototype", "(() => { const t = setTimeout(Math.max, 0); clearTimeout(t); return Object.getPrototypeOf(t); })()"],
  ["ArrayIterator.prototype", "Object.getPrototypeOf([][Symbol.iterator]())"],
  ["DateTime.prototype", "DateTime.prototype"],
];

// The key is unique and removed in the same synchronous step that added it, so
// the --unsafe twin leaves the CLI's realm as it found it.
const WRITE_BODY = `
const KEY = "__decanterFrozenProbe";
const res = {};
const attempt = (t, how) => {
  let threw = null;
  try { how(t); } catch (e) { threw = e?.name ?? String(e); }
  const had = Object.hasOwn(t, KEY);
  if (had) delete t[KEY];
  return { threw, had, clean: !Object.hasOwn(t, KEY) };
};
${TARGETS.map(([label, expr]) => `res[${JSON.stringify(label)}] = (() => {
  const t = (${expr});
  if (t === null || (typeof t !== "object" && typeof t !== "function")) return { missing: String(t) };
  return {
    frozen: Object.isFrozen(t),
    define: attempt(t, (o) => Object.defineProperty(o, KEY, { value: 1, configurable: true })),
    strict: attempt(t, (o) => { "use strict"; o[KEY] = 1; }),
    sloppy: attempt(t, (o) => { o[KEY] = 1; }),
  };
})();`).join("\n")}
return [{ json: res }];
`;

interface Attempt {
  threw: string | null;
  had: boolean;
  clean: boolean;
}
interface WriteResult {
  missing?: string;
  frozen: boolean;
  define: Attempt;
  strict: Attempt;
  sloppy: Attempt;
}

describe("node run frozen: writes to shared objects are refused", () => {
  let sandboxed: Record<string, WriteResult>;
  let unsafe: Record<string, WriteResult>;
  before(async () => {
    const [a, b] = await both("write/write.js", WRITE_BODY);
    sandboxed = probeResult<Record<string, WriteResult>>(a);
    unsafe = probeResult<Record<string, WriteResult>>(b);
  });

  for (const [label] of TARGETS) {
    it(`${label}: frozen; defineProperty and strict assignment throw TypeError, sloppy assignment has no effect`, () => {
      const w = sandboxed[label];
      assert.ok(w && w.missing === undefined, `${label} must be reachable from the body: ${JSON.stringify(w)}`);
      assert.deepEqual(
        { frozen: w.frozen, define: w.define, strict: w.strict, sloppy: w.sloppy },
        {
          frozen: true,
          define: { threw: "TypeError", had: false, clean: true },
          strict: { threw: "TypeError", had: false, clean: true },
          sloppy: { threw: null, had: false, clean: true },
        },
        label,
      );
    });

    it(`--unsafe twin: ${label} takes all three writes`, () => {
      const w = unsafe[label];
      assert.ok(w && w.missing === undefined, `${label} must be reachable under --unsafe: ${JSON.stringify(w)}`);
      const ok: Attempt = { threw: null, had: true, clean: true };
      assert.deepEqual({ frozen: w.frozen, define: w.define, strict: w.strict, sloppy: w.sloppy }, { frozen: false, define: ok, strict: ok, sloppy: ok }, label);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Stack-trace hooks and limits on Error itself.

// Assigning the hook straight onto Error is how most stack-trace tricks start;
// the sibling tests in run-sandbox.test.mts install it by rebinding the global
// instead, which still works and must still see no runner frame.
const STACK_BODY = `
${PROBE_PRELUDE}
const origLimit = Error.stackTraceLimit;
const hadHook = Object.hasOwn(Error, "prepareStackTrace");
const origHook = Error.prepareStackTrace;
const restore = () => {
  if (hadHook) Error.prepareStackTrace = origHook; else delete Error.prepareStackTrace;
  Error.stackTraceLimit = origLimit;
};
Error.prepareStackTrace = () => "HOOKED";
const sloppyHook = new Error("x").stack === "HOOKED";
restore();
probe("strict hook", () => { "use strict"; Error.prepareStackTrace = () => "HOOKED"; return true; });
const strictHook = new Error("x").stack === "HOOKED";
restore();
Error.stackTraceLimit = 0;
const sloppyLimit = Error.stackTraceLimit;
restore();
probe("strict limit", () => { "use strict"; Error.stackTraceLimit = 0; return true; });
restore();
return [{ json: { sloppyHook, strictHook, sloppyLimitChanged: sloppyLimit !== origLimit, strict: r, restored: Error.stackTraceLimit === origLimit && Error.prepareStackTrace === origHook } }];
`;

interface StackResult {
  sloppyHook: boolean;
  strictHook: boolean;
  sloppyLimitChanged: boolean;
  strict: Record<string, Outcome>;
  restored: boolean;
}

describe("node run frozen: Error.prepareStackTrace and Error.stackTraceLimit", () => {
  let sandboxed: StackResult;
  let unsafe: StackResult;
  before(async () => {
    const [a, b] = await both("stack/stack.js", STACK_BODY);
    sandboxed = probeResult<StackResult>(a);
    unsafe = probeResult<StackResult>(b);
  });

  it("assigning Error.prepareStackTrace has no effect (sloppy) and throws TypeError (strict)", () => {
    assert.equal(sandboxed.sloppyHook, false, "a sloppy Error.prepareStackTrace assignment took effect");
    assert.equal(sandboxed.strictHook, false, "a strict Error.prepareStackTrace assignment took effect");
    assertTypeError(sandboxed.strict["strict hook"], "strict Error.prepareStackTrace =");
  });

  it("assigning Error.stackTraceLimit has no effect (sloppy) and throws TypeError (strict)", () => {
    assert.equal(sandboxed.sloppyLimitChanged, false, "a sloppy Error.stackTraceLimit assignment took effect");
    assertTypeError(sandboxed.strict["strict limit"], "strict Error.stackTraceLimit =");
  });

  it("--unsafe twin: both assignments take effect, and are restored", () => {
    assert.deepEqual(
      { sloppyHook: unsafe.sloppyHook, strictHook: unsafe.strictHook, sloppyLimitChanged: unsafe.sloppyLimitChanged, restored: unsafe.restored },
      { sloppyHook: true, strictHook: true, sloppyLimitChanged: true, restored: true },
    );
    assert.equal(unsafe.strict["strict hook"]?.ok, true);
    assert.equal(unsafe.strict["strict limit"]?.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 5. Override names: a plain freeze would break these, so they must stay
//    assignable on instances (contract point 2).

// Node's own warning code assigns `warning.name`, the text stream codecs
// assign `constructor`, and every Error subclass assigns `this.name`. A plain
// Object.freeze of the prototypes turns each into a TypeError (strict) or a
// silent no-op (sloppy) — so each case prints its result and must match
// --unsafe byte for byte, and the expected values are pinned too, so two
// equally broken runs cannot pass.
const OVERRIDE_BODY = `
${PROBE_PRELUDE}
probe("Buffer(1)", () => Buffer(1).length);
const stream = async (codec, chunk) => {
  const w = codec.writable.getWriter();
  const rd = codec.readable.getReader();
  w.write(chunk);
  w.close();
  const out = [];
  for (;;) { const { done, value } = await rd.read(); if (done) break; out.push(value); }
  return out;
};
let streams;
try {
  const bytes = await stream(new TextEncoderStream(), "héllo €");
  const text = await stream(new TextDecoderStream(), bytes[0]);
  streams = { ok: true, v: { bytes: bytes.map((b) => b.length), text: text.join("") } };
} catch (e) { streams = { ok: false, name: e?.name ?? null, msg: String(e?.message ?? e) }; }
r.streams = streams;
probe("Error subclass", () => {
  class E extends Error { constructor(m) { super(m); this.name = "E"; } }
  try { throw new E("boom"); } catch (e) { return { name: e.name, message: e.message, str: String(e), own: Object.hasOwn(e, "name"), isE: e instanceof E }; }
});
probe("sloppy error fields", () => { const e = new Error("early"); e.name = "X"; e.message = "late"; return String(e); });
// no argument means no own message: the assignment lands on Error.prototype's
// \`message\`, which is the enablement the freeze has to add
probe("message on a bare Error (sloppy)", () => { const e = new Error(); e.message = "late"; return { str: String(e), own: Object.hasOwn(e, "message") }; });
probe("message on a bare Error (strict)", () => { "use strict"; const e = new Error(); e.message = "late"; return { str: String(e), own: Object.hasOwn(e, "message") }; });
probe("Error subclass sets message", () => {
  "use strict";
  class M extends Error { constructor() { super(); this.message = "m"; } }
  const e = new M();
  return { str: String(e), message: e.message, own: Object.hasOwn(e, "message") };
});
// Function.prototype.toString and Array.prototype.toString are the other two
// enablements a body plausibly shadows
probe("function and array toString (strict)", () => {
  "use strict";
  const fn = function () {};
  fn.toString = () => "F";
  const a = [];
  a.toString = () => "A";
  return \`\${fn}|\${a}|\${String([1, 2])}\`;
});
probe("function and array toString (sloppy)", () => { const fn = function () {}; fn.toString = () => "f"; const a = [1]; a.toString = () => "a"; return \`\${fn}|\${a}\`; });
probe("plain object overrides", () => {
  const o = {};
  o.toString = () => "T";
  o.valueOf = () => 41;
  o.constructor = "C";
  o.toLocaleString = () => "L";
  return { str: String(o), plus: o + 1, ctor: o.constructor, loc: o.toLocaleString(), keys: Object.keys(o) };
});
probe("strict object overrides", () => {
  "use strict";
  const o = {};
  o.toString = () => "S";
  o.name = "N";
  o.message = "M";
  return \`\${o}\${o.name}\${o.message}\`;
});
probe("function name", () => { const f = function () {}; Object.defineProperty(f, "name", { value: "renamed" }); return f.name; });
console.log("override", JSON.stringify(r));
return [{ json: r }];
`;

const OVERRIDE_EXPECTED: Record<string, Outcome> = {
  "Buffer(1)": { ok: true, v: 1 },
  streams: { ok: true, v: { bytes: [10], text: "héllo €" } },
  "Error subclass": { ok: true, v: { name: "E", message: "boom", str: "E: boom", own: true, isE: true } },
  "sloppy error fields": { ok: true, v: "X: late" },
  "message on a bare Error (sloppy)": { ok: true, v: { str: "Error: late", own: true } },
  "message on a bare Error (strict)": { ok: true, v: { str: "Error: late", own: true } },
  "Error subclass sets message": { ok: true, v: { str: "Error: m", message: "m", own: true } },
  "function and array toString (strict)": { ok: true, v: "F|A|1,2" },
  "function and array toString (sloppy)": { ok: true, v: "f|a" },
  "plain object overrides": { ok: true, v: { str: "T", plus: 42, ctor: "C", loc: "L", keys: ["toString", "valueOf", "constructor", "toLocaleString"] } },
  "strict object overrides": { ok: true, v: "SNM" },
  "function name": { ok: true, v: "renamed" },
};

// The override setter must refuse the frozen object itself: otherwise
// `Error.prototype.name = …` would rename every error the runner formats. An
// accessor cannot tell the caller's mode, so the refusal is a TypeError in
// sloppy code as well (contract point 2). The restores only matter under
// --unsafe; sandboxed they throw the same TypeError, so they are guarded.
const PROTO_NAME_BODY = `
${PROBE_PRELUDE}
const restore = () => { try { Error.prototype.name = "Error"; } catch {} };
probe("strict", () => { "use strict"; Error.prototype.name = "Y"; return true; });
const afterStrict = new Error().name;
restore();
probe("sloppy", () => { Error.prototype.name = "Z"; return true; });
const afterSloppy = new Error().name;
restore();
return [{ json: { r, afterStrict, afterSloppy, restored: new Error().name } }];
`;

interface ProtoNameResult {
  r: Record<string, Outcome>;
  afterStrict: string;
  afterSloppy: string;
  restored: string;
}

describe("node run frozen: override names stay assignable on instances", () => {
  it("Buffer(1), the text stream codecs, Error subclasses and own toString/valueOf/constructor print the same as --unsafe", async () => {
    const [sandboxed, unsafe] = await both("override/override.js", OVERRIDE_BODY);
    assert.equal(sandboxed.code, 0, sandboxed.stdout + sandboxed.stderr);
    assert.equal(unsafe.code, 0, unsafe.stdout + unsafe.stderr);
    assert.deepEqual(probeResult(sandboxed), OVERRIDE_EXPECTED);
    assert.equal(sandboxed.stdout, unsafe.stdout, "stdout must be byte-identical between the sandbox and --unsafe");
  });

  it("the override setter refuses the prototype itself: Error.prototype.name stays \"Error\"", async () => {
    const res = probeResult<ProtoNameResult>(await cli(["node", "run", put("override/proto.js", PROTO_NAME_BODY)]));
    assertTypeError(res.r.strict, "strict Error.prototype.name =");
    assertTypeError(res.r.sloppy, "sloppy Error.prototype.name =");
    assert.deepEqual({ afterStrict: res.afterStrict, afterSloppy: res.afterSloppy, restored: res.restored }, { afterStrict: "Error", afterSloppy: "Error", restored: "Error" });
  });

  it("--unsafe twin: Error.prototype.name is assignable there, and is restored", async () => {
    const res = probeResult<ProtoNameResult>(await cli(["node", "run", put("override/proto.js", PROTO_NAME_BODY), "--unsafe"]));
    assert.deepEqual(
      { strict: res.r.strict, sloppy: res.r.sloppy, afterStrict: res.afterStrict, afterSloppy: res.afterSloppy, restored: res.restored },
      { strict: { ok: true, v: true }, sloppy: { ok: true, v: true }, afterStrict: "Y", afterSloppy: "Z", restored: "Error" },
    );
  });
});

// The override accessors run inside Node's own code (the warning path) and the
// runner's. `globalThis` stays writable, so a setter that looked up `Object` or
// `Reflect` at call time would call whatever the body put there. The body
// rebinds both to recorders and runs what goes through the setters; nothing may
// reach a recorder, and the results must equal a control run after the restore.
const RECORDER_BODY = `
const RealObject = Object;
const RealReflect = Reflect;
const RGet = Reflect.get;
const RApply = Reflect.apply;
const RConstruct = Reflect.construct;
const hasOwn = Object.hasOwn;
const fired = [];
const recorder = (label, real) => new Proxy(real, {
  get(t, k) { fired.push(label + "." + String(k)); return RGet(t, k); },
  apply(t, self, args) { fired.push(label + "()"); return RApply(t, self, args); },
  construct(t, args, nt) { fired.push("new " + label); return RConstruct(t, args, nt); },
});
const run = () => {
  const out = {};
  try { out.buf = Buffer(1).length; } catch (e) { out.buf = String(e?.name) + ": " + String(e?.message); }
  try {
    const e = new Error("m");
    e.name = "x";
    e.message = "y";
    out.err = String(e);
    out.own = hasOwn(e, "name") && hasOwn(e, "message");
  } catch (e) { out.err = String(e?.name) + ": " + String(e?.message); }
  return out;
};
let rebound;
let recorded;
globalThis.Reflect = recorder("Reflect", RealReflect);
globalThis.Object = recorder("Object", RealObject);
try {
  rebound = globalThis.Object !== RealObject && globalThis.Reflect !== RealReflect;
  // the positive control: one read of our own, so "nothing else fired" is a
  // statement about a recorder that demonstrably records
  void globalThis.Reflect.ownKeys;
  // Buffer(1) first: DEP0005 is emitted once per process, so only this call
  // takes the warning path that assigns \`warning.name\`
  recorded = run();
} finally {
  globalThis.Reflect = RealReflect;
  globalThis.Object = RealObject;
}
const firedDuring = fired.slice();
return [{ json: { rebound, fired: firedDuring, recorded, control: run(), restored: globalThis.Object === RealObject && globalThis.Reflect === RealReflect } }];
`;

describe("node run frozen: the override accessors use no global looked up at call time", () => {
  it("rebinding Object and Reflect to recorders changes nothing for Buffer(1) or an Error's name/message", async () => {
    const res = probeResult<{ rebound: boolean; fired: string[]; recorded: unknown; control: unknown; restored: boolean }>(await cli(["node", "run", put("recorder/recorder.js", RECORDER_BODY)]));
    assert.equal(res.rebound, true, "the recorders must actually be installed, or this proves nothing");
    assert.deepEqual(res.fired, ["Reflect.ownKeys"], "only the body's own control read may reach a recorder; anything else means an accessor or Node's warning path called a global the body had rebound");
    assert.deepEqual(res.recorded, { buf: 1, err: "x: y", own: true });
    assert.deepEqual(res.recorded, res.control, "the results must not depend on what the globals are bound to");
    assert.equal(res.restored, true);
  });
});

// ---------------------------------------------------------------------------
// 6. Fidelity: real node code runs the same under the freeze.

// Every library and built-in a Code node leans on, in one body. A freeze that
// broke any of them (Luxon caches on its prototypes' instances, URL and Buffer
// assign internals) shows up as a stdout difference against --unsafe.
// Per-run data stays mutable (contract point 4): \`$json\`, the input items,
// the static-data object and an instance built from fixture data, sloppy and
// strict. A freeze that froze every visited object except globalThis would pass
// every other test here, and break every node that annotates its items.
const MUTATE = `
let mut;
try {
  $json.x = 1;
  $input.first().json.z = 2;
  for (const it of $input.all()) { it.json.w = 3; it.tag = "t"; }
  const sd = $getWorkflowStaticData("global");
  sd.count = (sd.count ?? 0) + 1;
  const inst = DateTime.fromISO($input.first().json.at ?? "2024-01-01T00:00:00.000Z", { zone: "utc" });
  inst.note = "n";
  (function () {
    "use strict";
    $json.xs = 1;
    $input.first().json.zs = 2;
    for (const it of $input.all()) it.json.ws = 4;
    sd.strict = (sd.strict ?? 0) + 1;
    inst.noteS = "s";
  })();
  mut = { ok: true, x: [$json.x, $json.xs], first: [$input.first().json.z, $input.first().json.zs], all: $input.all().map((it) => [it.json.w, it.json.ws, it.tag]), count: sd.count, strict: sd.strict, note: inst.note + inst.noteS };
} catch (e) { mut = { ok: false, name: e?.name ?? null, msg: String(e?.message ?? e) }; }
`;

const FIDELITY_BODY = `
${MUTATE}
const dt = DateTime.fromISO("2024-03-10T12:00:00.000Z", { zone: "utc" });
const later = dt.plus({ days: 1, hours: 3 });
const lux = {
  iso: later.toISO(),
  berlin: later.setZone("Europe/Berlin").toISO(),
  fmt: later.setLocale("de").toFormat("cccc, d. LLLL yyyy HH:mm"),
  rel: dt.toRelative({ base: dt.plus({ days: 3 }), locale: "de" }),
  dur: Duration.fromObject({ minutes: 90 }).shiftTo("hours", "minutes").toObject(),
  ivl: Interval.fromDateTimes(dt, later).length("hours"),
};
console.log("luxon", lux.fmt);
const jm = $jmespath({ a: [{ b: 1 }, { b: 2 }, { b: 3 }] }, "a[?b > \`1\`].b");
const buf = { b64: Buffer.from("héllo").toString("base64"), hex: Buffer.alloc(3, 1).toString("hex"), cat: Buffer.concat([Buffer.from("a"), Buffer.from("b")]).toString() };
const u = new URL("https://user@x.test:8443/a/b?c=1&d=two#frag");
u.searchParams.append("e", "3");
const url = { href: u.href, host: u.host, d: u.searchParams.get("d") };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID());
const waited = await new Promise((resolve) => setTimeout(() => resolve("tick"), 5));
class P { #x = 1; y = 2; static z = 3; get x() { return this.#x; } bump() { this.#x++; return this; } }
const p = new P().bump();
const coll = {
  sorted: [3, 1, 2].toSorted(),
  flat: [[1], [2, [3]]].flat(2),
  at: [1, 2, 3].at(-1),
  map: [...new Map([["k", 1], ["j", 2]]).entries()],
  set: [...new Set([1, 2, 2, 3])],
  grouped: Object.groupBy([1, 2, 3, 4], (n) => (n % 2 ? "odd" : "even")),
  fromEntries: Object.fromEntries([["a", 1]]),
  clone: structuredClone({ d: new Date(0).toISOString(), n: [1] }),
  num: new Intl.NumberFormat("de-DE").format(1234567.891),
};
console.log("collections", JSON.stringify(coll));
return $input.all().map((item, i) => ({ json: { i, v: item.json.v, lux, jm, buf, url, uuid, waited, cls: { x: p.x, y: p.y, z: P.z }, coll, mut } }));
`;

const PER_ITEM_BODY = `
${MUTATE}
const d = DateTime.fromISO($json.at, { zone: "utc" }).plus({ hours: $itemIndex });
console.log("item", $itemIndex);
return { json: { i: $itemIndex, at: d.toISO(), up: String($json.name).toUpperCase(), b64: Buffer.from($json.name).toString("base64"), mut } };
`;

describe("node run frozen: node code behaves the same under the freeze", () => {
  it("Luxon, jmespath, Buffer, URL, crypto, timers, classes and collections: byte-identical stdout", async () => {
    const fx = put("fidelity/fx.json", JSON.stringify({ input: [{ json: { v: 1 } }, { json: { v: 2 } }] }));
    const [sandboxed, unsafe] = await both("fidelity/all.js", FIDELITY_BODY, [fx]);
    assert.equal(sandboxed.code, 0, sandboxed.stdout + sandboxed.stderr);
    assert.equal(unsafe.code, 0, unsafe.stdout + unsafe.stderr);
    assert.match(sandboxed.stdout, /luxon Montag, 11\. März 2024 15:00/);
    assert.match(sandboxed.stdout, /returned 2 items:/);
    const [first] = printed(sandboxed) as Array<{ json: { uuid: boolean; jm: number[]; waited: string; lux: { rel: string }; mut: unknown } }>;
    assert.deepEqual(first.json.mut, { ok: true, x: [1, 1], first: [2, 2], all: [[3, 4, "t"], [3, 4, "t"]], count: 1, strict: 1, note: "ns" }, "per-run data must stay mutable, sloppy and strict");
    assert.deepEqual({ uuid: first.json.uuid, jm: first.json.jm, waited: first.json.waited, rel: first.json.lux.rel }, { uuid: true, jm: [2, 3], waited: "tick", rel: "vor 3 Tagen" });
    assert.equal(sandboxed.stdout, unsafe.stdout, "stdout must be byte-identical between the sandbox and --unsafe");
  });

  it("per-item mode: byte-identical stdout", async () => {
    put(
      "fidelity-each/workflow.json",
      JSON.stringify({ nodes: [{ id: "e", name: "Each", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { mode: "runOnceForEachItem", jsCode: "//@file:each.js" } }] }),
    );
    const fx = put("fidelity-each/fx.json", JSON.stringify({ input: [{ json: { at: "2024-01-01T00:00:00.000Z", name: "a" } }, { json: { at: "2024-06-01T00:00:00.000Z", name: "bé" } }] }));
    const [sandboxed, unsafe] = await both("fidelity-each/each.js", PER_ITEM_BODY, [fx]);
    assert.equal(sandboxed.code, 0, sandboxed.stdout + sandboxed.stderr);
    assert.equal(unsafe.code, 0, unsafe.stdout + unsafe.stderr);
    assert.match(sandboxed.stdout, /runOnceForEachItem[\s\S]*returned 2 items:/);
    const muts = (printed(sandboxed) as Array<{ json: { mut: unknown } }>).map((o) => o.json.mut);
    const item = (count: number) => ({ ok: true, x: [1, 1], first: [2, 2], all: [[3, 4, "t"], [3, 4, "t"]], count, strict: count, note: "ns" });
    assert.deepEqual(muts, [item(1), item(2)], "per-run data must stay mutable in per-item mode, and static data carries across items");
    assert.deepEqual(
      (printed(sandboxed) as Array<{ json: { i: number; at: string } }>).map((o) => [o.json.i, o.json.at]),
      [
        [0, "2024-01-01T00:00:00.000Z"],
        [1, "2024-06-01T01:00:00.000Z"],
      ],
    );
    assert.equal(sandboxed.stdout, unsafe.stdout, "stdout must be byte-identical between the sandbox and --unsafe");
  });
});
