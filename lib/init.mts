import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./config.mts";
import { createPrompt } from "./prompt.mts";
import type { Log } from "./types.mts";

const TEMPLATE_DIR = fileURLToPath(new URL("../template", import.meta.url));

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
    });
    if (res.ok) log.info(`credentials verified against ${host}`);
    else log.warn(`credential check failed (${res.status} ${res.statusText}) — .env written anyway`);
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    log.warn(`could not reach ${host} (${e.cause?.code ?? e.message}) — .env written anyway`);
  }
}
