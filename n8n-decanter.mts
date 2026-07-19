#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { N8nApi } from "./lib/api.mts";
import { loadConfig } from "./lib/config.mts";
import { cleanExecutions, fetchExecutionById, fetchExecutions } from "./lib/executions.mts";
import { init } from "./lib/init.mts";
import { pullWorkflow } from "./lib/pull.mts";
import { pushWorkflow } from "./lib/push.mts";
import { renameNode, renameWorkflow } from "./lib/rename.mts";
import { runNode } from "./lib/run.mts";
import { findWorkflowDir, listWorkflowDirs, listWorkflowRefs, looksLikeWorkflowId, matchWorkflowRef } from "./lib/state.mts";
import { statusWorkflow } from "./lib/status.mts";
import { style, styleErr, transientLine } from "./lib/style.mts";
import type { Log } from "./lib/types.mts";
import { runTypecheck, validateWorkflowDir } from "./lib/validate.mts";
import { watchWorkflow } from "./lib/watch.mts";

// Every real log line first erases a pending transient "pulling …" status line.
const transient = transientLine();
const log: Log = {
  info: (m) => {
    transient.clear();
    console.log(m);
  },
  ok: (m) => {
    transient.clear();
    console.log(`${style.green("✓")} ${m}`);
  },
  warn: (m) => {
    transient.clear();
    console.warn(styleErr.yellow(`! ${m}`));
  },
  error: (m) => {
    transient.clear();
    console.error(styleErr.red(`✗ ${m}`));
  },
};

const usage = (): string => {
  const b = style.bold;
  const d = style.dim;
  return `Usage:
  ${b("n8n-decanter init")} [dir] [--force]   ${d("interactive setup: .env, starter files, config")}
                                   ${d("(--force re-copies template files over existing ones)")}
  ${b("n8n-decanter")} [ref...] ${b("pull")}       ${d("pull workflows (default: all in decanter.config.json)")}
  ${b("n8n-decanter")} [ref...] ${b("push")} [--force] [--no-typecheck]
  ${b("n8n-decanter")} [ref...] ${b("status")} [--diff]   ${d("drift report (--diff shows line diffs);")}
                                   ${d("exits 1 on conflict/remote drift")}
  ${b("n8n-decanter")} [ref...] ${b("check")} [--no-typecheck]   ${d("offline layout-compliance check")}
  ${b("n8n-decanter")} <ref> ${b("rename")} "<old node>" "<new node>"   ${d("rename a node everywhere (offline)")}
  ${b("n8n-decanter")} <ref> ${b("rename")} --workflow "<new name>"     ${d("rename the workflow itself")}
  ${b("n8n-decanter")} [ref] ${b("watch")} [--force]   ${d("watch code/ + workflow.json, push on save")}
                                   ${d("(starts with a safety commit + pull; structural")}
                                   ${d("conflicts prompt; browser live-reload optional)")}
  ${b("n8n-decanter")} [ref...] ${b("executions")} [--status=success|error|waiting] [--limit=N]
                                   ${d("fetch recent execution data (real run JSON) into")}
                                   ${d("workflows/<Name>/executions/ — gitignored temp files;")}
                                   ${d("a numeric argument fetches that one execution by id")}
  ${b("n8n-decanter")} [ref...] ${b("executions clean")}   ${d("delete fetched execution data (offline)")}
  ${b("n8n-decanter list")} [--remote]      ${d("pulled workflows: name, id, folder")}
                                   ${d("(--remote adds workflows not pulled yet)")}
  ${b("n8n-decanter completion")} zsh|bash  ${d("print a shell completion script for your rc file")}
  ${b("n8n-decanter")} <node-file> ${b("run")} [fixture.json]   ${d("run a node locally (offline)")}
  ${b("n8n-decanter uuid")} [count]         ${d("print lowercase v4 UUID(s) for new node ids")}

A workflow <ref> is its id, its workflow/folder name, or a unique name prefix
(case-insensitive; ambiguity is an error, never a prompt). A workflow named
like a verb must be addressed by id. The verb may sit anywhere among the
arguments: "n8n-decanter push wf123" is the same as "n8n-decanter wf123 push",
and flags may appear in any position too.

Config: decanter.config.json (searched upward from cwd), credentials from .env
next to it or the environment (N8N_HOST, N8N_API_KEY).`;
};

const VERBS = new Set(["init", "pull", "push", "status", "check", "rename", "watch", "run", "uuid", "list", "executions", "completion", "__complete", "help"]);
/** Verbs whose workflow arguments go through name resolution. */
const REF_VERBS = new Set(["pull", "push", "status", "check", "watch"]);

