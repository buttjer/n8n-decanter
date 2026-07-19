import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { build, transform } from "esbuild";
import type { Log } from "./types.mts";

// Bundling (plans/14): a Code-node body may import from shared/ (and from
// bundleDependencies-allowlisted npm packages); the imports are inlined into
// the pushed artifact, which stays a legal *function body*. Mechanism —
// esbuild rejects any top-level `import` next to a top-level `return`, so:
// hoist the import block, wrap the body in an async arrow, bundle as an
// iife, then re-enter with a top-level `return` footer.
const GLOBAL_NAME = "__n8n_node";
const SIZE_WARN_BYTES = 100_000;
const BUILTINS = new Set(builtinModules);

export interface ScannedImports {
  /** Verbatim leading import block ("" when the file has none). */
  importBlock: string;
  /** Module specifiers in order of appearance. */
  specifiers: string[];
  /** Source with the import block removed — the function body. */
  body: string;
  /** Lines (fully or partially) occupied by the import block. */
  importLines: number;
}

/**
 * Split a node file into its leading top-level import block and the body.
 * Dependency-free and line-precise: the imports-at-top rule means only the
 * file head needs scanning — anything after the first non-import statement
 * is body (a stray later import fails at bundle time with esbuild's own
 * error). Dynamic `import(…)` and `import.meta` are not declarations and
 * terminate the scan.
 */
