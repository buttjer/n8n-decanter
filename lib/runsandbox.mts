// Plan 31 — the sandbox worker entry for `node run`. One worker per
// invocation runs the whole body loop in its OWN main realm, after that realm
// has been scrubbed of everything host-capable. "How A holds" in
// plans/done/31-run-sandbox-boundary.md is the measurement behind each step:
//
//   1. This module is strict (an .mts module always is), so a body's
//      `Error.prepareStackTrace` gets `undefined` from `getFunction()` and
//      `getThis()` on every frame of ours.
//   2. Luxon and jmespath load (inside `buildGlobals`) BEFORE the import lock.
//   3. The body's `console` is a fresh object of our functions that format
//      here and post strings to the parent; the worker's real console carries
//      stream internals and is deleted with the rest.
//   4. The parent creates this worker with `env: {}`; `$env` under
//      `--allow-env` is the snapshot the parent posts in `workerData`.
//   5. The global allowlist is below.
//   6. The built-in constructors, their prototypes, the namespace objects
//      and the instance-only prototypes reached at setup are frozen after
//      all setup and before the body's first statement (Task 8, "The
//      freeze" below) — not every shared object: some internal error-code
//      and iterator prototypes can't all be enumerated and stay patchable.
//
// Why the freeze exists: the scrub removes names, but the body still shares
// this realm's built-in prototypes with Node's own internals. Node reads
// `process.noDeprecation` (and three siblings) while holding the real
// `process`; those properties are not own, so the lookup falls through to
// `Object.prototype`, and a getter a body planted there ran with
// `this === process` (the end review of Tasks 1-7 verified it with
// `Buffer(1)`'s DEP0005 warning). Closing that one key would leave the class
// open: any shared object Node also reads or calls while holding a privileged
// one. So the reachable built-ins are made immutable (narrowed by the
// enumeration limits above). It mirrors n8n's
// `freezeGlobals()` (`packages/@n8n/task-runner/src/js-task-runner/
// prototype-hardening.ts`), with one difference: n8n freezes its host realm
// and runs user code in a separate `vm` realm, while here the body shares the
// realm it freezes (a second realm is the escape described next).
//
// The body runs in this realm through the AsyncFunction constructor, never in
// a `vm` context: a second realm is exactly what lets
// `x.constructor.constructor("return process")()` escape. Here every function
// the body can reach belongs to the scrubbed realm, so that expression
// evaluates against a global object without `process`.
import { registerHooks } from "node:module";
import { formatWithOptions } from "node:util";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import { append, buildGlobals, commonJsHint, executeBody, type Fixture, referenceErrorIdent, serializeRaw } from "./globals.mts";
import type { WorkflowNode } from "./types.mts";

/** What the parent posts as `workerData`; every field structured-clones. */
export interface SandboxRequest {
  code: string;
  mode: string;
  fixture: Fixture;
  node: WorkflowNode | null;
  staticData: unknown;
  /** The CLI's environment snapshot, only under `--allow-env`. */
  env?: Record<string, string | undefined>;
  /** The parent's own colour decision per stream; this worker's env is empty. */
  colors: { stdout: boolean; stderr: boolean };
  /** DEBUG=1 in the CLI: hand back the body error's stack too. */
  debug: boolean;
}

/** Worker → parent. Console lines arrive in call order, before `done`/`fail`. */
export type SandboxMessage =
  | { k: "stdout"; s: string }
  | { k: "stderr"; s: string }
  | { k: "done"; count: number; text: string | undefined }
  | { k: "fail"; message: string; name?: string; code?: string; stack?: string };

/** The `code` of the error the import lock throws (contract; tests key on it). */
export const SANDBOX_IMPORT_CODE = "ERR_DECANTER_SANDBOX_IMPORT";

