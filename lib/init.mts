import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { PROXY_STATE_FILE } from "./mcpserve.mts";
import { createPrompt, type Prompt } from "./prompt.mts";
import { detectAgent, printSkillsRecommendation } from "./skills.mts";
import { style } from "./style.mts";
import { classifyTemplateFile, MANIFEST_FILE, readManifest, writeManifest, type TemplateOutcome } from "./template.mts";
import type { Log } from "./types.mts";
import { sha256 } from "./util.mts";

/**
 * Normalize a user-entered n8n host into a full origin. A scheme the user typed
 * is kept as-is; a scheme-less host gets `http://` when it is a LOCAL address
 * (localhost, loopback, private LAN ranges, `*.local`) and `https://` otherwise.
 * A local n8n almost always serves plain http, so blindly defaulting to https
 * left `.env` pointing at a TLS endpoint that doesn't exist — every sync/guard
 * fetch then failed with `fetch failed` (Plan 35 field-test finding). Trailing
 * slashes are stripped.
 */
export function normalizeHostInput(raw: string): string {
  const host = raw.trim();
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, "");
  const isLocal =
    /^(localhost|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[::1\]|::1|[a-z0-9-]+\.local)(:\d+)?$/i.test(host);
  return ((isLocal ? "http://" : "https://") + host).replace(/\/+$/, "");
}

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

/** Own package version (banner, `--version`); tolerant of an unreadable package.json. */
export function cliVersion(): string {
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
 * baseline manifest. Pure scan — no files are written. `extraSources` folds in
 * files authored *outside* `template/` that init still materializes into the
 * sync dir (Plan 43: `n8n-globals.d.ts` is sourced from the single root file,
 * not a byte-identical `template/*.example` duplicate) — they flow through the
 * identical pristine/drift/manifest logic, keyed by their materialized rel path.
 */
function scanTemplate(srcDir: string, destDir: string, manifest: Record<string, string>, protect: Set<string>, extraSources: Array<{ rel: string; srcPath: string }> = []): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  const classify = (srcPath: string, materializedRel: string): void => {
    const destPath = path.join(destDir, materializedRel);
    if (protect.has(destPath)) return; // .env: written separately, never manifest-tracked
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
  };
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
      classify(srcPath, path.join(rel, name));
    }
  };
  walk(srcDir, "");
  for (const s of extraSources) classify(s.srcPath, s.rel);
  return entries;
}

function copyEntry(entry: TemplateEntry): void {
  mkdirSync(path.dirname(entry.destPath), { recursive: true });
  copyFileSync(entry.srcPath, entry.destPath);
}

/**
 * Template files that changed NAME between CLI versions, as materialized rel
 * paths. The manifest is keyed by path, so without this a rename reads as
 * "delete one file, add another" and the two copies coexist — which for a
 * settings file means the stale one silently keeps applying.
 *
 * Plan 56: `.claude/settings.local.json` → `.claude/settings.json`. The file
 * holds *project policy* (decanter's verb permissions, the `verify.mjs` and
 * `mcp-route-check.mjs` hooks) — nothing machine-specific — and it was already
 * being committed (init's `.gitignore` never covered it) and tracked in the
 * shared `.decanter-template.json`. Scaffolding it into the `local` slot both
 * mislabeled it and squatted the one file Claude Code reserves for the *user's*
 * own machine-specific overrides.
 */
const TEMPLATE_RENAMES: ReadonlyArray<{ from: string; to: string }> = [
  { from: path.join(".claude", "settings.local.json"), to: path.join(".claude", "settings.json") },
];

/**
 * Resolve each rename against a target dir, before the template scan runs.
 * Returns the destination paths the scan must NOT write this run, plus manifest
 * entries to carry over — a deferred migration has to stay tracked, or the next
 * re-init (whose manifest is rebuilt from scanned template files, and so has
 * forgotten the old name) can no longer tell decanter's leftover file from one
 * the user wrote, and gives up on it forever.
 *
 * Deliberately file-driven rather than manifest-driven: a rename does not
 * change the file's *contents*, so "is this decanter's copy, untouched?" is
 * answerable by hashing — which also works for dirs that pre-date manifests.
 *
 * - The old file is not ours (no manifest entry, contents ≠ the template) →
 *   leave it completely alone. It is the user's own personal settings file, and
 *   the new project-scoped one is scaffolded alongside it as normal.
 * - Ours and pristine → delete it; the scan then lands the new name.
 * - Ours but locally edited → keep it and **skip scaffolding the new name**.
 *   Writing both would double-register the PostToolUse/SessionStart hooks, so
 *   the user is told to move their file instead. The next init picks up where
 *   they left off, because this check reads the filesystem, not a flag.
 * - Both names already present → touch nothing, just report the shadowing.
 *
 * `--force` keeps its documented meaning (reset every template file to its
 * template version): it removes the old name even when edited, rather than
 * leaving a stale file to shadow the reset copy.
 */
