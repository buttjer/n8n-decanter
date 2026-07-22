import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./config.mts";
import {
  AUTH_FILE,
  McpClient,
  type McpAuthFile,
  openBrowserCommand,
  readAuthFile,
  runOAuthConsent,
  searchWorkflows,
  writeAuthFile,
} from "./mcp.mts";
import { createPrompt, type Prompt } from "./prompt.mts";
import { style } from "./style.mts";
import { classifyTemplateFile, MANIFEST_FILE, readManifest, writeManifest, type TemplateOutcome } from "./template.mts";
import type { Log } from "./types.mts";
import { sha256 } from "./util.mts";

/** Like readAuthFile, but a corrupt file only warns — init re-mints it. */
function readAuthFileTolerant(dir: string, log: Log): McpAuthFile | null {
  try {
    return readAuthFile(dir);
  } catch (err) {
    log.warn((err as Error).message);
    return null;
  }
}

/**
 * Nearest ancestor of `startDir` holding a package.json — the package root.
 * Works from the checkout (lib/ → repo root) *and* from the published build
 * (dist/lib/ → package root): dist/ ships no package.json, so a plain
 * `../template` URL would resolve to the nonexistent dist/template in the
 * npm tarball (release blocker found 2026-07-18). Exported for tests.
 */
export function packageRootFrom(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir); // fs root — let the template lookup fail loudly
    dir = parent;
  }
}

const PACKAGE_ROOT = packageRootFrom(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "template");

/** Own package version (banner); tolerant of an unreadable package.json. */
function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Wordmark in the 2×2 quadrant-block minifont (Block Elements). The top row's
// leading offset is load-bearing (ascenders of 8/d/t) — keep it verbatim.
// Columns 0-5 are the "n8n" part (brand red on a TTY), the rest "decanter".
const LOGO_ROWS = [
  "  ▄▖     ▌        ▗",
  "▛▌▙▌▛▌  ▛▌█▌▛▘▀▌▛▌▜▘█▌▛▘",
  "▌▌▙▌▌▌  ▙▌▙▖▙▖█▌▌▌▐▖▙▖▌",
];

/** TTY: logo + tagline + version. Piped: one plain, stable version line. */
export function printBanner(log: Log): void {
  const version = cliVersion();
  if (!process.stdout.isTTY) {
    log.info(`n8n-decanter v${version}`);
    return;
  }
  for (const row of LOGO_ROWS) console.log(style.red(row.slice(0, 6)) + style.bold(row.slice(6)));
  console.log(style.dim(`n8n workflows ⇄ agentic code · v${version}`));
}

interface TemplateEntry {
  /** Materialized rel path — manifest key *and* on-disk location under destDir. */
  rel: string;
  srcPath: string;
  destPath: string;
  templateHash: string;
  targetHash?: string;
  outcome: TemplateOutcome;
}

/**
 * Classify every template file against the target dir and the copy-time
 * baseline manifest. Pure scan — no files are written.
 */
function scanTemplate(srcDir: string, destDir: string, manifest: Record<string, string>, protect: Set<string>): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  const walk = (src: string, rel: string): void => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, path.join(rel, entry.name));
        continue;
      }
      const name = entry.name.endsWith(".example") && entry.name !== ".example"
        ? entry.name.slice(0, -".example".length)
        : entry.name;
      const materializedRel = path.join(rel, name);
      const destPath = path.join(destDir, materializedRel);
      if (protect.has(destPath)) continue; // .env: written separately, never manifest-tracked
      const templateHash = sha256(readFileSync(srcPath, "utf8"));
      const exists = existsSync(destPath);
      const targetHash = exists ? sha256(readFileSync(destPath, "utf8")) : undefined;
      const manifestHash = manifest[materializedRel];
      entries.push({
        rel: materializedRel,
        srcPath,
        destPath,
        templateHash,
        targetHash,
        outcome: classifyTemplateFile({ exists, targetHash, templateHash, manifestHash }),
      });
    }
  };
  walk(srcDir, "");
  return entries;
}