// ---- built-ins captured before any body runs (Plan 31, "Post-body code") ----
const ReflectApply = Reflect.apply;
const ReflectDefineProperty = Reflect.defineProperty;
const ReflectDeleteProperty = Reflect.deleteProperty;
const ReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ReflectOwnKeys = Reflect.ownKeys;
const ArrayIsArray = Array.isArray;
const JSONStringify = JSON.stringify;
const StringCtor = String;
const ErrorCtor = Error;
const SetHas = Set.prototype.has;
const NODE_VERSION = process.version;
const HOST_PROCESS: unknown = process;
const ReflectGetPrototypeOf = Reflect.getPrototypeOf;
const ObjectFreeze = Object.freeze;
const ObjectIsFrozen = Object.isFrozen;
const ObjectPrototype = Object.prototype;
const TypeErrorCtor = TypeError;
const PromiseCtor = Promise;
const PromiseThen = Promise.prototype.then;

const port = parentPort;
if (port === null) throw new Error("lib/runsandbox.mts is a worker entry; `node run` starts it");
const portPostMessage = port.postMessage;
const request = workerData as SandboxRequest;

const send = (msg: SandboxMessage): void => {
  ReflectApply(portPostMessage, port, [msg]);
};

/** A data-property descriptor that inherits nothing a body could have put on Object.prototype. */
const dataDescriptor = (value: unknown, enumerable: boolean): PropertyDescriptor =>
  ({ __proto__: null, value, writable: true, enumerable, configurable: true }) as PropertyDescriptor;

// ---- the injected console (requirement 3) ----
const format = (colors: boolean, args: unknown[]): string => {
  const callArgs: unknown[] = [];
  append(callArgs, { __proto__: null, colors });
  for (let i = 0; i < args.length; i++) append(callArgs, args[i]);
  return ReflectApply(formatWithOptions, undefined, callArgs);
};
const writer =
  (stream: "stdout" | "stderr") =>
  (...args: unknown[]): void => {
    send({ k: stream, s: format(request.colors[stream], args) });
  };
const noop = (): void => {};
const STREAM_OF: Record<string, "stdout" | "stderr"> = { log: "stdout", info: "stdout", debug: "stdout", warn: "stderr", error: "stderr" };
// Every method the real console has exists, so a body calling `console.table`
// does not crash; only the five above print. n8n's runner console is a custom
// object too — it does not hand the body Node's console either.
const sandboxConsole: Record<string, unknown> = {};
for (const name of Object.keys(console)) {
  if (typeof (console as unknown as Record<string, unknown>)[name] !== "function") continue;
  ReflectDefineProperty(sandboxConsole, name, dataDescriptor(STREAM_OF[name] ? writer(STREAM_OF[name]) : noop, true));
}

// ---- the global allowlist (requirement 5) ----
//
// ECMAScript built-ins: whatever a fresh V8 realm carries, read from a vm
// context — the same set n8n's JS task runner starts its vm realm from, and it
// follows V8 (Temporal, Iterator, …) without a list to maintain here. Only key
// NAMES cross; no object of that realm is kept. `console` is on it (V8 adds
// one) and gets replaced by ours.
//
// Node's web-standard extras, chosen against n8n's runner scope (machine
// plan, "n8n runner scope", read from n8n master 2026-11-03): n8n adds
// `Buffer`, the timers, `btoa`/`atob` and the four text codecs, all kept. We are
// WIDER than n8n for `URL`/`URLSearchParams`, `structuredClone`, `crypto`,
// `AbortController`/`AbortSignal`, `Event`/`EventTarget`, `DOMException`,
// `queueMicrotask` and `performance` — pure, no I/O, and a node that uses one
// would rather run offline than fail on a fidelity technicality. Nothing that
// does I/O or opens a channel is here: the fetch family (incl. `FormData`,
// which n8n has), WebSocket, EventSource, BroadcastChannel, MessageChannel,
// MessagePort, navigator, Storage — and `process`, `global`, `require`.
const NODE_EXTRAS = [
  "Buffer",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "atob",
  "btoa",
  "TextEncoder",
  "TextDecoder",
  "TextEncoderStream",
  "TextDecoderStream",
  "URL",
  "URLSearchParams",
  "structuredClone",
  "crypto",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "DOMException",
  "performance",
];
const allowed = new Set<PropertyKey>(Reflect.ownKeys(vm.runInNewContext("globalThis") as object));
for (const k of NODE_EXTRAS) allowed.add(k);
const isAllowed = (k: PropertyKey): boolean => ReflectApply(SetHas, allowed, [k]);

