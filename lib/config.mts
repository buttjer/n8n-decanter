import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { credentialFile } from "./git.mts";
import type { DecanterConfig } from "./types.mts";

/** The env file `init` writes next to `decanter.config.json` (gitignored). */
export const ENV_FILE = ".env";

/**
 * The one message every cold start hits — a fresh clone has no `.env`, so this
 * is the first thing a user (or their agent) reads. It names the **flag** form
 * on purpose: [Plan 75](../plans/done/75-init-cold-start-discoverability.md)
 * came out of a blind round where the agent diagnosed the missing `.env` in one
 * command and then sent its human to the *interactive* `init`, because nothing
 * here mentioned that `init` takes the values as arguments. Shared with
 * `createMcpClient`, which used to carry its own copy of the same string.
 */
export const HOST_UNSET =
  "N8N_HOST must be set (via .env next to decanter.config.json or the environment)\n" +
  "  set it without prompts: n8n-decanter init . --host <host-url> --token <mcp-token>";

/** Parse KEY=VALUE lines (optional `export`, quotes stripped) from an env file. */
export function parseEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    // Comment/blank lines can't match the key pattern, so a null `m` already
    // filters them — no separate `#` guard needed.
    if (!m) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

/**
 * Guard for the REST-API-only verbs (executions, data-tables, and backup — the
 * surfaces MCP cannot serve). Names the verb so the error says *why* an API
 * key is suddenly needed in an otherwise MCP-only setup.
 */
export function requireApiKey(config: DecanterConfig, verb: string): DecanterConfig {
  if (config.apiKey === "") {
    throw new Error(`\`${verb}\` uses the n8n public REST API (MCP does not cover it) — set N8N_API_KEY in .env next to decanter.config.json (n8n → Settings → n8n API)`);
  }
  return config;
}

/**
 * Load the env file (if present) into process.env, not overriding existing
 * vars. In a linked worktree without one of its own, the main checkout's copy
 * is read instead (`credentialFile`) — the file is gitignored, so every fresh
 * worktree starts without it and every credentialed verb would otherwise fail
 * on `HOST_UNSET`.
 */
export function loadEnv(dir: string): void {
  for (const [key, value] of Object.entries(parseEnvFile(credentialFile(dir, ENV_FILE)))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Where `loadConfig`'s upward search STARTS: `--dir` > `N8N_DECANTER_DIR` > cwd.
 * The search itself is untouched (Plan 81) — this only moves its origin, so a
 * sync dir nested in a bigger repo stays reachable from a process started at the
 * repo root. That is the shape agent wiring falls into: an MCP entry hoisted to
 * the repo root spawns `mcp connect` with cwd = the root, and an upward-only
 * search can never walk *down* into `flows/`.
 *
 * **The env var is the load-bearing half, not the flag** — every agent's MCP
 * server entry has an `env` block, while a `cwd` key is not guaranteed across
 * agents and versions.
 *
 * **Both forms resolve against cwd on purpose:** a committed root `.mcp.json`
 * carrying `N8N_DECANTER_DIR=flows` survives a clone on a teammate's machine,
 * where an absolute `/home/me/repo/flows` would not. (`loadEnv` never overrides
 * an already-set variable, so the sync dir's own `.env` can't fight the value
 * that pointed decanter at it — and couldn't anyway: it is read only *after*
 * the dir has been found.)
 *
 * A path that is not a directory fails here, loudly. Left alone it would walk
 * to the filesystem root and surface as "not found (searched from … upward)" —
 * a message about the wrong problem.
 */
export function resolveSearchStart(
  dirFlag?: string,
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  const envDir = env.N8N_DECANTER_DIR;
  // Empty counts as unset: an agent config that interpolates a missing value
  // ships `"N8N_DECANTER_DIR": ""`, and inheriting cwd beats failing on it.
  const override = dirFlag !== undefined && dirFlag !== ""
    ? { value: dirFlag, source: "--dir" }
    : envDir !== undefined && envDir !== ""
      ? { value: envDir, source: "N8N_DECANTER_DIR" }
      : undefined;
  if (override === undefined) return path.resolve(cwd);
  const resolved = path.resolve(cwd, override.value);
  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new Error(
      `${override.source} ${override.value} is not a directory (resolved to ${resolved})\n` +
      "  it names the sync dir — the folder holding decanter.config.json — and relative paths\n" +
      "  resolve against the working directory, so a repo-relative value stays portable",
    );
  }
  return resolved;
}

/**
 * Bounded hunt for a sync dir *below* `start` — the evidence that separates
 * "not a sync dir yet" from "the search started too high" (Plan 81). Breadth-
 * first so the shallow hit wins, skipping `node_modules` and every dot-dir
 * (`.git` included — nobody's sync dir lives there, and they are where the file
 * count explodes). Symlinked dirs report `isDirectory()` false from a `Dirent`,
 * so a link cycle is never entered.
 *
 * **Three caps, and the WALL-CLOCK one is the load-bearing cap.** Counting
 * directories is not enough: measured here, a single `existsSync` inside an
 * rclone/NFS-style mount costs ~500 ms, so a scan of a home directory holding
 * one ran **16 seconds** — on the failure path of every verb, the guard's
 * `mcp connect` startup included. This whole scan only sharpens an error
 * message, so it is never worth waiting for: past the deadline it gives up and
 * the caller falls back to the cold-start advice.
 *
 * One `readdirSync` per visited dir, and the hit is read out of those entries —
 * the earlier shape (readdir the parent, then stat `<child>/decanter.config.json`
 * for every child) paid two round trips per directory to learn the same thing.
 *
 * Exported for `init` (Plan 86), the second caller and the only one that asks
 * *before* writing: 81 taught the failure path of every read verb to recognise a
 * sync dir below the cwd, while `init` — the one verb that scaffolds into a
 * directory the user has not vetted — kept scaffolding a second one on top of it.
 * `start` itself is never a hit, so a re-init inside an existing sync dir is
 * unaffected.
 */
export function findConfigBelow(start: string, maxDepth = 3, maxDirs = 400, maxMs = 250): string | undefined {
  const deadline = Date.now() + maxMs;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    if (visited >= maxDirs || Date.now() > deadline) return undefined;
    const { dir, depth } = queue.shift()!;
    visited++;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // unreadable directory (permissions, a race) — skip it; this scan is
      // never authoritative
      continue;
    }
    // `start` itself cannot hold one — loadConfig checked it before walking up.
    // `!isDirectory()` rather than `isFile()`: a `Dirent` reports a SYMLINK as
    // neither, and loadConfig's own `existsSync` would happily follow one.
    if (dir !== start && entries.some((e) => e.name === "decanter.config.json" && !e.isDirectory())) return dir;
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      // Cap the QUEUE too, or one directory with 100k children buys itself
      // 100k queue entries before the visit counter ever gets a say.
      if (queue.length >= maxDirs) break;
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return undefined;
}