function migrateRenamedTemplateFiles(srcDir: string, destDir: string, manifest: Record<string, string>, force: boolean, log: Log): { skip: Set<string>; keep: Record<string, string> } {
  const skip = new Set<string>();
  const keep: Record<string, string> = {};
  for (const { from, to } of TEMPLATE_RENAMES) {
    const oldPath = path.join(destDir, from);
    if (!existsSync(oldPath)) continue;
    const newPath = path.join(destDir, to);
    const oldHash = sha256(readFileSync(oldPath, "utf8"));
    const templateSrc = path.join(srcDir, `${to}.example`);
    const templateHash = existsSync(templateSrc) ? sha256(readFileSync(templateSrc, "utf8")) : "";
    // Never touch a file decanter did not put there.
    if (manifest[from] === undefined && oldHash !== templateHash) continue;
    if (existsSync(newPath) && !force) {
      keep[from] = manifest[from] ?? oldHash;
      log.warn(`${from} and ${to} both exist — the old file still applies (and its hooks fire twice); merge it into ${to} and delete it`);
      continue;
    }
    if (force && oldHash !== templateHash) {
      rmSync(oldPath);
      log.warn(`--force: removed ${from} (had local changes) — its content now lives at ${to}`);
    } else if (oldHash === templateHash || oldHash === manifest[from]) {
      rmSync(oldPath);
      log.info(`renamed ${from} -> ${to} — it holds shared project policy, so the local slot is yours again`);
    } else {
      skip.add(newPath);
      // stay tracked: this is still decanter's file until the user resolves it
      keep[from] = manifest[from] ?? oldHash;
      log.warn(`${from} has local edits, so ${to} was NOT scaffolded (both files' hooks would fire) — move your copy to ${to}, or delete it, then re-run init`);
    }
  }
  return { skip, keep };
}

/**
 * Modification-aware template refresh (dpkg conffile-style). First init copies
 * everything and records a baseline manifest. Re-init copies files new to the
 * template, offers to refresh files the user hasn't touched (pristine), and
 * leaves locally-modified files alone while reporting the drift. `--force` is
 * the escape hatch: it overwrites every template file regardless.
 */