function copyEntry(entry: TemplateEntry): void {
  mkdirSync(path.dirname(entry.destPath), { recursive: true });
  copyFileSync(entry.srcPath, entry.destPath);
}

/**
 * Modification-aware template refresh (dpkg conffile-style). First init copies
 * everything and records a baseline manifest. Re-init copies files new to the
 * template, offers to refresh files the user hasn't touched (pristine), and
 * leaves locally-modified files alone while reporting the drift. `--force` is
 * the escape hatch: it overwrites every template file regardless.
 */
async function refreshTemplate(srcDir: string, destDir: string, { force, protect, version }: { force: boolean; protect: Set<string>; version: string }, log: Log): Promise<void> {
  const manifest = readManifest(destDir);
  const firstInit = !existsSync(path.join(destDir, MANIFEST_FILE));
  const entries = scanTemplate(srcDir, destDir, manifest.files, protect);
  const nextFiles: Record<string, string> = {};

  if (force) {
    let anyExisting = false;
    for (const e of entries) {
      const changed = e.targetHash !== undefined && e.targetHash !== e.templateHash;
      if (e.targetHash !== undefined) anyExisting = true;
      copyEntry(e);
      nextFiles[e.rel] = e.templateHash;
      if (e.targetHash !== undefined) log.warn(`--force: overwrote ${e.rel} with the template version${changed ? " (had local changes)" : ""}`);
    }
    writeManifest(destDir, { version, files: nextFiles });
    log.info(anyExisting ? `reset template -> ${destDir}` : `copied template -> ${destDir}`);
    return;
  }

  const added: string[] = [];
  const pending: TemplateEntry[] = [];
  const modified: string[] = [];
  const conflicts: string[] = [];
  let uptodate = 0;

  for (const e of entries) {
    switch (e.outcome) {
      case "added":
        copyEntry(e);
        nextFiles[e.rel] = e.templateHash;
        added.push(e.rel);
        break;
      case "converged":
        nextFiles[e.rel] = e.templateHash; // adopt: on-disk copy now equals the template
        break;
      case "adopt":
        nextFiles[e.rel] = e.targetHash!; // legacy dir: trust the on-disk copy as the baseline
        break;
      case "update":
        pending.push(e);
        nextFiles[e.rel] = manifest.files[e.rel]!; // provisional; set to templateHash if applied
        break;
      case "drift-modified":
        modified.push(e.rel);
        nextFiles[e.rel] = manifest.files[e.rel]!;
        break;
      case "drift-conflict":
        conflicts.push(e.rel);
        nextFiles[e.rel] = manifest.files[e.rel]!;
        break;
      case "uptodate":
        uptodate++;
        nextFiles[e.rel] = e.templateHash;
        break;
    }
  }

  // On first init everything is "added" — the single "copied template" line
  // below says it; only call out files the template *gained* on a re-init.
  if (!firstInit) for (const rel of added) log.info(`added ${rel} from the template`);

  if (pending.length > 0) {
    let apply = false;
    if (process.stdin.isTTY) {
      const rl = createPrompt();
      try {
        log.info(`${pending.length} template file(s) have newer versions and are unmodified locally:`);
        for (const e of pending) log.info(`  ${e.rel}`);
        apply = (await rl.question(`Update ${pending.length} pristine file(s) to the template version? [y/N] `)).trim().toLowerCase().startsWith("y");
      } finally {
        rl.close();
      }
    } else {
      log.warn(`${pending.length} pristine template file(s) have updates available — re-run init interactively or with --force to apply: ${pending.map((e) => e.rel).join(", ")}`);
    }
    if (apply) {
      for (const e of pending) {
        copyEntry(e);
        nextFiles[e.rel] = e.templateHash;
      }
      log.info(`updated ${pending.length} file(s) from the template`);
    }
  }

  if (modified.length > 0) log.warn(`left unchanged (modified locally): ${modified.join(", ")}`);
  if (conflicts.length > 0) log.warn(`left unchanged (changed in both the template and your copy — resolve manually or --force to reset): ${conflicts.join(", ")}`);

  writeManifest(destDir, { version, files: nextFiles });
  // "copied" only when the whole tree was genuinely fresh; a dir that pre-dates
  // the manifest (files present, no baseline) adopts in place — report as such.
  if (added.length === entries.length) log.info(`copied template -> ${destDir}`);
  else log.info(`template up to date (${uptodate} unchanged${added.length ? `, ${added.length} added` : ""})`);
}

