import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Parse KEY=VALUE lines from .env (if present) into process.env, not overriding existing vars. */
export function loadEnv(dir) {
  const file = path.join(dir, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[0].trimStart().startsWith("#")) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Load decanter.config.json from cwd (or nearest ancestor) and resolve paths. */
export function loadConfig(cwd = process.cwd(), { requireCredentials = true } = {}) {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, "decanter.config.json");
    if (existsSync(file)) {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
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
        host,
        apiKey,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("decanter.config.json not found (searched from " + cwd + " upward)");
    dir = parent;
  }
}
