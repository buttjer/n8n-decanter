#!/usr/bin/env node
import path from "node:path";
import { addCodeNode } from "./lib/add.mts";
import { N8nApi } from "./lib/api.mts";
import { loadConfig, requireApiKey } from "./lib/config.mts";
import { cleanDataTables, fetchDataTables } from "./lib/datatables.mts";
import { DEFAULT_N8N_VERSION, dockerAvailable } from "./lib/engine.mts";
import { cleanExecutions, fetchExecutionById, fetchExecutions, latestCaptureId } from "./lib/executions.mts";
import { init, printBanner } from "./lib/init.mts";
import { checkMocks, listMockSlugs, pinFixtures, runSimulation, writeMock, type SimulationReport } from "./lib/simulate.mts";
import { createWorkflow, deleteWorkflow, duplicateWorkflow, publishWorkflow, unpublishWorkflow } from "./lib/lifecycle.mts";
import { createMcpClient, ENABLE_MCP_HINT, isUnavailableInMcp, type McpClient, searchWorkflows } from "./lib/mcp.mts";
import { ENABLE_MCP_VERB, mergeRemote, runPicker, type PickerResume } from "./lib/picker.mts";
import { pullWorkflow } from "./lib/pull.mts";
import { pushWorkflow } from "./lib/push.mts";
import { renameNode, renameWorkflow } from "./lib/rename.mts";
import { runNode } from "./lib/run.mts";
import { findWorkflowDir, listWorkflowDirs, listWorkflowRefs, looksLikeWorkflowId, matchWorkflowRef, readState } from "./lib/state.mts";
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
  return `Usage: ${b("n8n-decanter")} <verb> [workflow…] [flags]
  ${d("Run with no arguments in a terminal for the interactive picker; `help` prints this.")}

${b("Setup")}
  ${b("init")} [dir] [--force]                    ${d("interactive setup: .env, starter files, config")}
  ${b("completion")} zsh|bash                     ${d("print a shell completion script for your rc file")}

${b("Sync")} ${d("(over n8n's MCP server — Code-node source only; structure lives in n8n)")}
  ${b("pull")} [workflow…]                        ${d("pull code into workflows/<kebab>/ (default: config list)")}
  ${b("push")} [workflow…] [--force] [--publish] [--no-typecheck]   ${d("push code to the draft (--publish takes it live)")}
  ${b("watch")} [workflow]                        ${d("watch code/, push each save to the draft")}
  ${b("publish")} [workflow…]                     ${d("take the draft(s) live")}
  ${b("unpublish")} [workflow…]                   ${d("return the draft(s) to draft-only")}

${b("Workflow lifecycle")}
  ${b("create")} "<name>"                         ${d("create a blank workflow in n8n, then pull it")}
  ${b("duplicate")} <workflow> ["<name>"]         ${d("clone a workflow into a new one (needs the API key)")}
  ${b("delete")} <workflow> [--force]             ${d("delete a workflow from the server (y/N; needs the API key)")}
  ${b("rename")} <workflow> "<new name>"          ${d("rename the workflow in n8n")}

${b("Inspect & test")}
  ${b("status")} [workflow…] [--diff]             ${d("drift report; exits 1 on conflict/remote drift")}
  ${b("check")} [workflow…] [--no-typecheck]      ${d("offline layout-compliance check")}
  ${b("executions")} [workflow…] [--status=…] [--limit=N]   ${d("fetch execution data (numeric arg = one by id)")}
  ${b("executions")} [workflow…] clean            ${d("delete fetched execution data (offline)")}
  ${b("data-tables")} [table…] [--filter=… --search=… --sort=… --limit=N --all]   ${d("fetch data-table schema + rows (read-only)")}
  ${b("data-tables")} [table…] clean              ${d("delete fetched data-table data (offline)")}
  ${b("simulate")} <workflow> [--execution <execution-id> | --mock <slug>] [--network-none] [--json]
  ${d("                                            replay through a real n8n engine (Docker); exits 1 on divergence")}
  ${b("list")} [--remote] [--json]                ${d("pulled workflows: name, id, folder")}

${b("Mock")} ${d("(fill simulate gaps offline — no engine, no API)")}
  ${b("mock create")} <workflow> ["<slug>"] [--execution <id>]   ${d("promote a capture to a committed, fillable mock scenario")}
  ${b("mock check")} <workflow> ["<slug>"]                       ${d("structurally validate a mock (or all); exits 1 on invalid")}

${b("Node")}
  ${b("node create")} <workflow> "<Node name>" [--ts]        ${d("scaffold a disconnected Code node in n8n")}
  ${b("node rename")} <workflow> "<old node>" "<new node>"   ${d("rename a node in n8n; local files follow")}
  ${b("node run")} <node-file> [fixture.json] [--allow-env]  ${d("run a node locally (offline)")}

A ${b("<workflow>")} is its id, name, unique name-prefix, or folder name (case-insensitive;
ambiguity is an error). A ref verb with no ${b("<workflow>")} on a terminal opens the picker.
An ${b("<execution-id>")} is an n8n execution id (numeric).

Config: decanter.config.json (searched upward from cwd). Credentials: N8N_HOST +
MCP (OAuth via ${b("init")}, or N8N_MCP_TOKEN) power sync; N8N_API_KEY (optional)
powers executions, data-tables, duplicate, and delete.`;
};

