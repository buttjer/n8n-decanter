import { existsSync, readFileSync, realpathSync } from "node:fs";
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
// esbuild labels every bundled module with a `// <path>` comment, so whatever
// we call the stdin entry lands *inside* the compiled bytes — and therefore
// inside the `@ts-n8n sha256:` marker. Using the node's own filename made a
// pure remote rename change the artifact: `pull` renames `compute.ts` ->
// `ümläut-nödé.ts`, the comment follows, and the node reads "push pending"
// forever on a comment-only diff. A fixed name keeps the entry label stable
// across renames; the surrounding dir still comes from `resolveDir`, which is
// sticky (a workflow folder never follows a remote rename — Plan 27).
const ENTRY_SOURCEFILE = "node.ts";

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

/** realpath when resolvable, the input untouched otherwise (missing dirs). */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Package name of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`). */
function packageName(spec: string): string {
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
}

export interface ImportCheck {
  /** Violations that block a push — `--force` does not bypass them. */
  blocking: string[];
  /** Advisory findings — reported everywhere, blocking nothing (Plan 79). */
  advisory: string[];
}

/**
 * Offline import rules for a node file (plans/14), split by who the rule
 * protects (Plan 79 task 7): a Node builtin or an un-opted-in npm package is
 * **blocking** — esbuild is silent about both, so without the block the
 * failure (a `__require` shim, a silently inlined package) surfaces at
 * runtime on the instance. A relative import leaving the sync dir, or an
 * absolute path, is **advisory** — it only endangers the author's own
 * portability, and esbuild fails loudly wherever the target is genuinely
 * absent. Shared by the compliance guard and the compiler, so preflight's
 * `layout` check and `push` disagree on nothing.
 */
export function checkNodeImports(file: string, specifiers: string[], ctx: BundleContext): ImportCheck {
  const blocking: string[] = [];
  const advisory: string[] = [];
  for (const spec of specifiers) {
    if (spec.startsWith("node:") || BUILTINS.has(packageName(spec))) {
      blocking.push(`imports the Node builtin "${spec}" — builtins cannot be bundled into a Code node (whether n8n allows them at runtime is the instance's NODE_FUNCTION_ALLOW_BUILTIN policy); inline the logic instead`);
    } else if (spec.startsWith("./") || spec.startsWith("../")) {
      if (ctx.syncRoot !== null) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (resolved !== ctx.syncRoot && !resolved.startsWith(ctx.syncRoot + path.sep)) {
          advisory.push(`imports "${spec}", which resolves outside the sync dir (${ctx.syncRoot}) — it bundles, but anyone whose checkout lacks the target can't build this node`);
        }
      }
    } else if (path.isAbsolute(spec)) {
      advisory.push(`imports the absolute path "${spec}" — it bundles on this machine only; prefer a relative import inside the sync dir`);
    } else if (!ctx.bundleDependencies.includes(packageName(spec))) {
      blocking.push(`imports the npm package "${packageName(spec)}" without opting it in — add it to "bundleDependencies" in decanter.config.json to bundle it into the pushed node`);
    }
  }
  return { blocking, advisory };
}

/**
 * One-way compile of a .ts node file to the JS that runs inside n8n.
 * Without imports this is a plain esbuild transform — byte-identical to the
 * pre-bundling compiler, so existing nodes never change shape or hash. With
 * imports, the file is bundled self-contained (see the header comment); the
 * output is still a function body ending in a top-level `return`.
 */
export async function compileTs(file: string, log?: Log, opts?: { quietImportWarnings?: boolean }): Promise<string> {
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
  const { blocking, advisory } = checkNodeImports(file, specifiers, ctx);
  if (blocking.length > 0) {
    throw new Error(`${file}:\n${blocking.map((p) => `  ${p}`).join("\n")}`);
  }
  // Advisory findings warn and let the compile proceed (Plan 79 task 7). The
  // push paths pass quietImportWarnings because their guard tier already
  // printed the same findings — without it every violation would print twice
  // per push, once per channel.
  if (!opts?.quietImportWarnings) {
    for (const p of advisory) log?.warn(`${file}: ${p}`);
  }

  // Realpath the label base: esbuild resolves every bundled module to its
  // realpath, so a symlink anywhere in the sync dir's own path (macOS /tmp,
  // a symlinked checkout) would otherwise make `path.relative` climb across
  // the symlink — machine-specific `../…` module labels inside the hashed
  // bytes, i.e. the exact cross-machine drift the sync-root-relative labels
  // exist to prevent (Plan 79 task 4).
  const workingDir = realDir(ctx.syncRoot ?? path.dirname(file));
  // resolveDir follows, but ONLY when its realpath stays inside the real sync
  // root (the whole-tree-behind-a-symlink shape, where realpathing keeps the
  // entry label clean). When a symlink BETWEEN the root and the node file
  // realpaths out of the tree, keep the caller's spelling: imports must
  // resolve exactly where checkNodeImports approved them, or the guard and
  // the bundler disagree — approving X/shared and then bundling (or failing
  // on) something else entirely.
  const spelledDir = path.dirname(file);
  const realNodeDir = realDir(spelledDir);
  const resolveDir = realNodeDir === workingDir || realNodeDir.startsWith(workingDir + path.sep) ? realNodeDir : spelledDir;
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
        resolveDir,
        sourcefile: ENTRY_SOURCEFILE,
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
