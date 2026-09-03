import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findConfigBelow, parseEnvFile } from "./config.mts";
import {
  AUTH_FILE,
  McpClient,
  type McpAuth,
  type McpAuthFile,
  openBrowserCommand,
  readAuthFile,
  runOAuthConsent,
  searchWorkflows,
  TokenRefreshError,
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
// Columns 0-5 are the "n8n" part (brand orange on a TTY — the website's accent,
// see style.brand), the rest "decanter".
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
  for (const row of LOGO_ROWS) console.log(style.brand(row.slice(0, 6)) + style.bold(row.slice(6)));
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
 * Nearest STRICT ancestor of `dir` that looks like the **agent's** project root
 * — one holding `.git` (a *file* in worktrees and submodules, so `existsSync`,
 * never `statSync().isDirectory()`) or a `package.json`. Null when there is
 * none, which is the standalone sync dir every earlier version assumed.
 *
 * Only strict ancestors count, and that is what makes the test cheap: the sync
 * dir's own scaffolded `package.json` — and a `git init` run inside it, the
 * shape the docs teach — are never mistaken for a parent project.
 *
 * `.git` beats an intermediate `package.json` on the way up: in a monorepo the
 * repo root is the dir people actually open, while a sub-package manifest is
 * just a stop along the walk.
 *
 * Consulting git here answers "where would the agent be started?", a different
 * question from "where is the sync dir?" — so it is **not** a reversal of
 * `docs/concepts/sync-layout.md`'s "decanter never uses git to find the sync
 * dir" (which remains true: that is still the upward `decanter.config.json`
 * search, git-blind).
 */
export function projectRootAbove(dir: string): string | null {
  let current = path.resolve(dir);
  let pkgRoot: string | null = null;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return pkgRoot; // fs root: only a package.json ever matched
    if (existsSync(path.join(parent, ".git"))) return parent;
    if (pkgRoot === null && existsSync(path.join(parent, "package.json"))) pkgRoot = parent;
    current = parent;
  }
}

/**
 * The nested-sync-dir note (Plan 81), printed verbatim rather than pointed at:
 * the wiring `init` just wrote is loaded **only from the dir the agent starts
 * in** — `.mcp.json` is merged from every ancestor of that dir (so a nested one
 * is invisible from above) and `.claude/settings.json` is read from that dir
 * alone, no walk in either direction. Verified against Claude Code 2.1.234.
 *
 * Option A leads because it is the only shape with zero further config *and*
 * the only one in which the scaffolded permission globs stay anchored where
 * they were written. Option B is deliberately the long half: a root-hoisted MCP
 * entry needs BOTH the `N8N_DECANTER_DIR` pin (decanter's config search only
 * ever walks *up* from its cwd) and a command that resolves from the root —
 * which `npx --no-install n8n-decanter` does not: it looks in the *launch*
 * dir's `node_modules/.bin`, which under a local install is the sync dir
 * itself. And a hoisted permission list is worse than none: relative globs
 * re-anchor at the root, so a verbatim `Read(.env)`/`Edit(.env)` stops covering
 * the credentials file — hence every glob below carries the sync-dir prefix.
 */