/**
 * Delete every global outside the allowlist; turn the lazy accessors Node
 * uses for kept ones (`Buffer`, `crypto`, `performance`) into plain data
 * properties, so the body never calls a getter of Node's loader. Returns what
 * is still there that should not be (`left` — empty, or the run refuses) and
 * the NAMES actually deleted (`removed` — the set "Friendly boundary errors"
 * maps a `ReferenceError` against, so a typo like `fooo` — never a global at
 * all — stays a plain `ReferenceError` instead of getting the sandbox hint).
 */
function scrub(): { left: string[]; removed: Set<string> } {
  const removed = new Set<string>();
  for (const k of ReflectOwnKeys(globalThis)) {
    if (!isAllowed(k)) {
      ReflectDeleteProperty(globalThis, k);
      if (typeof k === "string") removed.add(k);
      continue;
    }
    const d = ReflectGetOwnPropertyDescriptor(globalThis, k);
    if (d?.get && d.configurable) ReflectDefineProperty(globalThis, k, dataDescriptor(d.get.call(globalThis), d.enumerable === true));
  }
  ReflectDefineProperty(globalThis, "console", dataDescriptor(sandboxConsole, false));
  const left: string[] = [];
  for (const k of ReflectOwnKeys(globalThis)) if (!isAllowed(k)) append(left, StringCtor(k));
  return { left, removed };
}

/** The import lock: refuses EVERY specifier, the worker's own included (the cache would serve those). */
function lockImports(): void {
  registerHooks({
    resolve(specifier: string): never {
      const err = new ErrorCtor(`import(${JSONStringify(specifier)}) is refused in the sandbox`);
      ReflectDefineProperty(err, "code", dataDescriptor(SANDBOX_IMPORT_CODE, true));
      throw err;
    },
  });
}

const isObjectLike = (v: unknown): v is Record<string, unknown> => v !== null && (typeof v === "object" || typeof v === "function");

// ---- the freeze (requirement 6) ----
//
// The reachable set is the one the phase-0 walk in
// test/unit/run-sandbox-frozen.test.mts checks, so the freeze and its test
// cannot disagree about what "reachable" means. Frozen: every object reached
// through a [[Prototype]] link or a `.prototype`, and every function and
// namespace object reached through a shared object. NOT frozen: `globalThis`
// (a sloppy body's implicit global still has to work) and per-run data — the
// fixture items, `$json`, static data, instances. Their own functions (a
// stream controller's algorithms) are per-run too: no other run shares them,
// so freezing them would protect nothing.

/** A namespace object: plain, with its own string `Symbol.toStringTag` (JSON, Math, Intl, …). */
function isNamespace(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  if (ReflectGetPrototypeOf(v) !== ObjectPrototype) return false;
  const tag = ReflectGetOwnPropertyDescriptor(v, Symbol.toStringTag);
  return tag !== undefined && typeof tag.value === "string";
}

/**
 * Root (a): constructors and namespace objects as the realm had them before
 * the scrub. A deleted name can still lead somewhere through a kept one, and
 * Node's internals keep using them either way. Only data properties are
 * read: a lazy accessor of a removed global (`fetch`, `navigator`) would load
 * its whole module just to be frozen, and nothing the body holds leads to it.
 *
 * The undici family is skipped: those names are V8 lazy DATA properties, and
 * merely reading one's descriptor loads undici, which leaves
 * `Symbol(undici.globalDispatcher.2)` (a live network Agent) on the global
 * object, where the scrub cannot remove it. Measured on Node 26.7.0, one
 * descriptor read per global name, each in a fresh worker: 8 of 141 names
 * added globals (+2 each), exactly these. Should another release add one, the
 * scrub's own check finds the new global and the run refuses to start.
 */
