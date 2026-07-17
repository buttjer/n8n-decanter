#!/usr/bin/env node
import { N8nApi } from "./lib/api.mjs";
import { loadConfig } from "./lib/config.mjs";
import { pullWorkflow } from "./lib/pull.mjs";
import { pushWorkflow } from "./lib/push.mjs";
import { statusWorkflow } from "./lib/status.mjs";
import { watchFile } from "./lib/watch.mjs";

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`\x1b[33m! ${m}\x1b[0m`),
  error: (m) => console.error(`\x1b[31mx ${m}\x1b[0m`),
};

const USAGE = `Usage:
  n8n-decanter pull [id...]        pull workflows (default: all in decanter.config.json)
  n8n-decanter push [id...] [--force]
  n8n-decanter status [id...]
  n8n-decanter watch <node-file> [--force]

Config: decanter.config.json (searched upward from cwd), credentials from .env
next to it or the environment (N8N_HOST, N8N_API_KEY).`;

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const force = args.includes("--force");
  const rest = args.filter((a) => !a.startsWith("--"));

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const api = new N8nApi(config);
  const ids = rest.length > 0 ? rest : config.workflows;

  switch (command) {
    case "pull":
    case "push":
    case "status": {
      if (ids.length === 0) {
        throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
      }
      let failed = false;
      for (const id of ids) {
        try {
          if (command === "pull") {
            const { name, dir } = await pullWorkflow(api, config.root, id, log);
            log.info(`pulled "${name}" -> ${dir}`);
          } else if (command === "push") {
            await pushWorkflow(api, config.root, id, { force }, log);
          } else {
            await statusWorkflow(api, config.root, id, log);
          }
        } catch (err) {
          failed = true;
          log.error(`${id}: ${err.message}`);
        }
      }
      if (failed) process.exitCode = 1;
      break;
    }
    case "watch": {
      if (rest.length !== 1) throw new Error("watch needs exactly one node file argument");
      await watchFile(api, rest[0], { force }, log);
      break;
    }
    default:
      console.log(USAGE);
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
