#!/usr/bin/env node
import path from "node:path";
import { addCodeNode } from "./lib/add.mts";
import { N8nApi } from "./lib/api.mts";
import { loadConfig } from "./lib/config.mts";
import { DEFAULT_N8N_VERSION, dockerAvailable } from "./lib/engine.mts";
import { cleanExecutions, fetchExecutionById, fetchExecutions, latestCaptureId } from "./lib/executions.mts";
import { init, printBanner } from "./lib/init.mts";
import { pinFixtures, runSimulation, type SimulationReport } from "./lib/simulate.mts";
import { createWorkflow, deleteWorkflow, duplicateWorkflow, publishWorkflow, unpublishWorkflow } from "./lib/lifecycle.mts";
import { mergeRemote, runPicker, type PickerResume } from "./lib/picker.mts";
import { pullWorkflow } from "./lib/pull.mts";
import { pushWorkflow } from "./lib/push.mts";
import { renameNode, renameWorkflow } from "./lib/rename.mts";
import { runNode } from "./lib/run.mts";
import { findWorkflowDir, listWorkflowDirs, listWorkflowRefs, looksLikeWorkflowId, matchWorkflowRef } from "./lib/state.mts";
import { statusWorkflow } from "./lib/status.mts";
import { style, styleErr, transientLine } from "./lib/style.mts";
import type { DecanterConfig, Log } from "./lib/types.mts";
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
  ${b("n8n-decanter")}                       ${d("interactive picker (TTY, inited project):")}
                                   ${d("choose a workflow, then verbs — stays in")}
                                   ${d("the workflow's menu until Esc")}
  ${b("n8n-decanter init")} [dir] [--force]   ${d("interactive setup: .env, starter files, config")}
                                   ${d("(re-init refreshes unedited template files, keeps")}
                                   ${d("your edits; --force overwrites everything)")}
  ${b("n8n-decanter")} [ref...] ${b("pull")}       ${d("pull workflows (default: all in decanter.config.json)")}
  ${b("n8n-decanter")} [ref...] ${b("push")} [--force] [--no-typecheck]
  ${b("n8n-decanter")} [ref...] ${b("status")} [--diff]   ${d("drift report (--diff shows line diffs);")}
                                   ${d("exits 1 on conflict/remote drift")}
  ${b("n8n-decanter")} [ref...] ${b("check")} [--no-typecheck]   ${d("offline layout-compliance check")}
  ${b("n8n-decanter")} <ref> ${b("rename")} "<old node>" "<new node>"   ${d("rename a node everywhere (offline)")}
  ${b("n8n-decanter")} <ref> ${b("rename")} --workflow "<new name>"     ${d("rename the workflow itself")}
  ${b("n8n-decanter")} <ref> ${b("add")} "<Node name>" [--ts]   ${d("scaffold a disconnected Code node (offline)")}
  ${b("n8n-decanter")} <ref> ${b("duplicate")} ["<new name>"]   ${d("clone a workflow into a new remote one, then pull it")}
  ${b("n8n-decanter")} [ref...] ${b("publish")}     ${d("take the draft(s) live (unpublish returns to draft-only)")}
  ${b("n8n-decanter")} [ref...] ${b("unpublish")}
  ${b("n8n-decanter create")} "<name>"     ${d("create a blank workflow on the server, then pull it")}
  ${b("n8n-decanter")} <ref> ${b("delete")} [--force]   ${d("delete a workflow from the server (y/N confirm;")}
                                   ${d("--force skips it; the local folder is left untouched)")}
  ${b("n8n-decanter")} [ref] ${b("watch")} [--force]   ${d("watch code/ + workflow.json, push on save")}
                                   ${d("(starts with a safety commit + pull; structural")}
                                   ${d("conflicts prompt; browser live-reload optional)")}
  ${b("n8n-decanter")} [ref...] ${b("executions")} [--status=success|error|waiting] [--limit=N]
                                   ${d("fetch recent execution data (real run JSON) into")}
                                   ${d("workflows/<Name>/executions/ — gitignored temp files;")}
                                   ${d("a numeric argument fetches that one execution by id")}
  ${b("n8n-decanter")} [ref...] ${b("executions clean")}   ${d("delete fetched execution data (offline)")}
  ${b("n8n-decanter")} <ref> ${b("simulate")} --execution <id> [--network-none] [--json]
                                   ${d("replay the workflow through a real n8n engine (Docker):")}
                                   ${d("pure nodes run for real, network nodes pinned from the")}
                                   ${d("capture, credentials stripped; exits 1 on divergence")}
  ${b("n8n-decanter")} <ref> ${b("simulate")} --pin <id>   ${d("save a capture's network outputs as committed fixtures/")}
  ${b("n8n-decanter list")} [--remote]      ${d("pulled workflows: name, id, folder")}
                                   ${d("(--remote adds workflows not pulled yet)")}
  ${b("n8n-decanter completion")} zsh|bash  ${d("print a shell completion script for your rc file")}
  ${b("n8n-decanter")} <node-file> ${b("run")} [fixture.json] [--allow-env]   ${d("run a node locally (offline;")}
                                   ${d("$env is empty unless the fixture sets env or --allow-env inherits process.env)")}

