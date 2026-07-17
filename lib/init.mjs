import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = fileURLToPath(new URL("../template", import.meta.url));

function parseEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !m[0].trimStart().startsWith("#")) {
      values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return values;
}

function copyTemplate(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      copyTemplate(src, path.join(destDir, entry.name));
      continue;
    }
    const name = entry.name.endsWith(".example") && entry.name !== ".example"
      ? entry.name.slice(0, -".example".length)
      : entry.name;
    const dest = path.join(destDir, name);
    if (!existsSync(dest)) copyFileSync(src, dest);
  }
}

/**
 * Prompt helper that also works with piped stdin: plain readline/promises
 * drops lines arriving before question() is called and hangs forever on EOF.
 */
function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffered = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter("");
  });
  return {
    async question(prompt) {
      process.stdout.write(prompt);
      if (buffered.length > 0) return buffered.shift();
      if (closed) return "";
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

/** Interactive bootstrap: prompt for credentials, write .env, copy template/. */
export async function init(targetDir, log) {
  const dir = path.resolve(targetDir ?? ".");
  mkdirSync(dir, { recursive: true });
  const envFile = path.join(dir, ".env");
  const existing = parseEnvFile(envFile);

  const rl = createPrompt();
  let host, apiKey;
  try {
    const defaultHost = existing.N8N_HOST ?? "";
    host = (await rl.question(`n8n host${defaultHost ? ` [${defaultHost}]` : ""}: `)).trim() || defaultHost;
    const defaultKey = existing.N8N_API_KEY ?? "";
    apiKey = (await rl.question(`n8n API key${defaultKey ? " [enter = keep existing]" : ""}: `)).trim() || defaultKey;
  } finally {
    rl.close();
  }
  if (!host || !apiKey) throw new Error("host and API key are required");
  if (!/^https?:\/\//.test(host)) host = "https://" + host;
  host = host.replace(/\/+$/, "");

  writeFileSync(envFile, `N8N_HOST=${host}\nN8N_API_KEY=${apiKey}\n`);
  log.info(`wrote ${envFile}`);

  // Copy the template completely (whatever it contains, recursively),
  // but never overwrite files that already exist in the target.
  // Files named `X.example` are inert in this repo (so agent tooling ignores
  // them while working on the CLI itself) and materialize as `X` in the target.
  copyTemplate(TEMPLATE_DIR, dir);
  log.info(`copied template -> ${dir}`);

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
    log.warn(`could not reach ${host} (${err.cause?.code ?? err.message}) — .env written anyway`);
  }
}