// Both scripts delegate to the hidden `__complete` verb at completion time,
// so candidates stay current without regenerating the script.
const COMPLETION_SCRIPTS: Record<string, string> = {
  zsh: [
    "# n8n-decanter zsh completion — append to ~/.zshrc (after compinit):",
    '#   eval "$(n8n-decanter completion zsh)"',
    "_n8n_decanter() {",
    "  local -a words",
    '  words=(${(f)"$(n8n-decanter __complete 2>/dev/null)"})',
    '  compadd -- "${words[@]}"',
    "}",
    "compdef _n8n_decanter n8n-decanter",
    "",
  ].join("\n"),
  bash: [
    "# n8n-decanter bash completion — append to ~/.bashrc:",
    '#   eval "$(n8n-decanter completion bash)"',
    "_n8n_decanter() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    "  local IFS=$'\\n'",
    '  COMPREPLY=($(compgen -W "$(n8n-decanter __complete 2>/dev/null)" -- "$cur"))',
    "}",
    "complete -F _n8n_decanter n8n-decanter",
    "",
  ].join("\n"),
};

async function main() {
  // --status/--limit take a value (--limit=5 or --limit 5); they're peeled
  // off first so the boolean-flag and positional logic below stays untouched.
  const valueFlags = new Map<string, string>();
  const args: string[] = [];
  {
    const raw = process.argv.slice(2);
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i].match(/^--(status|limit)(?:=(.*))?$/);
      if (!m) {
        args.push(raw[i]);
        continue;
      }
      const value = m[2] ?? raw[++i];
      if (value === undefined || value === "") throw new Error(`--${m[1]} needs a value (e.g. --${m[1]}=${m[1] === "limit" ? "5" : "success"})`);
      valueFlags.set(m[1], value);
    }
  }
  const force = args.includes("--force");
  const noTypecheck = args.includes("--no-typecheck");
  const workflowFlag = args.includes("--workflow");
  const remoteFlag = args.includes("--remote");
  const diffFlag = args.includes("--diff");
  const positional = args.filter((a) => !a.startsWith("--"));
  // id-first support: the first token matching a known verb is the command,
  // wherever it sits — `push wf123` and `wf123 push` are equivalent.
  const verbIndex = positional.findIndex((a) => VERBS.has(a));
  const command = verbIndex === -1 ? positional[0] : positional[verbIndex];
  const rest = positional.filter((_, i) => i !== verbIndex);

  if (!command || command === "help" || args[0] === "--help") {
    console.log(usage());
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

  if (command === "completion") {
    const script = rest[0] !== undefined ? COMPLETION_SCRIPTS[rest[0]] : undefined;
    if (script === undefined) throw new Error("completion needs a shell: n8n-decanter completion zsh|bash");
    process.stdout.write(script);
    return;
  }

  if (command === "__complete") {
    // hidden helper backing the completion scripts: verbs, flags, and local
    // workflow names/ids — offline, credentials-free, silent without a config
    const words = [...VERBS].filter((v) => v !== "__complete" && v !== "help");
    words.push("--force", "--no-typecheck", "--workflow", "--remote", "--diff", "--status=", "--limit=", "--help");
    try {
      const config = loadConfig(process.cwd(), { requireCredentials: false });
      for (const ref of listWorkflowRefs(config.root)) words.push(...ref.names, ref.id);
    } catch {
      // no decanter.config.json in reach — verbs and flags still complete
    }
    console.log([...new Set(words)].join("\n"));
    return;
  }

  const offline = command === "check" || command === "rename" || (command === "list" && !remoteFlag)
    || (command === "executions" && rest.includes("clean"));
  const config = loadConfig(process.cwd(), { requireCredentials: !offline });
  const api = new N8nApi(config);

  /**
   * Workflow-name arguments: resolve a ref locally (id → name → unique
   * prefix); `pull` falls back to the remote workflow list for not-yet-pulled
   * names. An id-shaped ref that matches nothing passes through unchanged —
   * it may exist only remotely (pull/status by fresh id must keep working).
   */
  const resolveRef = async (ref: string): Promise<string> => {
    const local = matchWorkflowRef(listWorkflowRefs(config.root, log), ref);
    if (local) return local.id;
    if (command === "pull") {
      try {
        const remote = await api.listWorkflows();
        const hit = matchWorkflowRef(remote.map((w) => ({ id: w.id, names: [w.name] })), ref);
        if (hit) return hit.id;
      } catch (err) {
        log.warn(`could not list remote workflows to resolve "${ref}" (${(err as Error).message.split("\n")[0]})`);
      }
    }
    if (looksLikeWorkflowId(ref)) return ref;
    const known = listWorkflowRefs(config.root).map((r) => `"${r.name}"`);
    throw new Error(`no workflow matches "${ref}"${known.length > 0 ? ` — pulled workflows: ${known.join(", ")}` : " — nothing pulled yet"}`);
  };

  let refs = rest;
  if (REF_VERBS.has(command)) {
    refs = [];
    for (const r of rest) refs.push(await resolveRef(r));
  } else if (command === "rename" && rest.length > 0) {
    refs = [await resolveRef(rest[0]), ...rest.slice(1)];
  }
  const ids = refs.length > 0 ? refs : config.workflows;

  switch (command) {
    case "pull":
    case "push":
    case "status": {
      if (ids.length === 0) {
        throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
      }
      if (command === "push" && !noTypecheck) await runTypecheck(config.configDir, log);
      let failed = false;
      let drifted = false;
      const total = ids.length;
      for (const [i, id] of ids.entries()) {
        // progress: [2/5] prefix in both modes (dim on a TTY), transient
        // "pulling …" only on a TTY, (0.4s) duration on pull/push result lines
        const prefix = total > 1 ? `[${i + 1}/${total}] ` : "";
        const plog: Log = prefix === "" ? log : {
          info: (m) => log.info(style.dim(prefix) + m),
          ok: (m) => log.ok(style.dim(prefix) + m),
          warn: (m) => log.warn(styleErr.dim(prefix) + m),
          error: (m) => log.error(styleErr.dim(prefix) + m),
        };
        const started = performance.now();
        const dur = () => " " + style.dim(`(${((performance.now() - started) / 1000).toFixed(1)}s)`);
        try {
          if (command === "pull") {
            transient.show(`${prefix}pulling ${id}…`);
            const { name, dir } = await pullWorkflow(api, config.root, id, { commitOnPull: config.commitOnPull }, plog);
            plog.ok(`pulled "${name}" -> ${dir}${dur()}`);
          } else if (command === "push") {
            transient.show(`${prefix}pushing ${id}…`);
            await pushWorkflow(api, config.root, id, { force, commitOnPush: config.commitOnPush }, { ...plog, ok: (m) => plog.ok(m + dur()) });
          } else {
            const { remoteDrift } = await statusWorkflow(api, config.root, id, plog, { diff: diffFlag });
            drifted ||= remoteDrift;
          }
        } catch (err) {
          failed = true;
          plog.error(`${id}: ${(err as Error).message}`);
        } finally {
          transient.clear();
        }
      }
      // status: conflict/remote drift exits 1 so scripts and CI can gate on it
      if (failed || drifted) process.exitCode = 1;
      break;
    }
    case "list": {
      const pulled = listWorkflowRefs(config.root, log);
      for (const r of pulled) {
        log.info(`${style.bold(r.name)}  ${style.dim(r.id)}  ${style.dim(path.relative(process.cwd(), r.dir) || ".")}`);
      }
      if (remoteFlag) {
        const known = new Set(pulled.map((r) => r.id));
        for (const wf of await api.listWorkflows()) {
          if (known.has(wf.id)) continue;
          log.info(`${style.bold(wf.name)}  ${style.dim(wf.id)}  ${style.dim("(not pulled)")}`);
        }
      } else if (pulled.length === 0) {
        log.info(`no pulled workflows under ${config.root} — try: n8n-decanter list --remote`);
      }
      break;
    }
    case "check": {
      const dirs = refs.length > 0
        ? refs.map((id) => {
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
        if (errors.length === 0) log.ok(`${name}: OK`);
        errorCount += errors.length;
      }
      if (!noTypecheck) {
        try {
          // explicit ids scope the typecheck output too; bare `check` stays project-wide
          await runTypecheck(config.configDir, log, refs.length > 0 ? dirs : undefined);
        } catch (err) {
          log.error((err as Error).message);
          errorCount++;
        }
      }
      if (errorCount > 0) process.exitCode = 1;
      break;
    }
    case "executions": {
      // grammar: "clean" may sit anywhere (like the verb itself); a purely
      // numeric argument is an execution id (n8n execution ids are integers,
      // workflow ids are 16-char alphanumeric tokens) — everything else is a
      // workflow ref. A workflow literally named "clean" or like a number
      // must be addressed by id, same rule as verb-named workflows.
      const params = rest.filter((a) => a !== "clean");
      const wfIds: string[] = [];
      for (const r of params.filter((a) => !/^\d+$/.test(a))) wfIds.push(await resolveRef(r));
      if (rest.includes("clean")) {
        cleanExecutions(config.root, wfIds, log);
        break;
      }
      const limitRaw = valueFlags.get("limit");
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 250)) {
        throw new Error("--limit must be an integer between 1 and 250 (the executions API page cap)");
      }
      const status = valueFlags.get("status");
      const execIds = params.filter((a) => /^\d+$/.test(a));
      if (execIds.length === 0 && wfIds.length === 0) {
        if (config.workflows.length === 0) {
          throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
        }
        wfIds.push(...config.workflows);
      }
      let failed = false;
      const attempt = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          failed = true;
          log.error(`${label}: ${(err as Error).message}`);
        }
      };
      for (const e of execIds) await attempt(`execution ${e}`, () => fetchExecutionById(api, config.root, e, log));
      for (const id of wfIds) await attempt(id, () => fetchExecutions(api, config.root, id, { status, limit }, log));
      if (failed) process.exitCode = 1;
      break;
    }
    case "rename": {
      const [id, ...names] = refs;
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
      // the returned handle exists for tests; the CLI watches until Ctrl-C
      await watchWorkflow(api, config, ids[0], { force }, log);
      await new Promise(() => {});
      break;
    }
    default:
      console.log(usage());
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((err) => {
  // DEBUG=1 surfaces the stack — the one-line default hides exactly the
  // context needed when an unexpected TypeError escapes
  log.error(process.env.DEBUG ? err.stack ?? String(err) : err.message);
  process.exitCode = 1;
});