const CAPTURE_SKIP = new Set<PropertyKey>(["FormData", "Headers", "Request", "Response", "MessageEvent", "CloseEvent", "ErrorEvent", "WebSocket"]);
function captureBuiltins(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const k of ReflectOwnKeys(globalThis)) {
    if (CAPTURE_SKIP.has(k)) continue;
    const d = ReflectGetOwnPropertyDescriptor(globalThis, k);
    if (d === undefined || !("value" in d)) continue;
    const v: unknown = d.value;
    if (v === globalThis || v === HOST_PROCESS) continue;
    if (typeof v === "function" || isNamespace(v)) append(out, [StringCtor(k), v]);
  }
  return out;
}

// The global names that are injected values in the walk's sense; they belong
// to the getter-free phase. Same set as the phase-0 walk.
const INJECTED_GLOBAL_NAMES = new Set<PropertyKey>(["DateTime", "Duration", "Interval", "console"]);
const isInjectedKey = (k: PropertyKey): boolean => typeof k === "string" && (k.startsWith("$") || INJECTED_GLOBAL_NAMES.has(k));

/** Defensive: the real `process` is never walked or frozen, wherever it turns up. */
const isHostProcess = (v: object): boolean => v === HOST_PROCESS || ReflectGetOwnPropertyDescriptor(v, "dlopen") !== undefined;

type Entry = [path: string, value: unknown, shared: boolean];

/**
 * Collect every object to freeze, keyed to the path that reached it (the
 * fail-closed message names it). Two queues: built-ins get their getters
 * called with the reached object as receiver — that is the only way to
 * `crypto.subtle` or a stream's reader — while injected values and Luxon are
 * read through descriptors only. Luxon's getters cache onto `this`
 * (`fastNumbers` onto `Locale.prototype`, which then breaks every new Locale
 * after the freeze), and `$node`, `$vars`, `$secrets` are Proxies that throw
 * on a string-key read; their targets are empty, so descriptor reads never
 * reach a trap.
 */
