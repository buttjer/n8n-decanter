// Plan 31 — `node run` executes the node body in a sandbox by default and only
// with `--unsafe` in the CLI's own process. Every test drives the real CLI as a
// subprocess (never imports lib/), because the boundary is a property of the
// process the user runs, not of a function.
//
// The escape vectors are caught INSIDE the body and returned as data, so these
// tests do not depend on the friendly boundary messages (that is
// run-sandbox-errors.test.mts). Every vector asserts the specific failure
// (a ReferenceError, `typeof … === "undefined"`, the import-lock error code),
// never just "it threw" — `fetch("http://x")` rejects on DNS anyway.
//
// Most vectors have an `--unsafe` twin that asserts the capability IS there:
// without it a vector that is "blocked" because the probe itself is broken
// would read the same as one blocked by the sandbox.
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
const BUILT_CLI = path.join(ROOT, "dist", "n8n-decanter.mjs");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-run-sandbox-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** The error code the import lock's resolve hook throws (contract). */
const IMPORT_CODE = "ERR_DECANTER_SANDBOX_IMPORT";
/** A variable only this test sets in the child's environment. */
const HOST_VAR = "DECANTER_SANDBOX_TEST_VAR";

interface Res {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI (checkout layout unless `entry` says otherwise); never throws on a non-zero exit. */
async function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; entry?: string } = {}): Promise<Res> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  delete env.N8N_DECANTER_DIR;
  // colour must not depend on the caller's shell: with FORCE_COLOR=1 the
  // in-process console colours `{ a: 2 }`, so byte-identity would hold by luck
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;
  try {
    const r = await execFileP(process.execPath, [opts.entry ?? CLI, ...args], { cwd: opts.cwd ?? TMP, env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
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

interface Outcome {
  ok: boolean;
  type?: string;
  name?: string | null;
  code?: string | null;
  msg?: string;
}

// `probe(key, f)` awaits f() inside the body and records either the type of
// what it returned or the error's name/code/message. Shared by every probe body.
const PROBE_PRELUDE = `
const r = {};
const probe = async (k, f) => {
  try { const v = await f(); r[k] = { ok: true, type: typeof v }; }
  catch (e) { r[k] = { ok: false, name: e?.name ?? null, code: e?.code ?? null, msg: String(e?.message ?? e) }; }
};
`;

type Blocked = { kind: "notDefined"; name: string } | { kind: "undefined" } | { kind: "import" };

interface Vector {
  key: string;
  expr: string;
  blocked: Blocked;
  /** typeof the expression's value under --unsafe; absent = no twin. */
  unsafe?: string;
}

const notDefined = (name: string): Blocked => ({ kind: "notDefined", name });

// Relative specifiers resolve against the module that BUILT the function — in
// the sandbox that is the worker entry under lib/, today lib/run.mts — so
// `./run.mts` / `./globals.mts` are the dangerous relative imports, not a file
// next to the node. node:worker_threads, node:module, node:util, luxon and
// jmespath are what the worker itself already loaded: a lock that only
// refuses NEW specifiers would let them through from the module cache.
const VECTORS: Vector[] = [
  { key: "process", expr: "process.pid", blocked: notDefined("process"), unsafe: "number" },
  { key: "globalThis.process", expr: "globalThis.process", blocked: { kind: "undefined" }, unsafe: "object" },
  { key: "require", expr: "require", blocked: notDefined("require") }, // undefined in both modes (ESM) — no twin
  { key: "eval", expr: 'eval("process").pid', blocked: notDefined("process"), unsafe: "number" },
  { key: "this.constructor.constructor", expr: 'this.constructor.constructor("return process")().pid', blocked: notDefined("process"), unsafe: "number" },
  { key: "$input.all.constructor.constructor", expr: '$input.all.constructor.constructor("return process")().pid', blocked: notDefined("process"), unsafe: "number" },
  { key: "DateTime.constructor.constructor", expr: 'DateTime.constructor.constructor("return process")().pid', blocked: notDefined("process"), unsafe: "number" },
  { key: "Function(import)", expr: `Function("return import('node:fs')")().then((m) => m.readFileSync)`, blocked: { kind: "import" }, unsafe: "function" },
  { key: "import node:fs", expr: 'import("node:fs").then((m) => m.readFileSync)', blocked: { kind: "import" }, unsafe: "function" },
  { key: "import data:", expr: 'import("data:text/javascript,export default 1").then((m) => m.default)', blocked: { kind: "import" }, unsafe: "number" },
  { key: "import node:worker_threads", expr: 'import("node:worker_threads").then((m) => m.Worker)', blocked: { kind: "import" }, unsafe: "function" },
  { key: "import node:module", expr: 'import("node:module").then((m) => m.createRequire)', blocked: { kind: "import" }, unsafe: "function" },
  { key: "import node:util", expr: 'import("node:util").then((m) => m.inspect)', blocked: { kind: "import" }, unsafe: "function" },
  { key: "import luxon", expr: 'import("luxon").then((m) => m.DateTime)', blocked: { kind: "import" }, unsafe: "function" },
  { key: "import jmespath", expr: 'import("jmespath").then((m) => m.search)', blocked: { kind: "import" }, unsafe: "function" },
  { key: "import ./run.mts", expr: 'import("./run.mts").then((m) => m.runNode)', blocked: { kind: "import" }, unsafe: "function" },
  // lib/globals.mts may not exist (it does not today): blocked by the lock
  // either way, and under --unsafe "not found" proves nothing — no twin.
  { key: "import ./globals.mts", expr: 'import("./globals.mts")', blocked: { kind: "import" } },
];

// I/O- or channel-carrying web globals. `fetch`/`process`/`require` ride
// along so one typeof table answers the whole "is it there" question.
const TYPEOF_NAMES = [
  "fetch", "WebSocket", "EventSource", "BroadcastChannel", "MessageChannel", "MessagePort",
  "Request", "Response", "Headers", "navigator", "localStorage", "sessionStorage", "Worker",
  "process", "require", "FormData",
];
// Pure globals the allowlist keeps (n8n's runner has them too): a scrub that
// deleted these would pass every escape test and break real nodes.
const PRESENT_NAMES = [
  "Buffer", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate",
  "queueMicrotask", "URL", "TextEncoder", "TextDecoder", "structuredClone", "crypto", "atob", "btoa", "AbortController",
];
/** typeof each under --unsafe (only the ones the brief pins). */
const TYPEOF_UNSAFE: Record<string, string> = { fetch: "function", WebSocket: "function", process: "object" };

const VECTOR_BODY =
  PROBE_PRELUDE +
  VECTORS.map((v) => `await probe(${JSON.stringify(v.key)}, () => (${v.expr}));`).join("\n") +
  `\nr.types = { ${TYPEOF_NAMES.map((n) => `${JSON.stringify(n)}: typeof ${n}`).join(", ")} };\n` +
  `r.present = { ${PRESENT_NAMES.map((n) => `${JSON.stringify(n)}: typeof ${n}`).join(", ")} };\n` +
  // --unsafe must really be in-process; refused in the sandbox (already a vector)
  'r.isMainThread = await import("node:worker_threads").then((m) => m.isMainThread, () => "refused");\n' +
  "return [{ json: r }];\n";

type VectorResult = Record<string, Outcome> & { types: Record<string, string>; present: Record<string, string>; isMainThread: boolean | string };

function assertBlocked(v: Vector, o: Outcome | undefined, where = ""): void {
  const label = `${where}${v.key}: ${JSON.stringify(o)}`;
  assert.ok(o, `no result for ${label}`);
  if (v.blocked.kind === "notDefined") {
    assert.equal(o.ok, false, `must be blocked — ${label}`);
    assert.equal(o.name, "ReferenceError", `must be a ReferenceError — ${label}`);
    assert.match(o.msg ?? "", new RegExp(`\\b${v.blocked.name} is not defined`), `must name the missing global — ${label}`);
  } else if (v.blocked.kind === "undefined") {
    assert.deepEqual({ ok: o.ok, type: o.type }, { ok: true, type: "undefined" }, `must read as undefined — ${label}`);
  } else {
    assert.equal(o.ok, false, `import must be refused — ${label}`);
    assert.equal(o.code, IMPORT_CODE, `must be refused by the import lock — ${label}`);
  }
}

describe("node run: escape vectors (checkout layout)", () => {
  let sandboxed: VectorResult;
  let unsafe: VectorResult;
  before(async () => {
    const file = put("vectors/vectors.js", VECTOR_BODY);
    const [a, b] = await Promise.all([cli(["node", "run", file]), cli(["node", "run", "--unsafe", file])]);
    sandboxed = probeResult<VectorResult>(a);
    unsafe = probeResult<VectorResult>(b);
  });

  for (const v of VECTORS) {
    it(`blocks ${v.key} by default`, () => assertBlocked(v, sandboxed[v.key]));
    const twin = v.unsafe;
    if (twin !== undefined) {
      it(`--unsafe twin: ${v.key} reaches the host`, () => {
        assert.deepEqual({ ok: unsafe[v.key]?.ok, type: unsafe[v.key]?.type }, { ok: true, type: twin }, `${v.key}: ${JSON.stringify(unsafe[v.key])}`);
      });
    }
  }

  it("every I/O / channel global is typeof undefined by default", () => {
    const wrong = TYPEOF_NAMES.filter((n) => sandboxed.types[n] !== "undefined").map((n) => `${n}=${sandboxed.types[n]}`);
    assert.deepEqual(wrong, [], `still reachable in the sandbox: ${wrong.join(", ")}`);
  });

  it("every allowlisted pure global is still there by default", () => {
    const missing = PRESENT_NAMES.filter((n) => sandboxed.present[n] === "undefined");
    assert.deepEqual(missing, [], `the scrub deleted allowlisted globals: ${missing.join(", ")}`);
  });

  it("--unsafe runs in-process: the body is on the main thread", () => {
    assert.equal(unsafe.isMainThread, true);
  });

  it("--unsafe twin: process, fetch and WebSocket are there", () => {
    for (const [n, t] of Object.entries(TYPEOF_UNSAFE)) assert.equal(unsafe.types[n], t, `typeof ${n} under --unsafe`);
  });
});

describe("node run: per-item mode goes through the boundary", () => {
  const wf = (file: string) =>
    JSON.stringify({
      nodes: [{ id: "e", name: "Each", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { mode: "runOnceForEachItem", jsCode: `//@file:${file}` } }],
    });

  it("an escape check from a runOnceForEachItem node is blocked for every item", async () => {
    put("each/workflow.json", wf("each.js"));
    const file = put(
      "each/each.js",
      PROBE_PRELUDE +
        'await probe("process", () => process.pid);\nawait probe("import", () => import("node:fs"));\nawait probe("ctor", () => $input.all.constructor.constructor("return process")().pid);\n' +
        "return { json: { i: $itemIndex, r } };\n",
    );
    const fx = put("each/fx.json", JSON.stringify({ input: [{ json: { a: 1 } }, { json: { a: 2 } }] }));
    const r = await cli(["node", "run", file, fx]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /runOnceForEachItem/);
    const out = printed(r) as Array<{ json: { i: number; r: Record<string, Outcome> } }>;
    assert.deepEqual(out.map((o) => o.json.i), [0, 1], "one result per input item");
    for (const item of out) {
      assertBlocked(VECTORS[0], item.json.r.process, `item ${item.json.i} `);
      assertBlocked({ key: "import", expr: "", blocked: { kind: "import" } }, item.json.r.import, `item ${item.json.i} `);
      assertBlocked({ key: "ctor", expr: "", blocked: notDefined("process") }, item.json.r.ctor, `item ${item.json.i} `);
    }
  });

  it("one worker per invocation: global state carries across the items of one run", async () => {
    put("count/workflow.json", wf("count.js"));
    const file = put("count/count.js", "globalThis.n = (globalThis.n ?? 0) + 1;\nreturn { json: { n: globalThis.n } };\n");
    const fx = put("count/fx.json", JSON.stringify({ input: [{ json: {} }, { json: {} }, { json: {} }] }));
    const r = await cli(["node", "run", file, fx]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(printed(r), [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]);
  });
});

// BFS over own keys, symbols, getter results and prototypes, from globalThis,
// the injected globals, timer handles, performance, crypto and whatever
// util.inspect hands a custom-inspect method during console.log. It stops at
// the first hit: the sandboxed run must walk everything and find nothing; the
// --unsafe control only needs one (and stopping early keeps it from calling
// getters like process.stdin that would hold the CLI open).
const WALK_BODY = `
const HITS = ["dlopen", "binding", "getBuiltinModule", "_load", "reallyExit", "postMessage"];
const captured = [];
console.log({ [Symbol.for("nodejs.util.inspect.custom")](...args) { for (const a of args) captured.push(a); return "probed"; } });
const roots = [["globalThis", globalThis], ["$input", $input], ["$", $], ["DateTime", DateTime], ["Duration", Duration], ["Interval", Interval], ["$jmespath", $jmespath], ["console", console], ["$getWorkflowStaticData", $getWorkflowStaticData]];
// required roots: a missing one throws a ReferenceError and fails the run
const t1 = setTimeout(() => {}, 0); roots.push(["setTimeout()", t1]); clearTimeout(t1);
const t2 = setImmediate(() => {}); roots.push(["setImmediate()", t2]); clearImmediate(t2);
roots.push(["performance", performance]);
roots.push(["crypto", crypto]);
captured.forEach((a, i) => roots.push(["inspectArg" + i, a]));
const seen = new Set();
const queue = roots.slice();
const hits = [];
let visited = 0;
walk: while (queue.length > 0) {
  const [p, v] = queue.shift();
  if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v)) continue;
  seen.add(v);
  visited++;
  let keys;
  try { keys = Reflect.ownKeys(v); } catch { continue; }
  for (const k of keys) if (typeof k === "string" && HITS.includes(k)) { hits.push(p + "." + k); break walk; }
  for (const k of keys) {
    let d;
    try { d = Reflect.getOwnPropertyDescriptor(v, k); } catch { continue; }
    if (!d) continue;
    const kp = p + "." + String(k);
    if ("value" in d) queue.push([kp, d.value]);
    if (d.get) { queue.push([kp + "<get>", d.get]); try { queue.push([kp, Reflect.apply(d.get, v, [])]); } catch {} }
    if (d.set) queue.push([kp + "<set>", d.set]);
  }
  try { queue.push([p + "<proto>", Reflect.getPrototypeOf(v)]); } catch {}
}
return [{ json: { hits, visited, captured: captured.length, consoleStdout: typeof console._stdout } }];
`;

interface WalkResult {
  hits: string[];
  visited: number;
  captured: number;
  consoleStdout: string;
}

describe("node run: nothing host-capable is reachable from the body", () => {
  it("reachability walk finds no dlopen/binding/getBuiltinModule/_load/reallyExit/postMessage by default", async () => {
    const file = put("walk/walk.js", WALK_BODY);
    const w = probeResult<WalkResult>(await cli(["node", "run", file]));
    assert.deepEqual(w.hits, [], `reachable from the sandboxed body: ${w.hits.join(", ")}`);
    // a walk that visited nothing would also find nothing — make "off" readable
    assert.ok(w.visited > 200, `the walk must actually walk (visited ${w.visited})`);
    assert.ok(w.captured >= 1, "console.log must have called the custom inspect method, so its arguments were walked");
    assert.equal(w.consoleStdout, "undefined", "the injected console carries no stream internals (console._stdout)");
  });

  it("--unsafe control: the same walk does reach host internals", async () => {
    const file = put("walk/walk.js", WALK_BODY);
    const w = probeResult<WalkResult>(await cli(["node", "run", file, "--unsafe"]));
    assert.ok(w.hits.length > 0, `the walk must see the signal in-process (visited ${w.visited})`);
  });
});

// Error.prepareStackTrace + CallSite.getFunction()/getThis(): a sloppy frame
// would hand the body a runner function or a worker-internal `this`. Every
// function the body owns carries MARK in its source; `function unmarked` is a
// deliberate positive control — the hook must see exactly that one and nothing
// else, which proves the hook fires and the detection works.
const STACK_PRELUDE = `
/*SBX-OWN-MARK*/
const own = new Set();
const bad = [];
const isOwnFn = (fn) => own.has(fn) || Function.prototype.toString.call(fn).includes("SBX-OWN-MARK");
const isOwnThis = (t) => t === undefined || t === globalThis || own.has(t);
const note = (s) => { /*SBX-OWN-MARK*/ bad.push(s); if (s !== "fn:unmarked") console.log("LEAK " + s); else console.log("CONTROL " + s); };
Error.prepareStackTrace = (err, frames) => {
  /*SBX-OWN-MARK*/
  for (const f of frames) {
    let fn; let th;
    try { fn = f.getFunction(); } catch {}
    try { th = f.getThis(); } catch {}
    if (fn !== undefined && !isOwnFn(fn)) note("fn:" + (fn.name || "<anonymous>"));
    if (!isOwnThis(th)) note("this:" + Object.prototype.toString.call(th));
  }
  return "stack";
};
new Error().stack;
await null;
new Error().stack;
[1].map(function unmarked() { return new Error().stack; });
`;

describe("node run: stack-trace hooks see only the body's own frames", () => {
  it("during the body and in a thrown value's message getter after it", async () => {
    const file = put(
      "stack/throw.js",
      STACK_PRELUDE +
        // the boundary reads `message` after the body has thrown: the getter
        // takes a stack from there and reports everything seen so far
        'const boom = { get message() { /*SBX-OWN-MARK*/ new Error().stack; return "SEEN:" + JSON.stringify(bad); } };\nown.add(boom);\nthrow boom;\n',
    );
    const r = await cli(["node", "run", file]);
    const all = r.stdout + r.stderr;
    assert.equal(r.code, 1, all);
    assert.doesNotMatch(all, /LEAK /, "a frame outside the body's own code was visible");
    const m = /SEEN:(\[[^\n]*?\])/.exec(all);
    assert.ok(m, `the message getter's report must reach the output:\n${all}`);
    assert.deepEqual(JSON.parse(m[1]), ["fn:unmarked"], "exactly the positive control, nothing from the runner");
  });

  // V8 runs prepareStackTrace only when `.stack` is read, so a serializer that
  // reads only `.message` would never show the hook anything. A getter on the
  // returned value runs INSIDE the serializer's call: the frames below it are
  // the worker's own post-body code.
  it("a getter on the returned value, called by the serializer, sees no runner frame", async () => {
    const file = put(
      "stack/getter.js",
      STACK_PRELUDE + 'const o = { get probe() { /*SBX-OWN-MARK*/ new Error().stack; return bad.slice(); } };\nown.add(o);\nreturn [{ json: o }];\n',
    );
    const r = await cli(["node", "run", file]);
    const all = r.stdout + r.stderr;
    assert.equal(r.code, 0, all);
    assert.doesNotMatch(all, /LEAK /, "a frame outside the body's own code was visible to the serializer-called getter");
    assert.deepEqual(printed(r), [{ json: { probe: ["fn:unmarked"] } }], "exactly the positive control, nothing from the serializer's frames");
  });

  it("after the body returns a circular value", async () => {
    // `probe` comes before `self`, so the serializer calls the getter before
    // it meets the cycle
    const file = put("stack/circular.js", STACK_PRELUDE + "const o = { own: true, get probe() { /*SBX-OWN-MARK*/ new Error().stack; return 1; } };\no.self = o;\nown.add(o);\nreturn [{ json: o }];\n");
    const r = await cli(["node", "run", file]);
    const all = r.stdout + r.stderr;
    // the exit code and message for a circular value belong to the
    // JSON-refusal tests; here only what the hook could see matters
    assert.match(all, /CONTROL fn:unmarked/, "the hook's console line must reach the output (proves the channel works)");
    assert.doesNotMatch(all, /LEAK /, "a frame outside the body's own code was visible after the body returned");
  });
});

// The body patches what the boundary may call after it returns. Each patch
// checks its `this` and arguments; a worker internal shows up as an object
// with `postMessage` (parentPort, a MessagePort) or `dlopen`/`binding`
// (process). A leak is observable two ways: the patch prints a `LEAK …` line
// through the injected console AND throws, so a boundary that swallows the
// console line still fails the exit-code / output assertion below.
const PATCH_BODY = `
const patch = (function () {
  "use strict";
  const R = Reflect.apply;
  const DP = Object.defineProperty;
  const log = console.log;
  let busy = false;
  const has = (o, k) => { try { return k in o; } catch { return false; } };
  const internal = (x) => x !== null && (typeof x === "object" || typeof x === "function") && (has(x, "postMessage") || has(x, "dlopen") || has(x, "binding"));
  const check = (where, self, args) => {
    if (busy) return;
    busy = true;
    let hit = "";
    try {
      if (internal(self)) hit = where + " this";
      for (let i = 0; i < args.length && hit === ""; i++) if (internal(args[i])) hit = where + " arg" + i;
    } finally { busy = false; }
    if (hit !== "") { log("LEAK " + hit); throw new Error("LEAK " + hit); }
  };
  const method = (obj, key, label) => {
    const orig = obj[key];
    if (typeof orig !== "function") return;
    DP(obj, key, { value: function (...args) { check(label, this, args); return R(orig, this, args); }, writable: true, configurable: true });
  };
  const accessor = (key) => {
    DP(Object.prototype, key, {
      get() { check("Object.prototype get " + key, this, []); return undefined; },
      set(v) { check("Object.prototype set " + key, this, [v]); DP(this, key, { value: v, writable: true, enumerable: true, configurable: true }); },
      configurable: true,
    });
  };
  return { check, method, accessor };
})();
// property names a message/result/error path plausibly reads or assigns;
// descriptor fields (value/get/set/…), then/done/next and toJSON stay unpatched
for (const k of ["type", "kind", "data", "result", "items", "count", "port", "code", "error", "message", "stack", "name", "id", "ok", "out", "output", "payload", "transfer", "transferList", "text", "args", "level", "line", "stream", "cause", "status"]) patch.accessor(k);
// the allowlist may delete the EventTarget global while its prototype stays
// reachable (parentPort is a NodeEventTarget): reach it through an instance —
// AbortController is allowlisted, its signal's grandparent prototype is
// EventTarget.prototype even when the AbortSignal/EventTarget globals are gone
const ETP = Object.getPrototypeOf(Object.getPrototypeOf(new AbortController().signal));
const etp = ETP !== null && ETP !== Object.prototype && typeof ETP.addEventListener === "function";
if (etp) for (const k of ["addEventListener", "removeEventListener", "dispatchEvent"]) patch.method(ETP, k, "EventTarget." + k);
for (const k of ["call", "apply", "bind"]) patch.method(Function.prototype, k, "Function." + k);
for (const k of ["split", "replace", "replaceAll", "slice", "indexOf", "includes", "startsWith", "endsWith", "padStart", "padEnd", "repeat", "trim", "toLowerCase", "concat", "match", "charCodeAt"]) patch.method(String.prototype, k, "String." + k);
for (const k of ["exec", "test", Symbol.replace, Symbol.split, Symbol.match]) patch.method(RegExp.prototype, k, "RegExp." + String(k));
for (const k of ["stringify", "parse"]) patch.method(JSON, k, "JSON." + k);
for (const k of ["push", "map", "join", "forEach", "slice", "filter", "concat", "indexOf", "includes", "splice", "reduce", "some", "every", "find", Symbol.iterator]) patch.method(Array.prototype, k, "Array." + String(k));
for (const k of ["then", "catch", "finally"]) patch.method(Promise.prototype, k, "Promise." + k);
const out = { json: { ok: 1, list: [1, 2, 3].map((x) => x * 2), etp } };
out.toJSON = function (key) { patch.check("toJSON", this, [key]); return { json: this.json }; };
return [out];
`;

describe("node run: post-body code ignores built-ins the body patched", () => {
  it("patched prototypes, JSON and a toJSON never receive a worker internal", async () => {
    const file = put("patch/patch.js", PATCH_BODY);
    const r = await cli(["node", "run", file]);
    const all = r.stdout + r.stderr;
    assert.doesNotMatch(all, /LEAK /, "a patched built-in received a worker internal");
    assert.equal(r.code, 0, all);
    // etp: EventTarget.prototype was reached and patched — false would mean the
    // EventTarget vector silently went unchecked
    assert.deepEqual(printed(r), [{ json: { ok: 1, list: [2, 4, 6], etp: true } }]);
  });
});

describe("node run: pure logic prints byte-identical stdout in both modes", () => {
  const each = JSON.stringify({
    nodes: [{ id: "p", name: "Per", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { mode: "runOnceForEachItem", jsCode: "//@file:per.js" } }],
  });
  const cases: Array<{ name: string; files: Record<string, string>; node: string; fixture?: string; expect: RegExp }> = [
    {
      name: "all-items",
      files: { "all.js": 'return $input.all().map((i) => ({ json: { v: i.json.v * 2, s: String(i.json.v).padStart(3, "0") } }));\n' },
      node: "all.js",
      fixture: JSON.stringify({ input: [{ json: { v: 1 } }, { json: { v: 7 } }] }),
      expect: /returned 2 items:/,
    },
    {
      name: "per-item from workflow.json, undefined returns dropped",
      files: { "workflow.json": each, "per.js": "if ($json.v % 2) return;\nreturn { json: { v: $json.v, i: $itemIndex } };\n" },
      node: "per.js",
      fixture: JSON.stringify({ input: [{ json: { v: 1 } }, { json: { v: 2 } }, { json: { v: 3 } }, { json: { v: 4 } }] }),
      expect: /runOnceForEachItem[\s\S]*returned 2 items:/,
    },
    {
      name: "console.log between computations",
      files: { "log.js": 'console.log("first");\nconst a = 1 + 1;\nconsole.log("second", { a }, [1, "two"]);\nconsole.error("to-stderr");\nconst b = a * 3;\nconsole.log("third", b);\nreturn [{ json: { a, b } }];\n' },
      node: "log.js",
      expect: /first\n[\s\S]*second \{ a: 2 \} \[ 1, 'two' \]\n[\s\S]*third 6\n[\s\S]*returned 1 item:/,
    },
    {
      name: "a Luxon DateTime and a function-valued field",
      files: { "lux.js": 'return [{ json: { at: DateTime.fromISO("2024-01-02T03:04:05.000Z", { zone: "utc" }), d: Duration.fromObject({ hours: 2 }), fn: () => 1 } }];\n' },
      node: "lux.js",
      expect: /"at": "2024-01-02T03:04:05\.000Z"[\s\S]*"d": "PT2H"/,
    },
    { name: "a bare function return (raw-value item count)", files: { "fn.js": "return () => 1;\n" }, node: "fn.js", expect: /returned 1 item:\nundefined\n$/ },
    { name: "undefined return", files: { "none.js": "const x = 1;\n" }, node: "none.js", expect: /returned 0 items:\nundefined\n$/ },
    { name: "a toJSON that turns one object into an array", files: { "tojson.js": "return { toJSON() { return [1, 2, 3]; } };\n" }, node: "tojson.js", expect: /returned 1 item:\n\[\n {2}1,\n {2}2,\n {2}3\n\]\n$/ },
  ];

  cases.forEach((c, n) => {
    it(c.name, async () => {
      const dir = `pure/${n}`;
      for (const [f, content] of Object.entries(c.files)) put(`${dir}/${f}`, content);
      const file = path.join(TMP, dir, c.node);
      const fx = c.fixture === undefined ? [] : [put(`${dir}/fx.json`, c.fixture)];
      const [sandboxed, unsafe] = await Promise.all([cli(["node", "run", file, ...fx]), cli(["node", "run", file, ...fx, "--unsafe"])]);
      assert.equal(sandboxed.code, 0, sandboxed.stdout + sandboxed.stderr);
      assert.equal(unsafe.code, 0, unsafe.stdout + unsafe.stderr);
      assert.match(sandboxed.stdout, c.expect);
      assert.equal(sandboxed.stdout, unsafe.stdout, "stdout must be byte-identical between the sandbox and --unsafe");
      if (c.node === "log.js") {
        // console.error goes to stderr in both modes, never onto stdout
        for (const r of [sandboxed, unsafe]) {
          assert.match(r.stderr, /to-stderr/);
          assert.doesNotMatch(r.stdout, /to-stderr/);
        }
      }
      if (c.node === "lux.js") assert.doesNotMatch(sandboxed.stdout, /"fn"/, "a function-valued field is dropped as JSON.stringify drops it");
    });
  });
});

describe("node run: the --unsafe notice", () => {
  it("--unsafe warns on stderr; the default does not", async () => {
    const file = put("notice/n.js", "return [{ json: { ok: true } }];\n");
    const [sandboxed, unsafe] = await Promise.all([cli(["node", "run", file]), cli(["node", "run", file, "--unsafe"])]);
    assert.equal(unsafe.code, 0, unsafe.stdout + unsafe.stderr);
    assert.match(unsafe.stderr, /full host access/);
    assert.match(unsafe.stderr, /no sandbox/);
    assert.doesNotMatch(unsafe.stdout, /full host access|no sandbox/, "the notice is not on stdout");
    assert.equal(sandboxed.code, 0, sandboxed.stdout + sandboxed.stderr);
    assert.doesNotMatch(sandboxed.stdout + sandboxed.stderr, /full host access|no sandbox/);
  });
});

describe("node run: $env across the boundary", () => {
  const body = `return [{ json: { k: $env.${HOST_VAR} ?? null, n: Object.keys($env).length, p: typeof process } }];\n`;
  const env = { [HOST_VAR]: "from-host" };

  it("is empty by default", async () => {
    const file = put("env/env.js", body);
    assert.deepEqual(probeResult(await cli(["node", "run", file], { env })), { k: null, n: 0, p: "undefined" });
  });

  it("--allow-env sees the CLI's environment, and is still sandboxed", async () => {
    const file = put("env/env.js", body);
    const res = probeResult<{ k: string | null; n: number; p: string }>(await cli(["node", "run", file, "--allow-env"], { env }));
    assert.equal(res.k, "from-host");
    assert.equal(res.p, "undefined", "--allow-env is not --unsafe");
  });

  it("a fixture env pin wins over --allow-env", async () => {
    const file = put("env/env.js", body);
    const fx = put("env/fx.json", JSON.stringify({ env: { [HOST_VAR]: "pinned" } }));
    const res = probeResult<{ k: string | null; n: number; p: string }>(await cli(["node", "run", file, fx, "--allow-env"], { env }));
    assert.deepEqual({ k: res.k, n: res.n }, { k: "pinned", n: 1 });
  });
});

describe("node run: a bundled node (Plan 24)", () => {
  it("a .js importing shared/ is bundled and runs sandboxed", async () => {
    const sync = "bundle";
    put(`${sync}/decanter.config.json`, JSON.stringify({ root: "./workflows", workflows: [] }));
    put(`${sync}/shared/math.js`, "export function add(a, b) {\n  return a + b;\n}\n");
    put(`${sync}/workflows/calc/workflow.json`, JSON.stringify({
      nodes: [{ id: "c", name: "Calc", type: "n8n-nodes-base.code", typeVersion: 2, position: [0, 0], parameters: { jsCode: "//@file:code/calc.js" } }],
    }));
    const file = put(
      `${sync}/workflows/calc/code/calc.js`,
      'import { add } from "../../../shared/math";\n' + PROBE_PRELUDE + 'await probe("import", () => import("node:fs"));\nreturn [{ json: { sum: add(2, 3), p: typeof process, imp: r.import } }];\n',
    );
    const res = probeResult<{ sum: number; p: string; imp: Outcome }>(await cli(["node", "run", file], { cwd: path.join(TMP, sync) }));
    assert.equal(res.sum, 5, "the shared/ helper was inlined and ran");
    assert.equal(res.p, "undefined");
    assertBlocked({ key: "import", expr: "", blocked: { kind: "import" } }, res.imp);
  });
});

describe("node run: the built layout (dist/)", () => {
  before(async () => {
    // writes the gitignored dist/ — the npm package ships compiled .mjs, and a
    // worker entry named with a literal .mts would break every npm user
    await execFileP("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
  });

  it("refuses import('./run.mjs') from dist/", async () => {
    const file = put("built/esc.js", PROBE_PRELUDE + 'await probe("run.mjs", () => import("./run.mjs").then((m) => m.runNode));\nreturn [{ json: { imp: r["run.mjs"], p: typeof process } }];\n');
    const res = probeResult<{ imp: Outcome; p: string }>(await cli(["node", "run", file], { entry: BUILT_CLI }));
    assertBlocked({ key: "import ./run.mjs", expr: "", blocked: { kind: "import" } }, res.imp);
    assert.equal(res.p, "undefined");
  });

  it("runs pure logic from dist/ with the same stdout as the checkout", async () => {
    const file = put("built/pure.js", "return $input.all().map((i, n) => ({ json: { n, v: i.json.v } }));\n");
    const fx = put("built/fx.json", JSON.stringify({ input: [{ json: { v: "a" } }, { json: { v: "b" } }] }));
    const [built, checkout] = await Promise.all([cli(["node", "run", file, fx], { entry: BUILT_CLI }), cli(["node", "run", file, fx])]);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    assert.deepEqual(printed(built), [{ json: { n: 0, v: "a" } }, { json: { n: 1, v: "b" } }]);
    assert.equal(built.stdout, checkout.stdout);
  });
});

describe("node run: --unsafe on the CLI surface", () => {
  it("the --help usage line for node run names --unsafe", async () => {
    const r = await cli(["--help"]);
    assert.equal(r.code, 0, r.stderr);
    const line = r.stdout.split("\n").find((l) => /node run/.test(l));
    assert.ok(line, "--help has a node run line");
    assert.match(line, /--unsafe/);
  });

  it("__complete offers --unsafe", async () => {
    const r = await cli(["__complete"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.split(/\s+/).includes("--unsafe"), r.stdout);
  });
});