/**
 * Interactive bootstrap (Plan 32: OAuth-first): prompt for the host, run the
 * browser OAuth consent for MCP (the sync backend) with a paste-a-bearer
 * fallback, offer the OPTIONAL public API key (executions / data-tables
 * only), write .env + .decanter-auth.json, copy template/.
 */
export async function init(targetDir: string | undefined, { force = false }: { force?: boolean } = {}, log: Log): Promise<void> {
  printBanner(log);
  const dir = path.resolve(targetDir ?? ".");
  mkdirSync(dir, { recursive: true });
  const envFile = path.join(dir, ".env");
  const existing = parseEnvFile(envFile);
  let host = existing.N8N_HOST ?? "";
  let apiKey = existing.N8N_API_KEY ?? "";
  let mcpToken = existing.N8N_MCP_TOKEN ?? "";
  const interactive = process.stdin.isTTY === true;
  // ONE shared prompt session for every question: a second createPrompt()
  // would lose piped answers the first one already buffered, so the session
  // opens lazily on the first question and closes once at the end.
  let rl: Prompt | undefined;
  const ask = async (q: string): Promise<string> => {
    rl ??= createPrompt();
    return (await rl.question(q)).trim();
  };
  try {
    // --- host (prompted over stdin even when piped — init stays scriptable)
    if (host !== "") {
      log.info(`using existing .env host (${host})`);
    } else {
      host = await ask("n8n host: ");
      if (!host) throw new Error("host is required");
      if (!/^https?:\/\//.test(host)) host = "https://" + host;
      host = host.replace(/\/+$/, "");
    }

    // --- MCP credentials (the sync backend): existing → OAuth consent (TTY) →
    // paste-a-token fallback. Only the browser consent itself is TTY-gated;
    // piped runs go straight to the token prompt so init stays scriptable.
    const auth = readAuthFileTolerant(dir, log);
    if (mcpToken !== "") {
      log.info("using existing MCP token from .env (N8N_MCP_TOKEN)");
    } else if (auth !== null && auth.host === host) {
      log.info(`using existing MCP OAuth credentials (${AUTH_FILE})`);
    } else if (interactive) {
      try {
        const { clientId, tokens } = await runOAuthConsent(host, { log, openBrowser: openBrowserCommand });
        writeAuthFile(dir, { host, clientId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt });
        log.ok(`connected to ${host} via OAuth — credentials in ${AUTH_FILE} (gitignored)`);
      } catch (err) {
        log.warn(`OAuth consent did not complete (${(err as Error).message})`);
        mcpToken = await ask("paste an n8n MCP token (n8n → Settings → MCP → API key) [Enter to skip]: ");
      }
    } else {
      mcpToken = await ask("n8n MCP token (n8n → Settings → MCP → API key) [Enter to skip]: ");
    }
    if (mcpToken === "" && !(auth !== null && auth.host === host)) {
      log.warn("no MCP credentials yet — sync verbs (pull/push/watch/…) will not work until you re-run init or set N8N_MCP_TOKEN");
    }

    // --- optional public API key (the REST-only surfaces)
    if (apiKey === "") {
      apiKey = await ask("n8n public API key (optional — executions/data-tables) [Enter to skip]: ");
    }
  } finally {
    rl?.close();
  }

  // Rewrite .env preserving any other keys the user added (comments are not preserved).
  const envOut: Record<string, string> = { ...existing, N8N_HOST: host };
  if (apiKey !== "") envOut.N8N_API_KEY = apiKey;
  if (mcpToken !== "") envOut.N8N_MCP_TOKEN = mcpToken;
  const envText = Object.entries(envOut).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (!existsSync(envFile) || readFileSync(envFile, "utf8") !== envText) {
    writeFileSync(envFile, envText);
    log.info(`wrote ${envFile}`);
  }

  // Copy the template (whatever it contains, recursively), recording a
  // per-file baseline in .decanter-template.json. Re-init is modification-aware:
  // pristine files can be refreshed (after confirm), locally-edited files are
  // left alone with drift reported, and `--force` overwrites everything. `.env`
  // is protected (just written with real credentials) and never tracked.
  // Files named `X.example` are inert in this repo (so agent tooling ignores
  // them while working on the CLI itself) and materialize as `X` in the target.
  await refreshTemplate(TEMPLATE_DIR, dir, { force, protect: new Set([envFile]), version: cliVersion() }, log);

  const configFile = path.join(dir, "decanter.config.json");
  if (!existsSync(configFile)) {
    writeFileSync(configFile, JSON.stringify({ root: "./workflows", workflows: [] }, null, 2) + "\n");
    log.info("wrote decanter.config.json — add your workflow ids to it");
  }

  const gitignoreFile = path.join(dir, ".gitignore");
  if (!existsSync(gitignoreFile)) {
    // .env and .decanter-auth.json hold credentials; executions/ and
    // data-tables/ hold fetched data (may contain credentials/PII) —
    // belt-and-braces with the self-ignoring .gitignore each fetch verb
    // writes into pre-existing sync dirs
    writeFileSync(gitignoreFile, `node_modules/\n.env\n${AUTH_FILE}\nworkflows/*/executions/\ndata-tables/\n`);
    log.info("wrote .gitignore");
  } else {
    const lines = readFileSync(gitignoreFile, "utf8").split("\n").map((l) => l.trim());
    if (!lines.includes(".env")) log.warn(".gitignore exists but does not ignore .env — add it, the file holds credentials");
    if (!lines.includes(AUTH_FILE) && existsSync(path.join(dir, AUTH_FILE))) {
      log.warn(`.gitignore does not ignore ${AUTH_FILE} — add it, the file holds your MCP refresh token`);
    }
  }

  // --- verify: MCP first (the sync backend), then the optional API key
  const mcpEnv = mcpToken !== "" ? mcpToken : undefined;
  const mcpAuth = mcpEnv !== undefined
    ? { kind: "bearer" as const, token: mcpEnv }
    : (() => {
        const data = readAuthFileTolerant(dir, log);
        return data !== null && data.host === host ? { kind: "oauth" as const, file: path.join(dir, AUTH_FILE), data } : null;
      })();
  if (mcpAuth !== null) {
    try {
      const workflows = await searchWorkflows(new McpClient({ host, auth: mcpAuth, requestTimeoutMs: 10_000 }));
      const available = workflows.filter((w) => w.availableInMCP).length;
      log.ok(`MCP connection verified — ${workflows.length} workflow${workflows.length === 1 ? "" : "s"} visible, ${available} available to pull`);
      if (available < workflows.length) {
        log.info(style.dim(`  workflows must be opted in per-workflow: n8n workflow card (⋯ menu) or workflow settings → "Available in MCP"`));
      }
    } catch (err) {
      log.warn(`MCP check failed (${(err as Error).message.split("\n")[0]}) — credentials written anyway`);
    }
  }
  if (apiKey !== "") {
    try {
      const res = await fetch(`${host}/api/v1/workflows?limit=1`, {
        headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" },
        // best-effort probe: fail fast on a black-holed host rather than hanging init
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) log.info(`API key verified against ${host}`);
      else log.warn(`API key check failed (${res.status} ${res.statusText}) — .env written anyway`);
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const reason = e.name === "TimeoutError" ? "timed out after 10s" : e.cause?.code ?? e.message;
      log.warn(`could not reach ${host} (${reason}) — .env written anyway`);
    }
  }
}