async function collectShared(globals: Record<string, unknown>, before: Array<[string, unknown]>): Promise<Map<object, string>> {
  const freeze = new Map<object, string>();
  const builtins: Entry[] = [];
  const injected: Entry[] = [];
  const mark = (v: object, p: string): void => {
    if (v !== globalThis && !freeze.has(v)) freeze.set(v, p);
  };
  const enqueue = (getters: boolean, p: string, v: unknown, shared: boolean): void => {
    if (!isObjectLike(v)) return;
    if (shared && (typeof v === "function" || isNamespace(v))) mark(v, p);
    (getters ? builtins : injected).push([p, v, shared]);
  };
  const viaProto = (getters: boolean, p: string, v: unknown): void => {
    if (!isObjectLike(v)) return;
    mark(v, p);
    enqueue(getters, p, v, true);
  };
  // An instance is walked as per-run data, and its prototype as shared. A root
  // that cannot be built on this Node has no instance a body could build
  // either, so it is skipped rather than refused.
  const root = (getters: boolean, label: string, make: () => unknown): unknown => {
    let v: unknown;
    try {
      v = make();
    } catch {
      return undefined;
    }
    if (!isObjectLike(v)) return undefined;
    enqueue(getters, label, v, false);
    viaProto(getters, `${label}<proto>`, ReflectGetPrototypeOf(v));
    return v;
  };
  const g = globalThis as Record<string, any>;

  // (a) and (b): the realm before and after the scrub
  for (const [k, v] of before) enqueue(true, k, v, true);
  enqueue(true, "globalThis", globalThis, true);
  for (const k of ReflectOwnKeys(globals)) {
    const d = ReflectGetOwnPropertyDescriptor(globals, k);
    if (d !== undefined && "value" in d) enqueue(false, StringCtor(k), d.value, true);
  }

  // (c) prototypes no global name leads to
  viaProto(true, "GeneratorFunction.prototype", ReflectGetPrototypeOf(function* () {}));
  viaProto(true, "AsyncGeneratorFunction.prototype", ReflectGetPrototypeOf(async function* () {}));
  viaProto(true, "AsyncFunction.prototype", ReflectGetPrototypeOf(async () => {}));
  root(true, "ArrayIterator", () => [].values());
  root(true, "StringIterator", () => ""[Symbol.iterator]());
  root(true, "MapIterator", () => new Map().entries());
  root(true, "SetIterator", () => new Set().values());
  root(true, "RegExpStringIterator", () => "a".matchAll(/a/g));
  root(true, "IteratorHelper", () => g.Iterator.prototype.map.call([].values(), Math.abs));
  viaProto(true, "globalThis<proto>", ReflectGetPrototypeOf(globalThis));

  // (d) instances that carry built-in prototypes no global leads to. The
  // timers stay live during the walk (their TimersList is only reachable
  // then), and every trace is removed before the body runs.
  const MARK = "decanter-freeze-mark";
  const MEASURE = "decanter-freeze-measure";
  let tmo: unknown;
  let imm: unknown;
  try {
    tmo = root(true, "setTimeout()", () => setTimeout(Math.max, 600_000));
    imm = root(true, "setImmediate()", () => setImmediate(Math.max));
    root(true, "performance.mark()", () => performance.mark(MARK));
    root(true, "performance.measure()", () => performance.measure(MEASURE));
    root(true, "AbortController", () => new AbortController());
    // Node builds one error class per internal code, and its prototype is
    // reachable from any caught error of that code. These are the codes a body
    // trips over in ordinary use; the rest cannot be enumerated (Plan 31 F3 —
    // no privileged object inherits from them, so no escape through them is
    // known).
    const caught = (f: () => unknown) => (): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    root(true, "Buffer.alloc(-1) error", caught(() => Buffer.alloc(-1)));
    root(true, "Buffer.from(5) error", caught(() => Buffer.from(5 as unknown as string)));
    root(true, "unknown encoding error", caught(() => Buffer.alloc(1).toString("nope" as BufferEncoding)));
    root(true, 'setTimeout("x") error', caught(() => setTimeout("x" as unknown as () => void)));
    root(true, 'TextDecoder("nope") error', caught(() => new TextDecoder("nope")));
    root(true, "URLSearchParams iterator", () => new URLSearchParams("a=1").entries());
    const tes = root(true, "TextEncoderStream", () => new TextEncoderStream()) as TextEncoderStream | undefined;
    if (tes !== undefined) {
      root(true, "ReadableStream", () => tes.readable);
      root(true, "WritableStream", () => tes.writable);
      root(true, "ReadableStreamDefaultReader", () => tes.readable.getReader());
      root(true, "WritableStreamDefaultWriter", () => tes.writable.getWriter());
    }
    // a second codec: the reader above already locked the first one's readable
    root(true, "ReadableStream async iterator", () => (new TextEncoderStream().readable as unknown as { values(): unknown }).values());
    let key: unknown;
    try {
      key = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]);
    } catch {}
    root(true, "CryptoKey", () => key);
    const segs = root(true, "Intl.Segments", () => new Intl.Segmenter("en", { granularity: "word" }).segment("a b")) as Iterable<unknown> | undefined;
    if (segs !== undefined) root(true, "Intl.SegmentIterator", () => segs[Symbol.iterator]());
    root(true, "Iterator.from wrapper", () => g.Iterator.from({ next: Math.random }));
    const DateTime = globals.DateTime as Record<string, any>;
    root(false, "Luxon IANAZone", () => DateTime.fromISO("2024-01-01T00:00:00Z").setZone("Europe/Berlin").zone);
    root(false, "Luxon Invalid", () => ReflectGetOwnPropertyDescriptor(DateTime.invalid("decanter-freeze"), "invalid")?.value);
    root(false, "Luxon FixedOffsetZone", () => DateTime.fromISO("2024-01-01T00:00:00Z").setZone("UTC+2").zone);
    // Locale builds these three per call and never stores them, so no walk
    // reaches them: build one each. `loc` is read by descriptor, and these are
    // method calls, not getters — the Luxon no-getter rule above still holds.
    const dt = DateTime.fromISO("2024-01-01T00:00:00Z");
    const loc = ReflectGetOwnPropertyDescriptor(dt, "loc")?.value as Record<string, (...a: unknown[]) => unknown> | undefined;
    root(false, "Luxon PolyDateFormatter", () => loc?.dtFormatter(dt, {}));
    root(false, "Luxon PolyNumberFormatter", () => loc?.numberFormatter({}));
    root(false, "Luxon PolyRelFormatter", () => loc?.relFormatter({}));

    const seen = new Map<unknown, boolean>();
    for (const [queue, getters] of [[builtins, true], [injected, false]] as Array<[Entry[], boolean]>) {
      for (let i = 0; i < queue.length; i++) {
        const [p, v, shared] = queue[i];
        if (!isObjectLike(v) || (seen.has(v) && (seen.get(v) || !shared))) continue;
        seen.set(v, shared);
        if (isHostProcess(v)) continue;
        for (const k of ReflectOwnKeys(v)) {
          const d = ReflectGetOwnPropertyDescriptor(v, k);
          if (d === undefined) continue;
          const kp = `${p}.${StringCtor(k)}`;
          const gk = getters && !(v === globalThis && isInjectedKey(k));
          if ("value" in d) {
            if (k === "prototype") viaProto(gk, kp, d.value);
            else enqueue(gk, kp, d.value, shared);
          }
          if (d.get) enqueue(gk, `${kp}<get>`, d.get, shared);
          if (d.set) enqueue(gk, `${kp}<set>`, d.set, shared);
        }
        if (getters) {
          // every getter on the chain, called with this object as receiver
          for (let o: object | null = v; o !== null; o = ReflectGetPrototypeOf(o)) {
            for (const k of ReflectOwnKeys(o)) {
              if (o === globalThis && isInjectedKey(k)) continue;
              const d = ReflectGetOwnPropertyDescriptor(o, k);
              if (!d?.get) continue;
              let got: unknown;
              try {
                got = ReflectApply(d.get, v, []);
              } catch {
                continue;
              }
              // a getter on the wrong receiver may hand back a rejected promise
              // (a stream reader's `closed`); unhandled, it would end the run
              if (got instanceof PromiseCtor) ReflectApply(PromiseThen, got, [undefined, noop]);
              enqueue(true, `${p}.${StringCtor(k)}<got>`, got, shared);
            }
          }
        }
        viaProto(getters, `${p}<proto>`, ReflectGetPrototypeOf(v));
      }
    }
  } finally {
    clearTimeout(tmo as ReturnType<typeof setTimeout>);
    clearImmediate(imm as ReturnType<typeof setImmediate>);
    performance.clearMarks(MARK);
    performance.clearMeasures(MEASURE);
  }
  return freeze;
}

