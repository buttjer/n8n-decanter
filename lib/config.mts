import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DecanterConfig } from "./types.mts";

/** Parse KEY=VALUE lines (optional `export`, quotes stripped) from an env file. */
export function parseEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[0].trimStart().startsWith("#")) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

/** Load .env (if present) into process.env, not overriding existing vars. */
export function loadEnv(dir: string): void {
  for (const [key, value] of Object.entries(parseEnvFile(path.join(dir, ".env")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Load decanter.config.json from cwd (or nearest ancestor) and resolve paths. */
export function loadConfig(cwd: string = process.cwd(), { requireCredentials = true } = {}): DecanterConfig {
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
      };
      loadEnv(dir);
      const host = (process.env.N8N_HOST ?? "").replace(/\/+$/, "");
      const apiKey = process.env.N8N_API_KEY ?? "";
      if (requireCredentials && (!host || !apiKey)) {
        throw new Error("N8N_HOST and N8N_API_KEY must be set (via .env next to decanter.config.json or the environment)");
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
        host,
        apiKey,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("decanter.config.json not found (searched from " + cwd + " upward)");
    dir = parent;
  }
}
