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
  const { left, removed } = scrub();
  if (left.length > 0) {
    // Fail closed: a Node release where a global turned undeletable would
    // otherwise run the body next to it.
    send({ k: "fail", message: `sandboxed \`node run\` refused to start: the global \`${left[0]}\` could not be removed on Node ${NODE_VERSION}` });
    return;
  }
  lockImports();

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