const OVERRIDE_NAMES = ["constructor", "name", "message", "toString", "valueOf", "toLocaleString"];

/**
 * The override mistake, tamed the way Agoric SES's `lockdown` enablements do:
 * a frozen prototype's data property makes the same name unassignable on
 * every instance, which broke Node's own `warning.name = …` (so `Buffer(1)`
 * died), `TextEncoderStream`'s `constructor`, and every Error subclass that
 * sets `this.name`. These six names become accessors whose setter defines the
 * value on the receiver instead. The frozen object itself stays refused, in
 * sloppy code too — an accessor cannot see the caller's mode, and a silent
 * `Error.prototype.name = …` would rename every error the runner formats.
 * Both functions are methods (no `.prototype`), frozen, and use only
 * built-ins captured at module load: `globalThis` stays writable, so a
 * global looked up at call time would be whatever the body put there.
 */
function enableOverrides(owner: object, constructorAccessor: boolean): void {
  for (let i = 0; i < OVERRIDE_NAMES.length; i++) {
    const key = OVERRIDE_NAMES[i];
    if (key === "constructor" && !constructorAccessor) continue;
    const d = ReflectGetOwnPropertyDescriptor(owner, key);
    if (d === undefined || !("value" in d) || d.writable !== true || d.configurable !== true) continue;
    const value: unknown = d.value;
    const accessor = {
      get(): unknown {
        return value;
      },
      set(this: unknown, v: unknown): void {
        if (this === owner || !isObjectLike(this) || !ReflectDefineProperty(this, key, dataDescriptor(v, true))) {
          throw new TypeErrorCtor(`Cannot assign to read only property '${key}' of a frozen built-in`);
        }
      },
    };
    const get = ReflectGetOwnPropertyDescriptor(accessor, "get")!.value as () => unknown;
    const set = ReflectGetOwnPropertyDescriptor(accessor, "set")!.value as (v: unknown) => void;
    ObjectFreeze(get);
    ObjectFreeze(set);
    ReflectDefineProperty(owner, key, { __proto__: null, get, set, enumerable: d.enumerable === true, configurable: false } as PropertyDescriptor);
  }
}