/**
 * Load decanter.config.json from cwd (or nearest ancestor) and resolve paths.
 * `requireHost` gates only N8N_HOST (online verbs need it): the API key is
 * optional since Plan 32 (MCP is the sync backend; `requireApiKey` guards the
 * REST-API-only verbs at use time) and MCP credentials are resolved separately
 * (lib/mcp.mts `resolveMcpAuth` — env token or .decanter-auth.json).
 * `cwd` is where the search *starts*; the CLI passes `resolveSearchStart(…)` so
 * `--dir`/`N8N_DECANTER_DIR` can move that origin without touching the walk.
 */
export function loadConfig(cwd: string = process.cwd(), { requireHost = true } = {}): DecanterConfig {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, "decanter.config.json");
    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
      }
      const cfg = parsed as {
        root?: string;
        workflows?: string[];
        commitOnPush?: boolean;
        commitOnPull?: boolean;
        requestTimeoutMs?: number;
        n8nVersion?: string;
        dataTables?: boolean;
        liveMirror?: boolean;
        backupLimit?: number;
      };
      loadEnv(dir);
      const host = (process.env.N8N_HOST ?? "").replace(/\/+$/, "");
      const apiKey = process.env.N8N_API_KEY ?? "";
      if (requireHost && !host) {
        throw new Error(HOST_UNSET);
      }
      return {
        configDir: dir,
        root: path.resolve(dir, cfg.root ?? "./workflows"),
        workflows: cfg.workflows ?? [],
        commitOnPush: cfg.commitOnPush !== false,
        commitOnPull: cfg.commitOnPull !== false,
        requestTimeoutMs: typeof cfg.requestTimeoutMs === "number" && cfg.requestTimeoutMs > 0 ? cfg.requestTimeoutMs : 30_000,
        n8nVersion: typeof cfg.n8nVersion === "string" && cfg.n8nVersion !== "" ? cfg.n8nVersion : undefined,
        dataTables: cfg.dataTables !== false,
        liveMirror: cfg.liveMirror !== false,
        backupLimit: typeof cfg.backupLimit === "number" && cfg.backupLimit >= 0 ? Math.floor(cfg.backupLimit) : 20,
        host,
        apiKey,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Two different situations end up here, and the advice inverts between
      // them — so say which one the user is in. A sync dir sitting *below* the
      // starting point means the setup is fine and the search merely began too
      // high (an agent launched at the repo root; Plan 81). Sending that user to
      // `init` would scaffold a second sync dir on top of a working one.
      const nested = findConfigBelow(path.resolve(cwd));
      if (nested !== undefined) {
        const rel = path.relative(path.resolve(cwd), nested) || ".";
        throw new Error(
          "decanter.config.json not found (searched from " + cwd + " upward)\n" +
          "  it is not missing — the sync dir sits BELOW the working directory: " + nested + "\n" +
          "  the search only walks up, so name the sync dir explicitly:\n" +
          // The `=` form, not `--dir <rel>`: the space form declines to eat a
          // value that is also a verb, so a sync dir called `test/` or `list/`
          // would come back as "--dir needs a value" from a copy-paste.
          "  n8n-decanter <verb> --dir=" + rel + "\n" +
          "  or set N8N_DECANTER_DIR=" + rel + " (agents: the `env` block of the decanter MCP server entry)",
        );
      }
      // A hand-written `.env` is the classic half-setup: an agent that cannot
      // run the browser OAuth flow asks its human to paste `N8N_MCP_TOKEN`
      // into a file and stops there, leaving no config, template, .gitignore
      // or agent wiring. Name the non-interactive `init` (it takes the very
      // same token as a flag) so the fix is one command, not a research task.
      throw new Error(
        "decanter.config.json not found (searched from " + cwd + " upward)\n" +
        "  this is not a decanter sync dir yet — writing .env by hand is not enough; init also\n" +
        "  scaffolds the config, template, .gitignore and agent configs:\n" +
        "  n8n-decanter init . --host <host-url> --token <mcp-token>",
      );
    }
    dir = parent;
  }
}