// Verb-first grammar (Plan 27): the command is positional[0]. `add`/`run` and
// the node-rename overload moved under the `node` namespace (node create/rename/run).
const VERBS = new Set(["init", "pull", "push", "status", "check", "rename", "duplicate", "watch", "list", "executions", "data-tables", "simulate", "mock", "publish", "unpublish", "create", "delete", "completion", "node", "__complete", "help"]);
/** Sub-verbs of the `node` namespace; dispatched as internal `node:<sub>` commands. */
const NODE_VERBS = new Set(["create", "rename", "run"]);
/** Sub-verbs of the `mock` namespace; dispatched as internal `mock:<sub>` commands. */
const MOCK_VERBS = new Set(["create", "check"]);
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
      const m = raw[i].match(/^--(status|limit|execution|pin|n8n-version|mock|filter|search|sort)(?:=(.*))?$/);
      if (!m) {
        args.push(raw[i]);
        continue;
      }
      const example = m[1] === "limit" ? "5" : m[1] === "status" ? "success" : "123";
      let value = m[2];
      if (value === undefined) {
        // Space-separated form (`--limit 5`): consume the next token — but not
        // if it's another flag or a known verb, so `n8n-decanter --status pull`
        // reports "needs a value" instead of silently eating the `pull` verb.
        const next = raw[i + 1];
        if (next !== undefined && !next.startsWith("-") && !VERBS.has(next)) value = raw[++i];
      }
      if (value === undefined || value === "") throw new Error(`--${m[1]} needs a value (e.g. --${m[1]}=${example})`);
      valueFlags.set(m[1], value);
    }
  }
  const force = args.includes("--force");
  const publishFlag = args.includes("--publish");
  const noTypecheck = args.includes("--no-typecheck");
  const allowEnv = args.includes("--allow-env");
  const remoteFlag = args.includes("--remote");
  const diffFlag = args.includes("--diff");
  const tsFlag = args.includes("--ts");
  const jsonFlag = args.includes("--json");
  const networkNoneFlag = args.includes("--network-none");
  const allFlag = args.includes("--all");
  const positional = args.filter((a) => !a.startsWith("--"));
  // Verb-first grammar (Plan 27): the command is the first positional; flags may
  // still sit anywhere. `node <sub> …` is the one exception — a contained
  // namespace whose real verb is positional[1], dispatched as `node:<sub>`.
  let command = positional[0];
  let rest = positional.slice(1);
  if (command === "node") {
    const sub = positional[1];
    if (sub === undefined || !NODE_VERBS.has(sub)) {
      console.log(usage());
      throw new Error(`unknown node command: ${sub ?? "(none)"} — try: n8n-decanter node create|rename|run`);
    }
    command = `node:${sub}`;
    rest = positional.slice(2);
  } else if (command === "mock") {
    const sub = positional[1];
    if (sub === undefined || !MOCK_VERBS.has(sub)) {
      console.log(usage());
      throw new Error(`unknown mock command: ${sub ?? "(none)"} — try: n8n-decanter mock create|check`);
    }
    command = `mock:${sub}`;
    rest = positional.slice(2);
  }

  // Bare invocation on a TTY in an inited project → interactive picker
  // (Plan 19). Piped runs and config-less directories fall through to
  // usage() unchanged — scripts and LLM harnesses never see the picker.
  if (command === undefined && args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    let pickerConfig: ReturnType<typeof loadConfig> | undefined;
    try {
      pickerConfig = loadConfig(process.cwd(), { requireHost: false });
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

  // Verb-first: slot 0 must be a known verb (a workflow named like a verb is now
  // just an argument, so the old "address it by id" caveat is gone). `node:<sub>`
  // is internal and already validated above.
  if (!command.startsWith("node:") && !command.startsWith("mock:") && !VERBS.has(command)) {
    console.log(usage());
    throw new Error(`unknown verb: ${command}`);
  }

  if (command === "init") {
    // must run before loadConfig: a fresh directory has no config/.env yet
    if (rest.length > 1) throw new Error("init takes at most one directory argument");
    await init(rest[0], { force }, log);
    return;
  }

  // Offline, config-free verbs — no decanter.config.json or credentials needed.
  if (command === "node:run") {
    if (rest.length < 1) throw new Error("node run needs a node file argument: n8n-decanter node run <node-file> [fixture.json]");
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
    words.push(...NODE_VERBS, ...MOCK_VERBS); // sub-verbs after `node` / `mock`
    words.push("--force", "--publish", "--no-typecheck", "--remote", "--diff", "--ts", "--status=", "--limit=", "--allow-env", "--execution=", "--pin=", "--mock=", "--json", "--network-none", "--n8n-version=", "--filter=", "--search=", "--sort=", "--all", "--help");
    try {
      const config = loadConfig(process.cwd(), { requireHost: false });
      for (const ref of listWorkflowRefs(config.root)) words.push(...ref.names, ref.id);
    } catch {
      // no decanter.config.json in reach — verbs and flags still complete
    }
    console.log([...new Set(words)].join("\n"));
    return;
  }

  await dispatch(command, rest, { force, publishFlag, noTypecheck, remoteFlag, diffFlag, tsFlag, jsonFlag, networkNoneFlag, allFlag, valueFlags });
}

interface Flags {
  force: boolean;
  publishFlag: boolean;
  noTypecheck: boolean;
  remoteFlag: boolean;
  diffFlag: boolean;
  tsFlag: boolean;
  jsonFlag: boolean;
  networkNoneFlag: boolean;
  allFlag: boolean;
  valueFlags: Map<string, string>;
}

/** Flag defaults for picker-launched verbs (no CLI flags in play). */
const PICKER_FLAGS: Flags = { force: false, publishFlag: false, noTypecheck: false, remoteFlag: false, diffFlag: false, tsFlag: false, jsonFlag: false, networkNoneFlag: false, allFlag: false, valueFlags: new Map() };

/**
 * Interactive session (Plan 19 + loop follow-up): banner, then pick → run →
 * back in the same workflow's verb menu until Esc (workflow list, then quit)
 * or Ctrl-C. The remote list comes over MCP (`search_workflows` sees every
 * workflow; the `availableInMCP` flag feeds the third picker state, Plan 32),
 * fetched once and cached across iterations; a verb error is logged and
 * returns to the menu instead of ending the session. The process exit code
 * reflects the last verb run.
 */
async function pickerLoop(config: DecanterConfig): Promise<void> {
  printBanner(log);
  let remoteCache: Array<{ id: string; name: string; available: boolean }> | undefined;
  let remoteNotice: string | undefined;
  let remotePending: Promise<Array<{ id: string; name: string; available: boolean }>> | undefined;
  try {
    const mcp = createMcpClient(config);
    remotePending = searchWorkflows(mcp).then((ws) => ws.map((w) => ({ id: w.id, name: w.name ?? w.id, available: w.availableInMCP })));
  } catch (err) {
    remoteNotice = `remote list unavailable (${(err as Error).message.split("\n")[0]})`;
  }
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
    const local = listWorkflowRefs(config.root, log).map((r) => ({ id: r.id, name: r.name, pulled: true, available: true }));
    const entries = remoteCache !== undefined ? mergeRemote(local, remoteCache) : local;
    const picked = await runPicker(entries, remotePending, { resume, notice: remoteNotice });
    if (picked === "quit") return;
    if (picked === "interrupted") {
      process.exitCode = 130;
      return;
    }
    if (picked.verb === ENABLE_MCP_VERB) {
      // an MCP-unavailable workflow: guidance instead of a verb (Plan 32)
      log.warn(`"${picked.name}" is not available in MCP — ${ENABLE_MCP_HINT}`);
      console.log("");
      resume = undefined;
      continue;
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

/** True when the interactive picker can run — both stdin and stdout are TTYs. */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * No-ref → picker (Plan 27): pick a single pulled workflow for an already-known
 * verb (the verb menu is skipped). Returns the chosen id, or undefined when
 * nothing is pulled or the user quits — the caller then falls through to the
 * config default / error path exactly as a piped run would.
 */
async function pickOneWorkflow(config: DecanterConfig, verb: string, log: Log): Promise<string | undefined> {
  const local = listWorkflowRefs(config.root, log).map((r) => ({ id: r.id, name: r.name, pulled: true, available: true }));
  if (local.length === 0) return undefined;
  const picked = await runPicker(local, undefined, { selectVerb: verb });
  if (picked === "quit" || picked === "interrupted") return undefined;
  log.info(style.dim(`❯ ${verb} ${picked.name}`));
  return picked.id;
}

/** Human-readable `simulate` report: per-node diff lines + a pass/fail summary. */
function printSimulationReport(r: SimulationReport, log: Log): void {
  // Tier-2 (viewer-only): a best-effort iteration 1 of a multi-batch loop. There
  // is no diff and it is NOT a pass/fail check — say so plainly, show the viewer.
  if (r.bestEffortLoop) {
    log.warn(`multi-batch loop: showing iteration 1 of ${r.loopIterations ?? "N"} only — a browsable preview, NOT a pass/fail check (multi-batch loops can't be gated; pinning is single-valued)`);
    if (r.url && r.login) {
      log.info(`\nopen the run in n8n:  ${style.bold(r.url)}`);
      log.info(style.dim(`  local login: ${r.login.email} / ${r.login.password}  ·  throwaway instance, replaced on the next simulate (docker rm -f decanter-sim-viewer to stop)`));
    } else {
      log.warn("the browsable viewer did not start — nothing to show for this multi-batch loop preview");
    }
    return;
  }
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
  const { force, publishFlag, noTypecheck, remoteFlag, diffFlag, tsFlag, jsonFlag, networkNoneFlag, allFlag, valueFlags } = flags;
  // simulate reads local captures + drives a throwaway engine — it never calls
  // n8n, so no credentials are required. Since Plan 32 the sync verbs (and the
  // rename/node namespace, which forward structure acts to n8n) go over MCP;
  // only executions/data-tables fetches, duplicate, and delete still use the
  // REST API (requireApiKey at the verb).
  const offline = command === "check" || command === "simulate"
    || command === "mock:create" || command === "mock:check"
    || (command === "list" && !remoteFlag)
    || (command === "executions" && rest.includes("clean"))
    || (command === "data-tables" && rest.includes("clean"));
  const config = loadConfig(process.cwd(), { requireHost: !offline });
  /** REST client for the API-only verbs — guarded so the error names the verb. */
  const api = (verb: string): N8nApi => new N8nApi(requireApiKey(config, verb));
  /** MCP client (the sync backend) — created lazily so offline verbs never need credentials. */
  let mcpClient: McpClient | undefined;
  const mcp = (): McpClient => {
    mcpClient ??= createMcpClient(config, log);
    return mcpClient;
  };

  /**
   * Workflow-name arguments: resolve a ref locally (id → name → unique
   * prefix); `pull` falls back to the remote workflow list (MCP
   * `search_workflows` — it lists every workflow, opted-in or not) for
   * not-yet-pulled names. An id-shaped ref that matches nothing passes
   * through unchanged — it may exist only remotely (pull/status by fresh id
   * must keep working).
   */
  const resolveRef = async (ref: string): Promise<string> => {
    const local = matchWorkflowRef(listWorkflowRefs(config.root, log), ref);
    if (local) return local.id;
    if (command === "pull") {
      try {
        const remote = await searchWorkflows(mcp());
        const hit = matchWorkflowRef(remote.map((w) => ({ id: w.id, names: [w.name ?? ""] })), ref);
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
  } else if ((command === "rename" || command === "node:create" || command === "node:rename" || command === "duplicate"
      || command === "mock:create" || command === "mock:check") && rest.length > 0) {
    // ref-plus-literals verbs: only the first argument is a workflow ref;
    // the rest are names (node names, a new workflow name, a mock slug) — not resolved.
    refs = [await resolveRef(rest[0]), ...rest.slice(1)];
  }
  // No-ref → picker (Plan 27): a pure ref verb with no workflow, on a terminal,
  // picks one; piped/non-TTY falls through to the config default / error below.
  if (refs.length === 0 && REF_VERBS.has(command) && interactive()) {
    const picked = await pickOneWorkflow(config, command, log);
    if (picked !== undefined) refs = [picked];
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
            const { name, dir } = await pullWorkflow(mcp(), config.root, id, { commitOnPull: config.commitOnPull }, plog);
            plog.ok(`pulled "${name}" -> ${dir}${dur()}`);
          } else if (command === "push") {
            transient.show(`${prefix}pushing ${id}…`);
            await pushWorkflow(mcp(), config.root, id, { force, commitOnPush: config.commitOnPush, publish: publishFlag }, { ...plog, ok: (m) => plog.ok(m + dur()) });
          } else {
            const { remoteDrift } = await statusWorkflow(mcp(), config.root, id, plog, { diff: diffFlag });
            drifted ||= remoteDrift;
          }
        } catch (err) {
          failed = true;
          plog.error(`${id}: ${(err as Error).message}`);
          // the per-workflow MCP gate: point at the n8n-side switch
          if (isUnavailableInMcp(err)) plog.info(`  ${ENABLE_MCP_HINT}`);
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
      const known = new Set(pulled.map((r) => r.id));
      // --remote lists over MCP: search_workflows sees EVERY workflow, but only
      // availableInMCP ones are pullable — the rest get the enable guidance.
      const remote = remoteFlag ? (await searchWorkflows(mcp())).filter((w) => !known.has(w.id)) : [];
      if (jsonFlag) {
        // agent-friendly: pulled workflows carry a dir; remote-only ones dir: null
        const rows: Array<{ name: string; id: string; dir: string | null; mcpAvailable?: boolean }> = [
          ...pulled.map((r) => ({ name: r.name, id: r.id, dir: path.relative(process.cwd(), r.dir) || "." })),
          ...remote.map((w) => ({ name: w.name ?? w.id, id: w.id, dir: null, mcpAvailable: w.availableInMCP })),
        ];
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      for (const r of pulled) {
        log.info(`${style.bold(r.name)}  ${style.dim(r.id)}  ${style.dim(path.relative(process.cwd(), r.dir) || ".")}`);
      }
      if (remoteFlag) {
        for (const wf of remote.filter((w) => w.availableInMCP)) {
          log.info(`${style.bold(wf.name ?? wf.id)}  ${style.dim(wf.id)}  ${style.dim("(not pulled)")}`);
        }
        const unavailable = remote.filter((w) => !w.availableInMCP);
        for (const wf of unavailable) {
          log.info(`${style.bold(wf.name ?? wf.id)}  ${style.dim(wf.id)}  ${style.dim("(not available in MCP)")}`);
        }
        if (unavailable.length > 0) {
          log.info(style.dim(`to pull a "(not available in MCP)" workflow: ${ENABLE_MCP_HINT}`));
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
        // label by the cached display name (Plan 27) so a kebab folder still
        // reads as the workflow; fall back to the folder if state is missing/corrupt
        let name = path.basename(dir);
        try {
          name = readState(dir)?.name ?? name;
        } catch {
          // corrupt state — validateWorkflowDir surfaces the error; keep the folder label
        }
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
        // executions isn't in REF_VERBS (it also takes a numeric <execution-id>
        // and `clean`), so it gets its own no-ref → picker hook.
        const picked = interactive() ? await pickOneWorkflow(config, "executions", log) : undefined;
        if (picked !== undefined) {
          wfIds.push(picked);
        } else if (config.workflows.length === 0) {
          throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
        } else {
          wfIds.push(...config.workflows);
        }
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
      const execApi = api("executions");
      for (const e of execIds) await attempt(`execution ${e}`, () => fetchExecutionById(execApi, config.root, e, log));
      for (const id of wfIds) await attempt(id, () => fetchExecutions(execApi, config.root, id, { status, limit }, log));
      if (failed) process.exitCode = 1;
      break;
    }
    case "data-tables": {
      // grammar mirrors executions: "clean" may sit anywhere; every other
      // positional is a data-table ref (id or exact name). Data tables are
      // project-scoped, not per-workflow, so refs are NOT workflow refs and
      // land here unresolved — fetchDataTables matches them against the table
      // list. clean is offline; the fetch is online and config-gated.
      const tableRefs = rest.filter((a) => a !== "clean");
      if (rest.includes("clean")) {
        cleanDataTables(config.configDir, log);
        break;
      }
      if (!config.dataTables) {
        throw new Error('data-table reads are disabled — set "dataTables": true in decanter.config.json to enable them');
      }
      const limitRaw = valueFlags.get("limit");
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 250)) {
        throw new Error("--limit must be an integer between 1 and 250 (the data-table rows API page cap)");
      }
      await fetchDataTables(api("data-tables"), config.configDir, {
        tableRefs,
        limit,
        filter: valueFlags.get("filter"),
        search: valueFlags.get("search"),
        sortBy: valueFlags.get("sort"),
        all: allFlag,
      }, log);
      break;
    }
    case "simulate": {
      if (refs.length !== 1) throw new Error("simulate needs exactly one workflow ref: n8n-decanter <ref> simulate [--execution <id> | --mock <slug>]");
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      const pinId = valueFlags.get("pin");
      if (pinId !== undefined) {
        pinFixtures(dir, pinId, log);
        break;
      }
      // Replay source: an explicit committed mock scenario (--mock <slug>) or a
      // raw capture (--execution <id>, defaulting to the newest). Mutually exclusive.
      const mockSlug = valueFlags.get("mock");
      if (mockSlug !== undefined && valueFlags.get("execution") !== undefined) {
        throw new Error("pass either --mock <slug> or --execution <id>, not both");
      }
      const source = mockSlug !== undefined ? "mock" : "capture";
      const ref = mockSlug ?? valueFlags.get("execution") ?? latestCaptureId(dir) ?? undefined;
      if (ref === undefined) throw new Error(`no execution to simulate: pass --execution <id> (or --mock <slug>), or fetch one with \`n8n-decanter ${refs[0]} executions\``);
      if (source === "capture" && valueFlags.get("execution") === undefined) log.info(style.dim(`no --execution/--mock given; using the latest capture ${ref}`));
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
      const report = await runSimulation(dir, ref, { version, source, networkNone: networkNoneFlag, viewer }, log);
      if (jsonFlag) console.log(JSON.stringify(report, null, 2));
      else printSimulationReport(report, log);
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case "mock:create": {
      if (refs.length < 1) throw new Error('mock create needs a workflow ref: n8n-decanter mock create <workflow> ["<slug>"] [--execution <id>]');
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      // No --execution → newest local capture (offline: reads a capture, writes a
      // committed mocks/<slug>.json; no engine, no API). Slug (positional) defaults to id.
      const execId = valueFlags.get("execution") ?? latestCaptureId(dir) ?? undefined;
      if (execId === undefined) throw new Error(`no execution to mock: pass --execution <id> or fetch one first with \`n8n-decanter ${refs[0]} executions\``);
      if (valueFlags.get("execution") === undefined) log.info(style.dim(`no --execution given; using the latest capture ${execId}`));
      const slug = refs[1] ?? execId;
      const result = await writeMock(dir, execId, slug, log);
      if (jsonFlag) console.log(JSON.stringify({ slug: result.slug, file: path.relative(process.cwd(), result.file), gaps: result.gaps }, null, 2));
      break;
    }
    case "mock:check": {
      if (refs.length < 1) throw new Error('mock check needs a workflow ref: n8n-decanter mock check <workflow> ["<slug>"]');
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      const slug = refs[1];
      if (jsonFlag) {
        const slugs = slug !== undefined ? [slug] : listMockSlugs(dir);
        const results = slugs.map((s) => {
          const silent: Log = { info() {}, ok() {}, warn() {}, error() {} };
          const invalid = checkMocks(dir, s, silent);
          return { slug: s, valid: invalid === 0 };
        });
        console.log(JSON.stringify(results, null, 2));
        if (results.some((r) => !r.valid)) process.exitCode = 1;
        break;
      }
      const invalid = checkMocks(dir, slug, log);
      if (invalid > 0) process.exitCode = 1;
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
          if (command === "publish") await publishWorkflow(mcp(), id, log);
          else await unpublishWorkflow(mcp(), id, log);
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
      await createWorkflow(mcp(), config, rest[0], log);
      break;
    }
    case "delete": {
      // Deliberately never falls back to config.workflows — a ref is required,
      // one workflow per call (no cascade, too much blast radius for a default).
      if (refs.length === 0) throw new Error("delete needs a workflow ref: n8n-decanter <ref> delete");
      if (refs.length > 1) throw new Error("delete takes exactly one workflow — delete them one at a time");
      await deleteWorkflow(api("delete"), config, refs[0], { force }, log);
      break;
    }
    case "rename": {
      const [id, ...names] = refs;
      if (!id) throw new Error('rename needs a workflow and a new name: n8n-decanter rename <workflow> "<new name>"');
      if (names.length !== 1) throw new Error('rename needs exactly one new name: n8n-decanter rename <workflow> "<new name>"');
      await renameWorkflow(mcp(), config.root, id, names[0], log);
      break;
    }
    case "node:create": {
      const [id, ...names] = refs;
      if (!id) throw new Error('node create needs a workflow and a node name: n8n-decanter node create <workflow> "<Node name>" [--ts]');
      if (names.length !== 1) throw new Error('node create needs exactly one node name: n8n-decanter node create <workflow> "<Node name>" [--ts]');
      await addCodeNode(mcp(), config, id, names[0], { ts: tsFlag }, log);
      break;
    }
    case "node:rename": {
      const [id, ...names] = refs;
      if (!id) throw new Error('node rename needs a workflow and two node names: n8n-decanter node rename <workflow> "<old node>" "<new node>"');
      if (names.length !== 2) throw new Error('node rename needs the old and new node name: n8n-decanter node rename <workflow> "<old node>" "<new node>"');
      await renameNode(mcp(), config, id, names[0], names[1], log);
      break;
    }
    case "duplicate": {
      const [id, ...names] = refs;
      if (!id) throw new Error('duplicate needs a workflow ref: n8n-decanter <ref> duplicate ["<new name>"]');
      if (names.length > 1) throw new Error('duplicate takes at most one new name: n8n-decanter <ref> duplicate ["<new name>"]');
      await duplicateWorkflow(api("duplicate"), mcp(), config, id, names[0], log);
      break;
    }
    case "watch": {
      if (ids.length !== 1) throw new Error("watch needs exactly one workflow id (pass it, or list a single workflow in decanter.config.json)");
      // the returned handle exists for tests; the CLI watches until Ctrl-C
      await watchWorkflow(mcp(), config, ids[0], { force }, log);
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
