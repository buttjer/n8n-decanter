import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DecanterConfig } from "./types.mts";

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

/** Load .env (if present) into process.env, not overriding existing vars. */
export function loadEnv(dir: string): void {
  for (const [key, value] of Object.entries(parseEnvFile(path.join(dir, ".env")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Load decanter.config.json from cwd (or nearest ancestor) and resolve paths.
 * `requireHost` gates only N8N_HOST (online verbs need it): the API key is
 * optional since Plan 32 (MCP is the sync backend; `requireApiKey` guards the
 * REST-API-only verbs at use time) and MCP credentials are resolved separately
 * (lib/mcp.mts `resolveMcpAuth` — env token or .decanter-auth.json).
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
        browserReload?: string;
        proxyPort?: number;
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
        throw new Error("N8N_HOST must be set (via .env next to decanter.config.json or the environment)");
      }
      return {
        configDir: dir,
        root: path.resolve(dir, cfg.root ?? "./workflows"),
        workflows: cfg.workflows ?? [],
        commitOnPush: cfg.commitOnPush !== false,
        commitOnPull: cfg.commitOnPull !== false,
        browserReload: cfg.browserReload === "proxy" ? "proxy" : "off",
        proxyPort: typeof cfg.proxyPort === "number" ? cfg.proxyPort : 5679,
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
    if (parent === dir) throw new Error("decanter.config.json not found (searched from " + cwd + " upward)");
    dir = parent;
  }
}