async function refreshTemplate(srcDir: string, destDir: string, { force, protect, version, extraSources }: { force: boolean; protect: Set<string>; version: string; extraSources?: Array<{ rel: string; srcPath: string }> }, log: Log): Promise<void> {
  const manifest = readManifest(destDir);
  const firstInit = !existsSync(path.join(destDir, MANIFEST_FILE));
  // Renames first: a file the migration deletes must look absent to the scan
  // (so the new name is simply "added"), and one it defers must look protected.
  const { skip: renameSkips, keep: renameKeep } = migrateRenamedTemplateFiles(srcDir, destDir, manifest.files, force, log);
  const entries = scanTemplate(srcDir, destDir, manifest.files, new Set([...protect, ...renameSkips]), extraSources);
  // A pending rename stays in the baseline; everything else is rebuilt from the
  // scan, which is what retires the old key once the migration completes.
  const nextFiles: Record<string, string> = { ...renameKeep };

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
 * Bootstrap a sync dir (Plan 32: OAuth-first). Interactive by default: prompt
 * for the host, run the browser OAuth consent for MCP (the sync backend) with a
 * paste-a-bearer fallback, offer the OPTIONAL public API key (executions /
 * data-tables / backup only), write .env + .decanter-auth.json, copy template/.
 *
 * Passing any of `--host`/`--token`/`--api-key` (Plan 35 field-test finding —
 * init was undrivable headless) switches to a fully **non-interactive** mode:
 * values come from the flags + the existing .env, and NOT ONE prompt is issued
 * (a missing MCP token just warns, a missing API key is skipped). The flag-less
 * invocation is unchanged (interactive, or answers piped over stdin).
 *
 * Plan 55: a first init closes by pointing at n8n's official skills pack — a
 * printed recommendation, never a prompt, so no run's stdin changes.
 */
export async function init(
  targetDir: string | undefined,
  { force = false, host: hostFlag, token: tokenFlag, apiKey: apiKeyFlag }: { force?: boolean; host?: string; token?: string; apiKey?: string } = {},
  log: Log,
): Promise<void> {
  printBanner(log);
  const dir = path.resolve(targetDir ?? ".");
  mkdirSync(dir, { recursive: true });
  const envFile = path.join(dir, ".env");
  const existing = parseEnvFile(envFile);
  // Precedence: an explicit flag wins over the existing .env, which wins over a
  // prompt. A flag host is normalized the same way a typed one is.
  let host = hostFlag !== undefined ? normalizeHostInput(hostFlag) : (existing.N8N_HOST ?? "");
  let apiKey = apiKeyFlag ?? existing.N8N_API_KEY ?? "";
  let mcpToken = tokenFlag ?? existing.N8N_MCP_TOKEN ?? "";
  const interactive = process.stdin.isTTY === true;
  // Any setup flag → non-interactive: drive init purely from flags + existing
  // .env, issuing no prompts (and no OAuth-fallback token prompt either).
  const flagDriven = hostFlag !== undefined || tokenFlag !== undefined || apiKeyFlag !== undefined;
  // Plan 55: point at the official skills pack once, on a FIRST init (= no
  // baseline manifest yet). Printed, never asked — every run's stdin stays
  // exactly as it was.
  const firstInit = !existsSync(path.join(dir, MANIFEST_FILE));
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
      log.info(hostFlag !== undefined ? `using --host ${host}` : `using existing .env host (${host})`);
    } else if (flagDriven) {
      throw new Error("host is required — pass --host <url> (e.g. --host http://localhost:5678)");
    } else {
      host = await ask("n8n host: ");
      if (!host) throw new Error("host is required");
      host = normalizeHostInput(host);
    }

    // --- MCP credentials (the sync backend): existing → OAuth consent (TTY) →
    // paste-a-token fallback. Only the browser consent itself is TTY-gated;
    // piped runs go straight to the token prompt so init stays scriptable.
    // --token / any setup flag suppresses every prompt (non-interactive mode).
    const auth = readAuthFileTolerant(dir, log);
    if (mcpToken !== "") {
      log.info(tokenFlag !== undefined ? "using MCP token from --token" : "using existing MCP token from .env (N8N_MCP_TOKEN)");
    } else if (auth !== null && auth.host === host) {
      log.info(`using existing MCP OAuth credentials (${AUTH_FILE})`);
    } else if (interactive) {
      try {
        const { clientId, tokens } = await runOAuthConsent(host, { log, openBrowser: openBrowserCommand });
        writeAuthFile(dir, { host, clientId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt });
        log.ok(`connected to ${host} via OAuth — credentials in ${AUTH_FILE} (gitignored)`);
      } catch (err) {
        log.warn(`OAuth consent did not complete (${(err as Error).message})`);
        if (!flagDriven) mcpToken = await ask("paste an n8n MCP token (n8n → Settings → MCP → API key) [Enter to skip]: ");
      }
    } else if (!flagDriven) {
      mcpToken = await ask("n8n MCP token (n8n → Settings → MCP → API key) [Enter to skip]: ");
    }
    if (mcpToken === "" && !(auth !== null && auth.host === host)) {
      log.warn("no MCP credentials yet — sync verbs (pull/push/watch/…) will not work until you re-run init or set N8N_MCP_TOKEN");
    }

    // --- optional public API key (the REST-only surfaces)
    if (apiKey === "" && !flagDriven) {
      apiKey = await ask("n8n public API key (optional — executions/data-tables/backup) [Enter to skip]: ");
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
  // `n8n-globals.d.ts` is the exception: it's sourced from the single root file
  // (Plan 43 — no `template/*.example` duplicate to drift) but materialized and
  // tracked exactly like a template file.
  const extraSources = [{ rel: "n8n-globals.d.ts", srcPath: path.join(PACKAGE_ROOT, "n8n-globals.d.ts") }];
  await refreshTemplate(TEMPLATE_DIR, dir, { force, protect: new Set([envFile]), version: cliVersion(), extraSources }, log);

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
    writeFileSync(gitignoreFile, `node_modules/\n.env\n${AUTH_FILE}\n${PROXY_STATE_FILE}\nworkflows/*/executions/\ndata-tables/\n`);
    log.info("wrote .gitignore");
  } else {
    const content = readFileSync(gitignoreFile, "utf8");
    const lines = content.split("\n").map((l) => l.trim());
    if (!lines.includes(".env")) log.warn(".gitignore exists but does not ignore .env — add it, the file holds credentials");
    // append rather than warn (Plan 33): these files hold secrets (the MCP
    // refresh token; the guard-proxy session secret) — leaving them
    // committable on a re-init is a real leak, and an append to a user's
    // .gitignore is safely additive
    const missing = [AUTH_FILE, PROXY_STATE_FILE].filter((f) => !lines.includes(f));
    if (missing.length > 0) {
      writeFileSync(gitignoreFile, `${content}${content.endsWith("\n") || content === "" ? "" : "\n"}${missing.join("\n")}\n`);
      log.info(`appended ${missing.join(" + ")} to .gitignore — credential-holding files`);
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

  // --- the official n8n skills pack (Plan 55). Dead last, and output-only:
  // decanter names the pack and prints the commands for the detected agent,
  // but installs nothing (see lib/skills.mts for why).
  if (firstInit) printSkillsRecommendation(detectAgent(), log);
}
