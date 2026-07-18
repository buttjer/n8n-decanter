import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./config.mts";
import { createPrompt } from "./prompt.mts";
import { style } from "./style.mts";
import type { Log } from "./types.mts";

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
function printBanner(log: Log): void {
  const version = cliVersion();
  if (!process.stdout.isTTY) {
    log.info(`n8n-decanter v${version}`);
    return;
  }
  for (const row of LOGO_ROWS) console.log(style.red(row.slice(0, 6)) + style.bold(row.slice(6)));
  console.log(style.dim(`n8n workflows ⇄ agentic code · v${version}`));
}

function copyTemplate(srcDir: string, destDir: string, { force = false, protect = new Set() }: { force?: boolean; protect?: Set<string> } = {}): string[] {
  const overwritten: string[] = [];
  const walk = (src: string, dest: string, rel: string): void => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, path.join(dest, entry.name), path.join(rel, entry.name));
        continue;
      }
      const name = entry.name.endsWith(".example") && entry.name !== ".example"
        ? entry.name.slice(0, -".example".length)
        : entry.name;
      const destPath = path.join(dest, name);
      const exists = existsSync(destPath);
      if (exists && (!force || protect.has(destPath))) continue;
      copyFileSync(srcPath, destPath);
      if (exists) overwritten.push(path.join(rel, name));
    }
  };
  walk(srcDir, destDir, "");
  return overwritten;
}

/** Interactive bootstrap: prompt for credentials, write .env, copy template/. */
export async function init(targetDir: string | undefined, { force = false }: { force?: boolean } = {}, log: Log): Promise<void> {
  printBanner(log);
  const dir = path.resolve(targetDir ?? ".");
  mkdirSync(dir, { recursive: true });
  const envFile = path.join(dir, ".env");
  const existing = parseEnvFile(envFile);
  let host = existing.N8N_HOST ?? "";
  let apiKey = existing.N8N_API_KEY ?? "";

  if (host && apiKey) {
    // complete .env → nothing to ask; edit or delete .env to change credentials
    log.info(`using existing .env (${host})`);
  } else {
    const rl = createPrompt();
    try {
      host = (await rl.question(`n8n host${host ? ` [${host}]` : ""}: `)).trim() || host;
      apiKey = (await rl.question(`n8n API key${apiKey ? " [enter = keep existing]" : ""}: `)).trim() || apiKey;
    } finally {
      rl.close();
    }
    if (!host || !apiKey) throw new Error("host and API key are required");
    if (!/^https?:\/\//.test(host)) host = "https://" + host;
    host = host.replace(/\/+$/, "");
    writeFileSync(envFile, `N8N_HOST=${host}\nN8N_API_KEY=${apiKey}\n`);
    log.info(`wrote ${envFile}`);
  }

  // Copy the template completely (whatever it contains, recursively).
  // Default: never overwrite files that already exist in the target.
  // --force re-copies template files over existing ones (.env excepted —
  // it was just written with real credentials).
  // Files named `X.example` are inert in this repo (so agent tooling ignores
  // them while working on the CLI itself) and materialize as `X` in the target.
  const overwritten = copyTemplate(TEMPLATE_DIR, dir, { force, protect: new Set([envFile]) });
  log.info(`copied template -> ${dir}`);
  for (const rel of overwritten) log.warn(`--force: overwrote ${rel} with the template version`);

  const configFile = path.join(dir, "decanter.config.json");
  if (!existsSync(configFile)) {
    writeFileSync(configFile, JSON.stringify({ root: "./workflows", workflows: [] }, null, 2) + "\n");
    log.info("wrote decanter.config.json — add your workflow ids to it");
  }

  const gitignoreFile = path.join(dir, ".gitignore");
  if (!existsSync(gitignoreFile)) {
    writeFileSync(gitignoreFile, "node_modules/\n.env\n");
    log.info("wrote .gitignore");
  } else if (!readFileSync(gitignoreFile, "utf8").split("\n").some((l) => l.trim() === ".env")) {
    log.warn(".gitignore exists but does not ignore .env — add it, the file holds your API key");
  }

  try {
    const res = await fetch(`${host}/api/v1/workflows?limit=1`, {
      headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" },
      // best-effort probe: fail fast on a black-holed host rather than hanging init
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) log.info(`credentials verified against ${host}`);
    else log.warn(`credential check failed (${res.status} ${res.statusText}) — .env written anyway`);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const reason = e.name === "TimeoutError" ? "timed out after 10s" : e.cause?.code ?? e.message;
    log.warn(`could not reach ${host} (${reason}) — .env written anyway`);
  }
}