/**
 * The prototypes whose `constructor` gets the override accessor (Plan 31 F1).
 * Everywhere else `constructor` stays a frozen data property, because
 * `util.inspect` takes the class name from that descriptor's `value`: with an
 * accessor, `console.log(new Uint8Array([1, 2]))` printed
 * `TypedArray(2) [Uint8Array] [ 1, 2 ]` (end review, 2026-11-06). The list is
 * what assigns `constructor` on an instance after setup, measured on Node
 * 26.7.0 (2026-11-06) against test/unit/run-sandbox{,-frozen}.test.mts: with
 * these three every case passes, and dropping any one of them fails one:
 * - `WritableStream.prototype`, `ReadableStream.prototype`: Node's webstreams
 *   assign `constructor` on each new instance of the internal subclasses
 *   (e.g. every `new TextEncoderStream()`), not just once at module load, so
 *   `new TextEncoderStream()` / `TextDecoderStream()` died without the entry.
 * - `Object.prototype`: a body's plain `o.constructor = X` has to assign. Its
 *   `constructor` is only what inspect falls back to for a chain that names
 *   none of its own, so the accessor there leaves built-ins' output unchanged.
 * Luxon and jmespath needed no entry: their cases in the same tests pass
 * without one. A miss elsewhere leaves `constructor` a frozen data property,
 * so an assignment to it is a silent no-op in sloppy code, and under
 * `"use strict"` throws V8's own `Cannot assign to read only property
 * 'constructor' of object …` — not this module's `TypeError`, and it never
 * says "frozen built-in", so grepping this file's wording after a missed
 * entry finds nothing.
 */
function constructorAccessorOwners(before: Array<[string, unknown]>): Set<object> {
  const owners = new Set<object>([ObjectPrototype]);
  for (const [k, v] of before) {
    if (k !== "WritableStream" && k !== "ReadableStream") continue;
    const proto = isObjectLike(v) ? ReflectGetOwnPropertyDescriptor(v, "prototype")?.value : undefined;
    if (isObjectLike(proto)) owners.add(proto);
  }
  return owners;
}

/** Freeze the reachable set; the path of the first object that did not freeze, or `undefined`. */
async function freezeShared(globals: Record<string, unknown>, before: Array<[string, unknown]>): Promise<string | undefined> {
  const set = await collectShared(globals, before);
  const ctorOwners = constructorAccessorOwners(before);
  for (const [o, p] of set) {
    try {
      enableOverrides(o, ctorOwners.has(o));
      ObjectFreeze(o);
    } catch {
      return p;
    }
  }
  // Fail closed, re-checked as a separate pass: a Proxy or an exotic object
  // can survive `Object.freeze` without throwing.
  for (const [o, p] of set) if (!ObjectIsFrozen(o)) return p;
  return undefined;
}

/** The sandbox hint for a global the scrub removed, or `import()` (contract text, exact). */
const sandboxHint = (name: string): string =>
  `\`${name}\` is not available in sandboxed \`node run\` — pass \`--unsafe\` to allow host access.`;

