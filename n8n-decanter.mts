#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { N8nApi } from "./lib/api.mts";
import { loadConfig } from "./lib/config.mts";
import { init } from "./lib/init.mts";
import { pullWorkflow } from "./lib/pull.mts";
import { pushWorkflow } from "./lib/push.mts";
import { renameNode, renameWorkflow } from "./lib/rename.mts";
import { runNode } from "./lib/run.mts";
import { findWorkflowDir, listWorkflowDirs } from "./lib/state.mts";
import { statusWorkflow } from "./lib/status.mts";
import type { Log } from "./lib/types.mts";
import { runTypecheck, validateWorkflowDir } from "./lib/validate.mts";
import { watchWorkflow } from "./lib/watch.mts";

const log: Log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`\x1b[33m! ${m}\x1b[0m`),
  error: (m) => console.error(`\x1b[31mx ${m}\x1b[0m`),
};

const USAGE = `Usage:
  n8n-decanter init [dir] [--force]   interactive setup: .env, starter files, config
                                   (--force re-copies template files over existing ones)
  n8n-decanter [id...] pull        pull workflows (default: all in decanter.config.json)
  n8n-decanter [id...] push [--force] [--no-typecheck]
  n8n-decanter [id...] status
  n8n-decanter [id...] check [--no-typecheck]   offline layout-compliance check
  n8n-decanter <id> rename "<old node>" "<new node>"   rename a node everywhere (offline)
  n8n-decanter <id> rename --workflow "<new name>"     rename the workflow itself
  n8n-decanter [id] watch [--force]   watch code/ + workflow.json, push on save
                                   (starts with a safety commit + pull; structural
                                   conflicts prompt; browser live-reload optional)
  n8n-decanter <node-file> run [fixture.json]   run a node locally (offline)
  n8n-decanter uuid [count]        print lowercase v4 UUID(s) for new node ids

The verb may sit anywhere among the arguments: "n8n-decanter push wf123" is the
same as "n8n-decanter wf123 push", and flags may appear in any position too.

Config: decanter.config.json (searched upward from cwd), credentials from .env
next to it or the environment (N8N_HOST, N8N_API_KEY).`;

const VERBS = new Set(["init", "pull", "push", "status", "check", "rename", "watch", "run", "uuid", "help"]);

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const noTypecheck = args.includes("--no-typecheck");
  const workflowFlag = args.includes("--workflow");
  const positional = args.filter((a) => !a.startsWith("--"));
  // id-first support: the first token matching a known verb is the command,
  // wherever it sits — `push wf123` and `wf123 push` are equivalent.
  const verbIndex = positional.findIndex((a) => VERBS.has(a));
  const command = verbIndex === -1 ? positional[0] : positional[verbIndex];
  const rest = positional.filter((_, i) => i !== verbIndex);

  if (!command || command === "help" || args[0] === "--help") {
    console.log(USAGE);
    return;
  }

  if (command === "init") {
    // must run before loadConfig: a fresh directory has no config/.env yet
    if (rest.length > 1) throw new Error("init takes at most one directory argument");
    await init(rest[0], { force }, log);
    return;
  }

  // Offline, config-free verbs — no decanter.config.json or credentials needed.
  if (command === "uuid") {
    const count = rest[0] ? Number(rest[0]) : 1;
    if (!Number.isInteger(count) || count < 1) throw new Error("uuid count must be a positive integer");
    for (let i = 0; i < count; i++) console.log(randomUUID());
    return;
  }

  if (command === "run") {
    if (rest.length < 1) throw new Error("run needs a node file argument: n8n-decanter run <node-file> [fixture.json]");
    await runNode(rest[0], rest[1], log);
    return;
  }

  const config = loadConfig(process.cwd(), { requireCredentials: command !== "check" && command !== "rename" });
  const api = new N8nApi(config);
  const ids = rest.length > 0 ? rest : config.workflows;

  switch (command) {
    case "pull":
    case "push":
    case "status": {
      if (ids.length === 0) {
        throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
      }
      if (command === "push" && !noTypecheck) await runTypecheck(config.configDir, log);
      let failed = false;
      for (const id of ids) {
        try {
          if (command === "pull") {
            const { name, dir } = await pullWorkflow(api, config.root, id, { commitOnPull: config.commitOnPull }, log);
            log.info(`pulled "${name}" -> ${dir}`);
          } else if (command === "push") {
            await pushWorkflow(api, config.root, id, { force, commitOnPush: config.commitOnPush }, log);
          } else {
            await statusWorkflow(api, config.root, id, log);
          }
        } catch (err) {
          failed = true;
          log.error(`${id}: ${(err as Error).message}`);
        }
      }
      if (failed) process.exitCode = 1;
      break;
    }
    case "check": {
      const dirs = rest.length > 0
        ? rest.map((id) => {
            const dir = findWorkflowDir(config.root, id, log);
            if (!dir) throw new Error(`workflow ${id} not found under ${config.root} — pull it first`);
            return dir;
          })
        : listWorkflowDirs(config.root);
      if (dirs.length === 0) log.info(`nothing to check — no pulled workflows under ${config.root}`);
      let errorCount = 0;
      for (const dir of dirs) {
        const name = path.basename(dir);
        const { errors, warnings } = validateWorkflowDir(dir);
        for (const w of warnings) log.warn(`${name}: ${w}`);
        for (const e of errors) log.error(`${name}: ${e}`);
        if (errors.length === 0) log.info(`${name}: OK`);
        errorCount += errors.length;
      }
      if (!noTypecheck) {
        try {
          // explicit ids scope the typecheck output too; bare `check` stays project-wide
          await runTypecheck(config.configDir, log, rest.length > 0 ? dirs : undefined);
        } catch (err) {
          log.error((err as Error).message);
          errorCount++;
        }
      }
      if (errorCount > 0) process.exitCode = 1;
      break;
    }
    case "rename": {
      const [id, ...names] = rest;
      if (!id) throw new Error('rename needs a workflow id: n8n-decanter rename <id> "<old node>" "<new node>" (or --workflow "<new name>")');
      if (workflowFlag) {
        if (names.length !== 1) throw new Error('rename --workflow needs exactly one name: n8n-decanter rename <id> --workflow "<new name>"');
        renameWorkflow(config.root, id, names[0], log);
      } else {
        if (names.length !== 2) throw new Error('rename needs the old and new node name: n8n-decanter rename <id> "<old node>" "<new node>"');
        renameNode(config.root, id, names[0], names[1], log);
      }
      break;
    }
    case "watch": {
      if (ids.length !== 1) throw new Error("watch needs exactly one workflow id (pass it, or list a single workflow in decanter.config.json)");
      await watchWorkflow(api, config, ids[0], { force }, log);
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