A workflow <ref> is its id, its workflow/folder name, or a unique name prefix
(case-insensitive; ambiguity is an error, never a prompt). A workflow named
like a verb must be addressed by id. The verb may sit anywhere among the
arguments: "n8n-decanter push wf123" is the same as "n8n-decanter wf123 push",
and flags may appear in any position too.

Config: decanter.config.json (searched upward from cwd), credentials from .env
next to it or the environment (N8N_HOST, N8N_API_KEY).`;
};

const VERBS = new Set(["init", "pull", "push", "status", "check", "rename", "add", "duplicate", "watch", "run", "list", "executions", "simulate", "publish", "unpublish", "create", "delete", "completion", "__complete", "help"]);
/** Verbs whose workflow arguments go through name resolution. */
const REF_VERBS = new Set(["pull", "push", "status", "check", "watch", "simulate", "publish", "unpublish", "delete"]);

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
      const m = raw[i].match(/^--(status|limit|execution|pin|n8n-version)(?:=(.*))?$/);
      if (!m) {
        args.push(raw[i]);
        continue;
      }
      const value = m[2] ?? raw[++i];
      if (value === undefined || value === "") throw new Error(`--${m[1]} needs a value (e.g. --${m[1]}=${m[1] === "limit" ? "5" : m[1] === "status" ? "success" : "123"})`);
      valueFlags.set(m[1], value);
    }
  }
  const force = args.includes("--force");
  const noTypecheck = args.includes("--no-typecheck");
  const allowEnv = args.includes("--allow-env");
  const workflowFlag = args.includes("--workflow");
  const remoteFlag = args.includes("--remote");
  const diffFlag = args.includes("--diff");
  const tsFlag = args.includes("--ts");
  const jsonFlag = args.includes("--json");
  const networkNoneFlag = args.includes("--network-none");
  const positional = args.filter((a) => !a.startsWith("--"));
  // id-first support: the first token matching a known verb is the command,
  // wherever it sits — `push wf123` and `wf123 push` are equivalent.
  const verbIndex = positional.findIndex((a) => VERBS.has(a));
  const command = verbIndex === -1 ? positional[0] : positional[verbIndex];
  const rest = positional.filter((_, i) => i !== verbIndex);

  // Bare invocation on a TTY in an inited project → interactive picker
  // (Plan 19). Piped runs and config-less directories fall through to
  // usage() unchanged — scripts and LLM harnesses never see the picker.
  if (command === undefined && args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    let pickerConfig;
    try {
      pickerConfig = loadConfig(process.cwd(), { requireCredentials: false });
    } catch {
      // no decanter.config.json in reach — bare invocation stays usage()
    }
    if (pickerConfig !== undefined) {
      await pickerLoop(pickerConfig);
      return;
    }
  }

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
  if (command === "run") {
    if (rest.length < 1) throw new Error("run needs a node file argument: n8n-decanter run <node-file> [fixture.json]");
    await runNode(rest[0], rest[1], log, { allowEnv });
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
    words.push("--force", "--no-typecheck", "--workflow", "--remote", "--diff", "--ts", "--status=", "--limit=", "--allow-env", "--execution=", "--pin=", "--json", "--network-none", "--n8n-version=", "--help");
    try {
      const config = loadConfig(process.cwd(), { requireCredentials: false });
      for (const ref of listWorkflowRefs(config.root)) words.push(...ref.names, ref.id);
    } catch {
      // no decanter.config.json in reach — verbs and flags still complete
    }
    console.log([...new Set(words)].join("\n"));
    return;
  }

  await dispatch(command, rest, { force, noTypecheck, workflowFlag, remoteFlag, diffFlag, tsFlag, jsonFlag, networkNoneFlag, valueFlags });
}

interface Flags {
  force: boolean;
  noTypecheck: boolean;
  workflowFlag: boolean;
  remoteFlag: boolean;
  diffFlag: boolean;
  tsFlag: boolean;
  jsonFlag: boolean;
  networkNoneFlag: boolean;
  valueFlags: Map<string, string>;
}

/** Flag defaults for picker-launched verbs (no CLI flags in play). */
const PICKER_FLAGS: Flags = { force: false, noTypecheck: false, workflowFlag: false, remoteFlag: false, diffFlag: false, tsFlag: false, jsonFlag: false, networkNoneFlag: false, valueFlags: new Map() };

/**
 * Interactive session (Plan 19 + loop follow-up): banner, then pick → run →
 * back in the same workflow's verb menu until Esc (workflow list, then quit)
 * or Ctrl-C. The remote list is fetched once and cached across iterations; a
 * verb error is logged and returns to the menu instead of ending the session.
 * The process exit code reflects the last verb run.
 */
async function pickerLoop(config: DecanterConfig): Promise<void> {
  printBanner(log);
  let remoteCache: Array<{ id: string; name: string }> | undefined;
  let remoteNotice: string | undefined;
  let remotePending: Promise<Array<{ id: string; name: string }>> | undefined =
    config.host !== "" && config.apiKey !== ""
      ? new N8nApi(config).listWorkflows().then((ws) => ws.map((w) => ({ id: w.id, name: w.name })))
      : undefined;
  remotePending?.then((ws) => {
    remoteCache = ws;
    remotePending = undefined;
  }).catch((err: Error) => {
    remoteNotice = `remote list unavailable (${err.message.split("\n")[0]})`;
    remotePending = undefined;
  });
  let resume: PickerResume | undefined;
  for (;;) {
    // re-listed each round: a pull just added a folder (or renamed one)
    const local = listWorkflowRefs(config.root, log).map((r) => ({ id: r.id, name: r.name, pulled: true }));
    const entries = remoteCache !== undefined ? mergeRemote(local, remoteCache) : local;
    const picked = await runPicker(entries, remotePending, { resume, notice: remoteNotice });
    if (picked === "quit") return;
    if (picked === "interrupted") {
      process.exitCode = 130;
      return;
    }
    log.info(style.dim(`❯ ${picked.verb} ${picked.name}`));
    process.exitCode = 0;
    try {
      await dispatch(picked.verb, [picked.id], PICKER_FLAGS);
    } catch (err) {
      process.exitCode = 1;
      log.error((err as Error).message);
    }
    console.log("");
    resume = { id: picked.id, verb: picked.verb };
  }
}

/** Human-readable `simulate` report: per-node diff lines + a pass/fail summary. */
function printSimulationReport(r: SimulationReport, log: Log): void {
  log.info(`replayed execution ${r.execId} on n8n ${r.version}${r.networkNone ? " (network: none)" : ""} — ${r.pure.length} node(s) real, ${r.pinned.length} pinned${r.loops.length > 0 ? `, ${r.loops.length} loop driver(s) run (single-iteration)` : ""}`);
  if (!r.engineOk) log.error(`engine run failed: ${r.engineError ?? "unknown error"}`);
  for (const d of r.diffs) {
    if (d.equal) log.ok(`${d.node}: matches capture`);
    else {
      log.error(`${d.node}: diverged from capture`);
      log.info(style.dim(`    expected ${JSON.stringify(d.expected)}`));
      log.info(style.dim(`    actual   ${JSON.stringify(d.actual)}`));
    }
  }
  if (r.ok) log.ok(`simulation matches the capture (${r.diffs.length} node${r.diffs.length === 1 ? "" : "s"} checked)`);
  else log.error(`simulation diverged: ${r.divergent.length > 0 ? r.divergent.join(", ") : "engine error"}`);
  if (r.url && r.login) {
    log.info(`\nopen the run in n8n:  ${style.bold(r.url)}`);
    log.info(style.dim(`  local login: ${r.login.email} / ${r.login.password}  ·  throwaway instance, replaced on the next simulate (docker rm -f decanter-sim-viewer to stop)`));
  }
}

/** Config-needing verbs: load config, resolve refs, run the verb switch. */
async function dispatch(command: string, rest: string[], flags: Flags): Promise<void> {
  const { force, noTypecheck, workflowFlag, remoteFlag, diffFlag, tsFlag, jsonFlag, networkNoneFlag, valueFlags } = flags;
  // simulate reads local captures + drives a throwaway engine — it never calls
  // the n8n API, so no credentials are required.
  const offline = command === "check" || command === "rename" || command === "add" || command === "simulate"
    || (command === "list" && !remoteFlag)
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
  } else if ((command === "rename" || command === "add" || command === "duplicate") && rest.length > 0) {
    // ref-plus-literals verbs: only the first argument is a workflow ref;
    // the rest are names (node names, a new workflow name) — not resolved.
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
    case "simulate": {
      if (refs.length !== 1) throw new Error("simulate needs exactly one workflow ref: n8n-decanter <ref> simulate --execution <id>");
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      const pinId = valueFlags.get("pin");
      if (pinId !== undefined) {
        pinFixtures(dir, pinId, log);
        break;
      }
      // No --execution → default to the newest local capture (also how the
      // picker, which can't supply an id, runs simulate).
      const execId = valueFlags.get("execution") ?? latestCaptureId(dir) ?? undefined;
      if (execId === undefined) throw new Error(`no execution to simulate: pass --execution <id> or fetch one first with \`n8n-decanter ${refs[0]} executions\``);
      if (valueFlags.get("execution") === undefined) log.info(style.dim(`no --execution given; using the latest capture ${execId}`));
      if (!(await dockerAvailable())) {
        throw new Error("simulate needs a running Docker daemon (the engine backend) — start Docker and retry");
      }
      const version = valueFlags.get("n8n-version") ?? config.n8nVersion ?? DEFAULT_N8N_VERSION;
      if (valueFlags.get("n8n-version") === undefined && config.n8nVersion === undefined) {
        log.info(style.dim(`using default engine version ${version}; pin "n8nVersion" in decanter.config.json to match your instance`));
      }
      // Interactive terminals get a browsable run in a kept-alive local n8n;
      // scripts/CI/--json/--network-none stay fast and headless (no container left).
      const viewer = Boolean(process.stdout.isTTY) && !jsonFlag && !networkNoneFlag;
      const report = await runSimulation(dir, execId, { version, networkNone: networkNoneFlag, viewer }, log);
      if (jsonFlag) console.log(JSON.stringify(report, null, 2));
      else printSimulationReport(report, log);
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case "publish":
    case "unpublish": {
      if (ids.length === 0) {
        throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
      }
      let failed = false;
      for (const id of ids) {
        try {
          if (command === "publish") await publishWorkflow(api, id, log);
          else await unpublishWorkflow(api, id, log);
        } catch (err) {
          failed = true;
          log.error(`${id}: ${(err as Error).message}`);
        }
      }
      if (failed) process.exitCode = 1;
      break;
    }
    case "create": {
      if (rest.length !== 1) throw new Error('create needs exactly one name: n8n-decanter create "<name>"');
      await createWorkflow(api, config, rest[0], log);
      break;
    }
    case "delete": {
      // Deliberately never falls back to config.workflows — a ref is required,
      // one workflow per call (no cascade, too much blast radius for a default).
      if (refs.length === 0) throw new Error("delete needs a workflow ref: n8n-decanter <ref> delete");
      if (refs.length > 1) throw new Error("delete takes exactly one workflow — delete them one at a time");
      await deleteWorkflow(api, config, refs[0], { force }, log);
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
    case "add": {
      const [id, ...names] = refs;
      if (!id) throw new Error('add needs a workflow ref and a node name: n8n-decanter <ref> add "<Node name>" [--ts]');
      if (names.length !== 1) throw new Error('add needs exactly one node name: n8n-decanter <ref> add "<Node name>" [--ts]');
      addCodeNode(config.root, id, names[0], { ts: tsFlag }, log);
      break;
    }
    case "duplicate": {
      const [id, ...names] = refs;
      if (!id) throw new Error('duplicate needs a workflow ref: n8n-decanter <ref> duplicate ["<new name>"]');
      if (names.length > 1) throw new Error('duplicate takes at most one new name: n8n-decanter <ref> duplicate ["<new name>"]');
      await duplicateWorkflow(api, config, id, names[0], log);
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