/**
 * An error that ESCAPED the body (Plan 31, "Friendly boundary errors"):
 * `require`/`module`/`exports`/`__dirname`/`__filename` get the CommonJS
 * hint (checked first — those names are never real globals here, so they
 * would not be in `removed` either); a `ReferenceError` for a name the scrub
 * actually deleted, or the import-lock's `ERR_DECANTER_SANDBOX_IMPORT`, gets
 * the sandbox hint; everything else (a typo, a thrown value, the
 * fixture/static-data errors) keeps its message unchanged.
 */
function mapBoundaryError(err: unknown, removed: Set<string>): unknown {
  const code = isObjectLike(err) ? (() => {
    try {
      return err.code;
    } catch {
      return undefined;
    }
  })() : undefined;
  if (code === SANDBOX_IMPORT_CODE) return new ErrorCtor(sandboxHint("import()"));
  const ident = referenceErrorIdent(err);
  if (ident === undefined) return err;
  const cjs = commonJsHint(ident);
  if (cjs !== undefined) return new ErrorCtor(cjs);
  if (ReflectApply(SetHas, removed, [ident])) return new ErrorCtor(sandboxHint(ident));
  return err;
}

/** Read a thrown value into a plain message. Every read can run body code (getters), so each is guarded. */
function failure(err: unknown): SandboxMessage {
  let message: string;
  try {
    message = isObjectLike(err) ? StringCtor(err.message) : StringCtor(err);
  } catch {
    message = "the node threw a value whose message could not be read";
  }
  let name: string | undefined;
  let code: string | undefined;
  let stack: string | undefined;
  if (isObjectLike(err)) {
    try {
      const v = err.name;
      if (typeof v === "string") name = v;
    } catch {}
    try {
      const v = err.code;
      if (typeof v === "string") code = v;
    } catch {}
    if (request.debug) {
      try {
        const v = err.stack;
        if (typeof v === "string") stack = v;
      } catch {}
    }
  }
  // one literal, no assignments: a property SET would consult setters a body
  // put on Object.prototype
  return { k: "fail", message, name, code, stack };
}

async function main(): Promise<void> {
  let globals: Awaited<ReturnType<typeof buildGlobals>>;
  try {
    globals = await buildGlobals(request.fixture, { node: request.node, staticData: request.staticData, env: request.env, console: sandboxConsole });
  } catch (err) {
    send(failure(err));
    return;
  }
  const before = captureBuiltins();
  const { left, removed } = scrub();
  if (left.length > 0) {
    // Fail closed: a Node release where a global turned undeletable would
    // otherwise run the body next to it.
    send({ k: "fail", message: `sandboxed \`node run\` refused to start: the global \`${left[0]}\` could not be removed on Node ${NODE_VERSION}` });
    return;
  }
  lockImports();
  // Last: every setup step before this one may still write to a built-in
  // (the lock's `registerHooks` among them), and nothing after it may.
  let unfrozen: string | undefined;
  try {
    unfrozen = await freezeShared(globals as unknown as Record<string, unknown>, before);
  } catch (err) {
    unfrozen = `(the walk itself failed: ${StringCtor(isObjectLike(err) ? err.message : err)})`;
  }
  if (unfrozen !== undefined) {
    send({ k: "fail", message: `sandboxed \`node run\` refused to start: the shared object \`${unfrozen}\` could not be frozen on Node ${NODE_VERSION}` });
    return;
  }

  let raw: unknown;
  try {
    raw = await executeBody(request.code, request.mode, globals);
  } catch (err) {
    send(failure(mapBoundaryError(err, removed)));
    return;
  }
  // Counted from the RAW value, exactly as --unsafe does; JSON semantics
  // (toJSON honoured, functions dropped) only shape the printed text.
  const count = ArrayIsArray(raw) ? raw.length : raw === undefined ? 0 : 1;
  let text: string | undefined;
  try {
    text = serializeRaw(raw);
  } catch (err) {
    send(failure(err));
    return;
  }
  send({ k: "done", count, text });
}

// No `.catch()` here: Promise.prototype is the body's by now. `main` handles
// every path itself.
void main();