export function nestedWiringNote(syncDir: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, syncDir).split(path.sep).join("/");
  // Local install → the binary is not on the root's PATH; point at it
  // repo-relative (child_process resolves a command containing a separator
  // against the spawn cwd = the agent's root), because an ABSOLUTE path in a
  // committed root config is wrong on every other machine.
  const hasLocalBin = existsSync(path.join(syncDir, "node_modules", ".bin", "n8n-decanter"));
  const command = hasLocalBin ? `${rel}/node_modules/.bin/n8n-decanter` : "n8n-decanter";
  const commandNote = hasLocalBin
    ? `     The command is that path because decanter is installed inside the sync
     dir, not globally. Keep it repo-relative — an absolute path in a committed
     root config breaks for everyone else who clones.`
    : `     The bare command name assumes a global install (npm i -g n8n-decanter).
     If you instead run npm install inside the sync dir, nothing is on the
     root's PATH — use ${rel}/node_modules/.bin/n8n-decanter (repo-relative;
     an absolute path in a committed root config breaks for everyone else).`;
  return `
  This sync dir is nested inside ${projectRoot}. Agents load the wiring just
  scaffolded here only when they are STARTED here: .mcp.json is merged from
  every ancestor of the launch dir (so a nested one is invisible from above),
  and .claude/settings.json is read from the launch dir alone.

  ${style.bold("A. Recommended — start the agent in this dir:")}

       cd "${syncDir}" && claude        # or opencode, codex, …

     Everything just scaffolded then applies unchanged, with no further config.
     Its one cost: that project's own .claude/settings.json does not load then
     (its .mcp.json still does, via the ancestor walk).

  ${style.bold(`B. Or wire up ${projectRoot} by hand — both halves, or it still fails:`)}

     ${projectRoot}/.mcp.json — merge into the servers already there (the
     "n8n-docs" entry needs no dir, copy it over unchanged):

     {
       "mcpServers": {
         "n8n-instance": {
           "command": "${command}",
           "args": ["mcp", "connect"],
           "env": { "N8N_DECANTER_DIR": "${rel}" }
         }
       }
     }

     N8N_DECANTER_DIR is what makes decanter find this dir at all — its config
     search only walks UP from where it was started. It resolves against the
     agent's working dir, so keep it repo-relative.

${commandNote}

     ${projectRoot}/opencode.json — the same two halves:

     {
       "mcp": {
         "n8n-instance": {
           "type": "local",
           "command": ["${command}", "mcp", "connect"],
           "environment": { "N8N_DECANTER_DIR": "${rel}" }
         }
       }
     }

     ${projectRoot}/.claude/settings.json — hooks and permissions, every path
     and every relative glob prefixed with ${rel}:

     {
       "hooks": {
         "PostToolUse": [
           { "matcher": "Edit|Write|MultiEdit",
             "hooks": [{ "type": "command", "command": "node ${rel}/.claude/hooks/verify.mjs" }] },
           { "matcher": "mcp__n8n-instance__update_workflow",
             "hooks": [{ "type": "command", "command": "node ${rel}/.claude/hooks/rename-refs.mjs" }] }
         ],
         "SessionStart": [
           { "hooks": [{ "type": "command", "command": "node ${rel}/.claude/hooks/mcp-route-check.mjs" }] }
         ]
       },
       "permissions": {
         "deny": ["Read(${rel}/.env)", "Edit(${rel}/.env)", "Edit(**/.decanter.json)"]
       }
     }

     Those two .env rules are the sharp end: a relative glob anchors at the
     settings file that declares it, so copying Read(.env)/Edit(.env) up
     verbatim would guard the ROOT's .env and silently stop protecting
     ${rel}/.env — the credentials file. The allow list moves the same way:
     Edit(workflows/**) becomes Edit(${rel}/workflows/**), Edit(shared/**)
     becomes Edit(${rel}/shared/**). Everything else in
     ${rel}/.claude/settings.json names no path and moves across verbatim —
     copy it over too, the "push --force" Bash denies above all; the block
     above is short because only the PATHS need rewriting, not because the
     rest is optional.

     Do not reach for \${CLAUDE_PROJECT_DIR}: it expands to the agent's project
     root — the parent — so it reads as if it pointed here and never does.
`;
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

  // None of the agent wiring hot-loads, and `init` is normally run from INSIDE
  // the session it is meant to configure: permission rules (no edits to
  // `.decanter.json`, no reads of `.env`, no `push --force`), the guarded
  // `n8n-instance` MCP server, and the session hooks are all read at agent
  // startup, so everything just written is inert for it. The docs said
  // "restart" only for the skills plugin, so the wiring that actually gates the
  // agent went unmentioned: the tool knew something the user needed and never
  // said it. Only when a file is new — re-running init in a set-up dir must not
  // nag. What "make it live" MEANS then splits on the layout (see below).
  const agentFiles = [path.join(".claude", "settings.json"), ".mcp.json", "opencode.json"];
  if (agentFiles.some((f) => added.includes(f))) {
    // Plan 81: those same three files are the ones a nested sync dir never gets
    // to use — an agent started at the surrounding project root loads none of
    // them. So the note rides the same gate — it answers "here is what it takes
    // to make what I just wrote live" — and a standalone dir (the shape this all
    // assumed until now) stays completely silent.
    const projectRoot = projectRootAbove(destDir);
    // Plan 83: which line is TRUE depends on that same detection, so branch on
    // it rather than printing "restart" unconditionally and appending the
    // nested note. In a nested dir a restart is not merely insufficient, it is
    // a dead end — startup discovery walks UP from the launch dir, so a session
    // started at the root re-misses this file every time. A blind agent read
    // the old unconditional line, concluded "restart", and had no next idea.
    if (projectRoot === null) {
      log.info(style.dim("  restart your agent (or /reload) before working here — the MCP servers, permission rules and hooks just scaffolded load at agent STARTUP, so this session is still unconfigured"));
    } else {
      log.info(style.dim("  the MCP servers, permission rules and hooks just scaffolded load at agent STARTUP, from the dir the agent was STARTED in — so a restart makes them live only for an agent started in this dir. Started higher up, no restart ever loads them; use A or B below."));
      log.info(nestedWiringNote(destDir, projectRoot));
    }
  }
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
/**
 * Plan 86: refuse to scaffold on top of a sync dir that already sits BELOW the
 * target. `init` is the only verb that writes into a directory the user has not
 * vetted, and it was the verb with the fewest guards on the way in — run from a
 * repo root whose sync dir lives in `n8n/`, it dropped config, template,
 * `workflows/`, `shared/`, `tsconfig.json` and `opencode.json` into the root.
 * Every read verb already recognises that shape (`loadConfig`'s failure path,
 * Plan 81) and says the right thing; this is the same detection, one step
 * earlier, and the message deliberately mirrors that one so the two read as one
 * voice.
 *
 * Runs BEFORE the target directory is created, so a refusal leaves the
 * filesystem exactly as it found it. `findConfigBelow` never counts `start`
 * itself, so re-initing an existing sync dir is untouched; it is depth-, count-
 * and wall-clock-capped, so a miss costs nothing.
 *
 * Only a terminal gets a say — a piped or flag-driven run refuses outright,
 * because the scaffold is the irreversible half and an unattended caller cannot
 * consent to it. The prompt opens its own short-lived session rather than
 * `init`'s shared one: that session exists to keep PIPED answers from being
 * buffered away by a second reader, and this question is asked on a TTY or not
 * at all.
 */