export function scanNodeImports(source: string): ScannedImports {
  const len = source.length;
  let pos = 0;
  let end = 0;
  const specifiers: string[] = [];
  scan: for (;;) {
    while (pos < len) {
      const ch = source[pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") pos++;
      else if (ch === "/" && source[pos + 1] === "/") {
        const nl = source.indexOf("\n", pos);
        pos = nl === -1 ? len : nl + 1;
      } else if (ch === "/" && source[pos + 1] === "*") {
        const close = source.indexOf("*/", pos + 2);
        pos = close === -1 ? len : close + 2;
      } else break;
    }
    if (!source.startsWith("import", pos)) break;
    const boundary = source[pos + 6];
    if (boundary !== undefined && /[A-Za-z0-9_$]/.test(boundary)) break; // an identifier like `importantThing`
    let cursor = pos + 6;
    while (cursor < len && /\s/.test(source[cursor])) cursor++;
    if (source[cursor] === "(" || source[cursor] === ".") break; // dynamic import / import.meta
    // the specifier is the first string literal in an import declaration
    let quote = -1;
    for (let i = cursor; i < len; i++) {
      if (source[i] === '"' || source[i] === "'") {
        quote = i;
        break;
      }
      if (source[i] === ";") break scan; // malformed — let the compiler complain
    }
    if (quote === -1) break;
    const closing = source.indexOf(source[quote], quote + 1);
    if (closing === -1) break;
    specifiers.push(source.slice(quote + 1, closing));
    let stmtEnd = closing + 1;
    while (stmtEnd < len && (source[stmtEnd] === " " || source[stmtEnd] === "\t")) stmtEnd++;
    if (source[stmtEnd] === ";") stmtEnd++;
    pos = stmtEnd;
    end = stmtEnd;
  }
  const importBlock = source.slice(0, end);
  return {
    importBlock,
    specifiers,
    body: source.slice(end),
    importLines: importBlock.length === 0 ? 0 : importBlock.split("\n").length - (importBlock.endsWith("\n") ? 1 : 0),
  };
}

export interface BundleContext {
  /** Dir holding decanter.config.json, or null when none is in reach. */
  syncRoot: string | null;
  /** npm packages opted in for bundling (config `bundleDependencies`). */
  bundleDependencies: string[];
}

/**
 * Compile-time context: nearest decanter.config.json upward from `fromDir`.
 * Reads only `bundleDependencies` — no credentials or env involved, so
 * config-free verbs (`run` on a bare file) stay config-free.
 */
export function findBundleContext(fromDir: string): BundleContext {
  let dir = path.resolve(fromDir);
  for (;;) {
    const file = path.join(dir, "decanter.config.json");
    if (existsSync(file)) {
      let deps: unknown;
      try {
        deps = (JSON.parse(readFileSync(file, "utf8")) as { bundleDependencies?: unknown }).bundleDependencies;
      } catch (err) {
        throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
      }
      return {
        syncRoot: dir,
        bundleDependencies: Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string") : [],
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { syncRoot: null, bundleDependencies: [] };
    dir = parent;
  }
}

/** Package name of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`). */
function packageName(spec: string): string {
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
}

/**
 * Offline import rules for a node file (plans/14): relative imports stay
 * inside the sync dir, bare specifiers need a `bundleDependencies` opt-in,
 * builtins can never be bundled. Shared by the compliance guard and the
 * compiler, so `check` and `push` disagree on nothing.
 */
export function checkNodeImports(file: string, specifiers: string[], ctx: BundleContext): string[] {
  const problems: string[] = [];
  for (const spec of specifiers) {
    if (spec.startsWith("node:") || BUILTINS.has(packageName(spec))) {
      problems.push(`imports the Node builtin "${spec}" — builtins cannot be bundled into a Code node (whether n8n allows them at runtime is the instance's NODE_FUNCTION_ALLOW_BUILTIN policy); inline the logic instead`);
    } else if (spec.startsWith("./") || spec.startsWith("../")) {
      if (ctx.syncRoot !== null) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (resolved !== ctx.syncRoot && !resolved.startsWith(ctx.syncRoot + path.sep)) {
          problems.push(`imports "${spec}", which resolves outside the sync dir (${ctx.syncRoot}) — shared code must live inside it`);
        }
      }
    } else if (path.isAbsolute(spec)) {
      problems.push(`imports the absolute path "${spec}" — use a relative import inside the sync dir`);
    } else if (!ctx.bundleDependencies.includes(packageName(spec))) {
      problems.push(`imports the npm package "${packageName(spec)}" without opting it in — add it to "bundleDependencies" in decanter.config.json to bundle it into the pushed node`);
    }
  }
  return problems;
}

/**
 * One-way compile of a .ts node file to the JS that runs inside n8n.
 * Without imports this is a plain esbuild transform — byte-identical to the
 * pre-bundling compiler, so existing nodes never change shape or hash. With
 * imports, the file is bundled self-contained (see the header comment); the
 * output is still a function body ending in a top-level `return`.
 */
export async function compileTs(file: string, log?: Log): Promise<string> {
  const source = readFileSync(file, "utf8");
  const { importBlock, specifiers, body } = scanNodeImports(source);

  if (specifiers.length === 0) {
    const result = await transform(source, {
      loader: "ts",
      format: "cjs",
      target: "node18",
      sourcefile: file,
    });
    return result.code.endsWith("\n") ? result.code : result.code + "\n";
  }

  const ctx = findBundleContext(path.dirname(file));
  const problems = checkNodeImports(file, specifiers, ctx);
  if (problems.length > 0) {
    throw new Error(`${file}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }

  const workingDir = ctx.syncRoot ?? path.dirname(file);
  // The entry must contain NO `export` syntax: n8n's task-runner sandbox
  // neuters getter property descriptors (Object.defineProperty with `get`
  // reads back undefined), and esbuild lowers module exports to exactly such
  // getters. A plain assignment onto a free identifier sidesteps the entire
  // export machinery — esbuild inlines ESM imports directly into the iife
  // scope, getter-free.
  const entry =
    importBlock +
    (importBlock.endsWith("\n") ? "" : "\n") +
    `${GLOBAL_NAME}.default = async () => {\n` +
    body +
    "\n};\n";
  let bundled: string;
  try {
    const result = await build({
      stdin: {
        contents: entry,
        loader: "ts",
        resolveDir: path.dirname(file),
        sourcefile: path.basename(file),
      },
      bundle: true,
      format: "iife",
      platform: "node",
      target: "node18",
      write: false,
      // sync-root-relative module comments -> machine-independent hashes
      absWorkingDir: workingDir,
      logLevel: "silent",
    });
    bundled = result.outputFiles[0].text;
  } catch (err) {
    const e = err as { errors?: Array<{ text: string; location?: { file?: string; line?: number } | null }> };
    const messages = e.errors?.map((m) => (m.location?.file ? `${m.location.file}:${m.location.line}: ${m.text}` : m.text)) ?? [(err as Error).message];
    throw new Error(`${file}: bundling failed\n${messages.map((m) => `  ${m}`).join("\n")}`);
  }
  // Same sandbox constraint, second front: esbuild's CJS-interop helper
  // (__copyProps, used by __toESM for npm packages) copies properties as
  // getters. Rewrite it to eager data assignment — snapshot-at-require is
  // normal CommonJS behavior, and our bundles have no live-binding needs.
  bundled = bundled.replace(
    /__defProp\(to, key, \{ get: \(\) => from\[key\], enumerable: [^}]+\}\);/,
    "to[key] = from[key];",
  );
  if (/\b__export\(/.test(bundled)) {
    log?.warn(`${file}: the bundle contains lazily-wrapped modules (import cycle or top-level await in shared code?) — these rely on getter exports, which n8n's Code-node sandbox does not support; restructure the shared imports`);
  }
  const code = `var ${GLOBAL_NAME} = {};\n${bundled}return ${GLOBAL_NAME}.default();\n`;
  if (code.length > SIZE_WARN_BYTES && log) {
    log.warn(`${file}: compiled node is ${Math.round(code.length / 1024)} KB after bundling — large nodes bloat the workflow JSON; consider trimming imports`);
  }
  return code;
}