async function refuseNestedSyncDir(dir: string, flagDriven: boolean, log: Log): Promise<void> {
  const nested = findConfigBelow(dir);
  if (nested === undefined) return;
  const rel = path.relative(dir, nested) || ".";
  const advice =
    "  a sync dir already sits BELOW this directory: " + nested + "\n" +
    "  scaffolding here would put a SECOND one on top of a working setup\n" +
    "  to use the existing one from here, name it instead of re-initing:\n" +
    // The `=` form for the same reason config.mts uses it: `--dir <rel>` declines
    // to eat a value that is also a verb, so a sync dir called `test/` or `list/`
    // would come back as "--dir needs a value" from a copy-paste.
    "  n8n-decanter <verb> --dir=" + rel + "\n" +
    "  or set N8N_DECANTER_DIR=" + rel + " (agents: the `env` block of the decanter MCP server entry)\n" +
    "  to set up a different sync dir, give init its own target: n8n-decanter init <dir>";
  if (!(process.stdin.isTTY === true) || flagDriven) {
    throw new Error("refusing to scaffold a sync dir here\n" + advice);
  }
  log.warn("a sync dir already exists at " + nested);
  log.info(advice);
  const rl = createPrompt();
  try {
    const answer = (await rl.question("scaffold a second sync dir in " + dir + " anyway? [y/N]: ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new Error("init cancelled — nothing was written");
  } finally {
    rl.close();
  }
}

/**
 * Browser consent → a fresh OAuth pair on disk. Shared by the setup step and
 * the verify step's re-consent offer (Plan 87), so the two cannot write the
 * auth file differently. Throws on a consent that did not complete; the
 * existing file is untouched until consent succeeds.
 */
async function mintOAuthCredentials(dir: string, host: string, log: Log): Promise<McpAuthFile> {
  const { clientId, tokens } = await runOAuthConsent(host, { log, openBrowser: openBrowserCommand });
  const data: McpAuthFile = { host, clientId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt };
  writeAuthFile(dir, data);
  log.ok(`connected to ${host} via OAuth — credentials in ${AUTH_FILE} (gitignored)`);
  return data;
}

/** The connection probe init closes with: one MCP read, reported for humans. */
async function verifyMcpConnection(host: string, auth: McpAuth, log: Log): Promise<void> {
  const workflows = await searchWorkflows(new McpClient({ host, auth, requestTimeoutMs: 10_000 }));
  const available = workflows.filter((w) => w.availableInMCP).length;
  log.ok(`MCP connection verified — ${workflows.length} workflow${workflows.length === 1 ? "" : "s"} visible, ${available} available to pull`);
  if (available < workflows.length) {
    log.info(style.dim(`  workflows must be opted in per-workflow: n8n workflow card (⋯ menu) or workflow settings → "Available in MCP"`));
  }
}

export async function init(
  targetDir: string | undefined,
  { force = false, reauth = false, host: hostFlag, token: tokenFlag, apiKey: apiKeyFlag }: { force?: boolean; reauth?: boolean; host?: string; token?: string; apiKey?: string } = {},
  log: Log,
): Promise<void> {
  printBanner(log);
  const dir = path.resolve(targetDir ?? ".");
  await refuseNestedSyncDir(dir, hostFlag !== undefined || tokenFlag !== undefined || apiKeyFlag !== undefined, log);
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
  // Whether OAuth credentials are usable at the end — reused or freshly
  // minted. Drives both the "no MCP credentials yet" warning and the verify
  // step's decision about whether re-consent is even on the table.
  let oauthOk = false;
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
    // Plan 87: `--reauth` is the way OUT of a spent refresh token. Reuse is
    // otherwise unconditional whenever the host matches, so the "re-run init"
    // a dead session used to print came straight back here and re-probed with
    // the same dead credentials — a closed loop.
    const reuseAuth = auth !== null && auth.host === host && !reauth;
    if (reauth) {
      if (mcpToken !== "") {
        // N8N_MCP_TOKEN wins over the auth file in resolveMcpAuth, so a freshly
        // minted OAuth pair would be ignored — refuse BEFORE the browser
        // consent rather than after it changed nothing.
        throw new Error(
          `--reauth mints OAuth credentials, but an MCP token is set (${tokenFlag !== undefined ? "--token" : `N8N_MCP_TOKEN in ${envFile}`}) and always wins over them\n` +
            `  to move back to OAuth, remove N8N_MCP_TOKEN from ${envFile}, then: n8n-decanter init --reauth\n` +
            `  to replace the token instead: n8n-decanter init --token <mcp-token>`,
        );
      }
      if (!interactive) {
        throw new Error(
          "--reauth needs a terminal — the OAuth consent step opens a browser\n" +
            "  no browser (CI, a headless box, a coding agent)? mint an MCP token in n8n\n" +
            "  (Settings → MCP → API key) and pass it: n8n-decanter init --token <mcp-token>",
        );
      }
    }
    if (mcpToken !== "") {
      // Doesn't name the flag: `--token` and `--mcp-token` both land here, and
      // echoing a spelling the user didn't type reads like a correction.
      log.info(tokenFlag !== undefined ? "using the MCP token given on the command line" : "using existing MCP token from .env (N8N_MCP_TOKEN)");
    } else if (reuseAuth) {
      log.info(`using existing MCP OAuth credentials (${AUTH_FILE}) — re-consent with \`init --reauth\``);
      oauthOk = true;
    } else if (interactive) {
      if (reauth) log.info(`re-authorizing with ${host} — the existing ${AUTH_FILE} is replaced only if consent succeeds`);
      try {
        await mintOAuthCredentials(dir, host, log);
        oauthOk = true;
      } catch (err) {
        log.warn(`OAuth consent did not complete (${(err as Error).message})`);
        if (!flagDriven) mcpToken = await ask("paste an n8n MCP token (n8n → Settings → MCP → API key) [Enter to skip]: ");
      }
    } else if (!flagDriven) {
      mcpToken = await ask("n8n MCP token (n8n → Settings → MCP → API key) [Enter to skip]: ");
    }
    // `oauthOk`, not a re-test of `auth`: a successful FIRST consent leaves
    // `auth` null, so the old condition told a user who had just authorized in
    // the browser that they had "no MCP credentials yet".
    if (mcpToken === "" && !oauthOk) {
      // Names the flag, not just "re-run init": this fires on exactly the
      // host-only `init --host …` a blind agent reaches first (Plan 75).
      log.warn("no MCP credentials yet — sync verbs (pull/push/watch/…) will not work until you re-run init with `--token <mcp-token>` (n8n → Settings → MCP → API key) or set N8N_MCP_TOKEN");
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
      await verifyMcpConnection(host, mcpAuth, log);
    } catch (err) {
      // Plan 87: a spent refresh token is the ONE failure `init` can actually
      // fix, and it used to end here in "credentials written anyway" — leaving
      // the user at the start of the same loop. Deliberately narrow: only
      // `invalid_grant` says the credential is spent. A network error, a 403
      // "MCP access is disabled" (Plan 74) or a 401 say nothing about it, and
      // re-consenting for those would burn a working token for no reason.
      const spent = err instanceof TokenRefreshError && err.reason === "invalid_grant" && mcpEnv === undefined;
      if (!spent) {
        log.warn(`MCP check failed (${(err as Error).message.split("\n")[0]}) — credentials written anyway`);
      } else if (!interactive) {
        log.warn(`MCP check failed — the stored OAuth refresh token is spent or was revoked`);
        log.info("  re-authorize on a terminal: n8n-decanter init --reauth");
      } else {
        log.warn("the stored OAuth refresh token is spent or was revoked — n8n will not renew it");
        // A second prompt session is safe here and only here: this branch is
        // TTY-gated, so there are no piped answers a closed reader could have
        // swallowed (root AGENTS.md, "TTY-only paths").
        const rl2 = createPrompt();
        let yes: boolean;
        try {
          const answer = (await rl2.question(`re-authorize with ${host} in the browser now? [Y/n]: `)).trim().toLowerCase();
          yes = answer === "" || answer === "y" || answer === "yes";
        } finally {
          rl2.close();
        }
        if (!yes) {
          log.info("  skipped — when you are ready: n8n-decanter init --reauth");
        } else {
          try {
            const fresh = await mintOAuthCredentials(dir, host, log);
            await verifyMcpConnection(host, { kind: "oauth", file: path.join(dir, AUTH_FILE), data: fresh }, log);
          } catch (reErr) {
            log.warn(`re-authorization did not complete (${(reErr as Error).message.split("\n")[0]}) — retry with: n8n-decanter init --reauth`);
          }
        }
      }
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
