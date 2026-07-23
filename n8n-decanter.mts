#!/usr/bin/env node
import path from "node:path";
import { N8nApi } from "./lib/api.mts";
import { loadConfig, requireApiKey } from "./lib/config.mts";
import { cleanDataTables, fetchDataTables } from "./lib/datatables.mts";
import { DEFAULT_N8N_VERSION, dockerAvailable } from "./lib/engine.mts";
import { assertNoLegacyFixtures, cleanExecutions, fetchExecutionById, fetchExecutions, latestCaptureId, migrateScenariosDir } from "./lib/executions.mts";
import { init, printBanner } from "./lib/init.mts";
import { checkScenarios, listScenarioSlugs, runSimulation, writeScenario, type SimulationReport } from "./lib/simulate.mts";
import { publishWorkflow, unpublishWorkflow } from "./lib/lifecycle.mts";
import { createMcpClient, ENABLE_MCP_HINT, isUnavailableInMcp, type McpClient, prepareTestPinData, searchWorkflows } from "./lib/mcp.mts";
import { runStdioGuard } from "./lib/mcpconnect.mts";
import { DEFAULT_GUARD_PORT, startGuardProxy } from "./lib/mcpserve.mts";
import { ENABLE_MCP_VERB, mergeRemote, runPicker, type PickerResume } from "./lib/picker.mts";
import { ALL_CHECK_IDS, type CheckId, exitCodeOf, formatCheckLine, type Palette, type Profile, renderPreflightSummary, runPreflight } from "./lib/preflight.mts";
import { pullWorkflow } from "./lib/pull.mts";
import { pushWorkflow } from "./lib/push.mts";
import { printTestReport, runTest } from "./lib/testrun.mts";
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

${b("Inspect & test")}
  ${b("status")} [workflow…] [--diff]             ${d("drift report; exits 1 on conflict/remote drift")}
  ${b("check")} [workflow…] [--no-typecheck]      ${d("offline layout-compliance check")}
  ${b("executions")} [workflow…] [--status=…] [--limit=N]   ${d("fetch execution data (numeric arg = one by id)")}
  ${b("executions")} [workflow…] clean            ${d("delete fetched execution data (offline)")}
  ${b("data-tables")} [table…] [--filter=… --search=… --sort=… --limit=N --all]   ${d("fetch data-table schema + rows (read-only)")}
  ${b("data-tables")} [table…] clean              ${d("delete fetched data-table data (offline)")}
  ${b("test")} <workflow> [--execution <execution-id> | --scenario <slug>] [--trigger <node>] [--json]
  ${d("                                            pinned run on the INSTANCE (draft; recommended); exits 1 on divergence")}
  ${b("simulate")} <workflow> [--execution <execution-id> | --scenario <slug>] [--network-none] [--json]
  ${d("                                            replay through a LOCAL n8n engine (Docker, offline); exits 1 on divergence")}
  ${b("preflight")} [workflow…] [--quick|--full|--offline] [--json] [--fail-on=warn] [--fail-fast] [--require=<ids>]
  ${d("                                            the whole verification ladder as one scored, read-only gate (never mutates)")}
  ${b("list")} [--remote] [--json]                ${d("pulled workflows: name, id, folder")}

${b("Scenario")} ${d("(named, committed pin-data sets — captured or schema-scaffolded)")}
  ${b("scenario create")} <workflow> ["<slug>"] [--execution <id>] [--scaffold]   ${d("write a committed scenario from a capture and/or the workflow's schemas")}
  ${b("scenario check")} <workflow> ["<slug>"]                     ${d("structurally validate a scenario (or all); exits 1 on invalid")}

${b("Node")}
  ${b("node run")} <node-file> [fixture.json] [--allow-env]  ${d("run a node locally (offline)")}

${b("Agent guard")} ${d("(structure/lifecycle acts go through n8n's MCP — guarded; jsCode writes are blocked toward the file + push flow)")}
  ${b("mcp connect")}                             ${d("stdio MCP guard for agents — the scaffolded .mcp.json spawns it; no secret")}
  ${b("mcp serve")} [--port N]                    ${d("HTTP variant: localhost guard-proxy for URL-configured agents")}

A ${b("<workflow>")} is its id, name, unique name-prefix, or folder name (case-insensitive;
ambiguity is an error). A ref verb with no ${b("<workflow>")} on a terminal opens the picker.
An ${b("<execution-id>")} is an n8n execution id (numeric).

Config: decanter.config.json (searched upward from cwd). Credentials: N8N_HOST +
MCP (OAuth via ${b("init")}, or N8N_MCP_TOKEN) power sync; N8N_API_KEY (optional)
powers executions and data-tables.`;
};

// Verb-first grammar (Plan 27): the command is positional[0]. The structure/
// lifecycle verbs (rename, create, archive, node create, node rename) are
// retired — those acts go through n8n's MCP (guarded via `mcp connect`/
// `mcp serve`) and `pull` reconciles the local mirror.
const VERBS = new Set(["init", "pull", "push", "status", "check", "watch", "list", "executions", "data-tables", "simulate", "test", "preflight", "scenario", "mcp", "publish", "unpublish", "completion", "node", "__complete", "help"]);
/** Sub-verbs of the `node` namespace; dispatched as internal `node:<sub>` commands. */
const NODE_VERBS = new Set(["run"]);
/** Sub-verbs of the `scenario` namespace; dispatched as internal `scenario:<sub>` commands. */
const SCENARIO_VERBS = new Set(["create", "check"]);
/** Sub-verbs of the `mcp` namespace; dispatched as internal `mcp:<sub>` commands. */
const MCP_VERBS = new Set(["serve", "connect"]);
/** Verbs whose workflow arguments go through name resolution. */
const REF_VERBS = new Set(["pull", "push", "status", "check", "watch", "simulate", "test", "preflight", "publish", "unpublish"]);

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
      const m = raw[i].match(/^--(status|limit|execution|n8n-version|scenario|filter|search|sort|port|trigger|fail-on|require)(?:=(.*))?$/);
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
  // Plan 37 renamed `mock`/`--mock` to `scenario`/`--scenario` with no alias —
  // hard-error the old spelling with the replacement instead of silently
  // dropping `--mock` (it no longer matches the value-flag regex above).
  if (process.argv.slice(2).some((a) => a === "--mock" || a.startsWith("--mock=") || a === "--pin" || a.startsWith("--pin="))) {
    throw new Error("`--mock`/`--pin` were removed (Plan 37): use `--scenario <slug>` (create scenarios with `scenario create`; `simulate --pin` is gone — use `scenario create --execution <id>`)");
  }
  const force = args.includes("--force");
  const publishFlag = args.includes("--publish");
  const noTypecheck = args.includes("--no-typecheck");
  const scaffoldFlag = args.includes("--scaffold");
  const allowEnv = args.includes("--allow-env");
  const remoteFlag = args.includes("--remote");
  const diffFlag = args.includes("--diff");
  const jsonFlag = args.includes("--json");
  const networkNoneFlag = args.includes("--network-none");
  const allFlag = args.includes("--all");
  const quickFlag = args.includes("--quick");
  const fullFlag = args.includes("--full");
  const offlineFlag = args.includes("--offline");
  const failFastFlag = args.includes("--fail-fast");
  const noFetchFlag = args.includes("--no-fetch");
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
      throw new Error(`unknown node command: ${sub ?? "(none)"} — try: n8n-decanter node run (node create/rename now go through n8n's MCP; \`pull\` follows)`);
    }
    command = `node:${sub}`;
    rest = positional.slice(2);
  } else if (command === "mock") {
    // Plan 37: the `mock` verb was renamed to `scenario` with no alias.
    console.log(usage());
    throw new Error("the `mock` verb was renamed to `scenario` (Plan 37): use `n8n-decanter scenario create|check`");
  } else if (command === "scenario") {
    const sub = positional[1];
    if (sub === undefined || !SCENARIO_VERBS.has(sub)) {
      console.log(usage());
      throw new Error(`unknown scenario command: ${sub ?? "(none)"} — try: n8n-decanter scenario create|check`);
    }
    command = `scenario:${sub}`;
    rest = positional.slice(2);
  } else if (command === "mcp") {
    const sub = positional[1];
    if (sub === undefined || !MCP_VERBS.has(sub)) {
      console.log(usage());
      throw new Error(`unknown mcp command: ${sub ?? "(none)"} — try: n8n-decanter mcp connect|serve`);
    }
    command = `mcp:${sub}`;
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
  if (!command.startsWith("node:") && !command.startsWith("scenario:") && !command.startsWith("mcp:") && !VERBS.has(command)) {
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
    words.push(...NODE_VERBS, ...SCENARIO_VERBS, ...MCP_VERBS); // sub-verbs after `node` / `scenario` / `mcp`
    words.push("--force", "--publish", "--no-typecheck", "--remote", "--diff", "--status=", "--limit=", "--allow-env", "--execution=", "--scenario=", "--scaffold", "--json", "--network-none", "--n8n-version=", "--filter=", "--search=", "--sort=", "--all", "--port=", "--trigger=", "--quick", "--full", "--offline", "--fail-on=", "--fail-fast", "--require=", "--no-fetch", "--help");
    try {
      const config = loadConfig(process.cwd(), { requireHost: false });
      for (const ref of listWorkflowRefs(config.root)) words.push(...ref.names, ref.id);
    } catch {
      // no decanter.config.json in reach — verbs and flags still complete
    }
    console.log([...new Set(words)].join("\n"));
    return;
  }

  await dispatch(command, rest, { force, publishFlag, noTypecheck, scaffoldFlag, remoteFlag, diffFlag, jsonFlag, networkNoneFlag, allFlag, quickFlag, fullFlag, offlineFlag, failFastFlag, noFetchFlag, valueFlags });
}

interface Flags {
  force: boolean;
  publishFlag: boolean;
  noTypecheck: boolean;
  scaffoldFlag: boolean;
  remoteFlag: boolean;
  diffFlag: boolean;
  jsonFlag: boolean;
  networkNoneFlag: boolean;
  allFlag: boolean;
  quickFlag: boolean;
  fullFlag: boolean;
  offlineFlag: boolean;
  failFastFlag: boolean;
  noFetchFlag: boolean;
  valueFlags: Map<string, string>;
}

/** Flag defaults for picker-launched verbs (no CLI flags in play). */
const PICKER_FLAGS: Flags = { force: false, publishFlag: false, noTypecheck: false, scaffoldFlag: false, remoteFlag: false, diffFlag: false, jsonFlag: false, networkNoneFlag: false, allFlag: false, quickFlag: false, fullFlag: false, offlineFlag: false, failFastFlag: false, noFetchFlag: false, valueFlags: new Map() };

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
    remotePending = searchWorkflows(mcp, log).then((ws) => ws.map((w) => ({ id: w.id, name: w.name ?? w.id, available: w.availableInMCP })));
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
 * No-ref → picker (Plan 27): pick a single workflow for an already-known verb
 * (the verb menu is skipped). Returns the chosen id, or undefined when there is
 * nothing to pick or the user quits — the caller then falls through to the
 * config default / error path exactly as a piped run would.
 *
 * For `pull` the remote list is merged in (like the bare `n8n-decanter` picker)
 * so a fresh setup with nothing pulled still gets a menu — pick a not-yet-local
 * workflow and it pulls, no config entry or id needed. Other verbs act on local
 * files only, so their menu stays local-only.
 */
async function pickOneWorkflow(config: DecanterConfig, verb: string, log: Log): Promise<string | undefined> {
  const local = listWorkflowRefs(config.root, log).map((r) => ({ id: r.id, name: r.name, pulled: true, available: true }));
  let entries = local;
  if (verb === "pull") {
    try {
      const remote = (await searchWorkflows(createMcpClient(config, log), log)).map((w) => ({ id: w.id, name: w.name ?? w.id, available: w.availableInMCP }));
      entries = mergeRemote(local, remote);
    } catch {
      // Offline / auth failure — degrade to a local-only menu (same as the bare
      // picker, which shows a "remote list unavailable" notice and carries on).
    }
  }
  if (entries.length === 0) return undefined;
  const picked = await runPicker(entries, undefined, { selectVerb: verb });
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
  if (r.syntheticPins) {
    if (r.engineOk) log.ok(`simulation ran clean — synthetic pins (authored/scaffolded), so this proves executability, not output correctness (no per-node diff asserted)`);
    else log.error(`simulation engine run failed: ${r.engineError ?? "unknown error"}`);
  } else if (r.ok) log.ok(`simulation matches the capture (${r.diffs.length} node${r.diffs.length === 1 ? "" : "s"} checked)`);
  else log.error(`simulation diverged: ${r.divergent.length > 0 ? r.divergent.join(", ") : "engine error"}`);
  if (r.url && r.login) {
    log.info(`\nopen the run in n8n:  ${style.bold(r.url)}`);
    log.info(style.dim(`  local login: ${r.login.email} / ${r.login.password}  ·  throwaway instance, replaced on the next simulate (docker rm -f decanter-sim-viewer to stop)`));
  }
}

/** Config-needing verbs: load config, resolve refs, run the verb switch. */
async function dispatch(command: string, rest: string[], flags: Flags): Promise<void> {
  const { force, publishFlag, noTypecheck, scaffoldFlag, remoteFlag, diffFlag, jsonFlag, networkNoneFlag, allFlag, quickFlag, fullFlag, offlineFlag, failFastFlag, noFetchFlag, valueFlags } = flags;
  // simulate reads local captures + drives a throwaway engine — it never calls
  // n8n, so no credentials are required. Since Plan 32 the sync verbs (and the
  // rename/node namespace, which forward structure acts to n8n) go over MCP;
  // only the executions/data-tables fetches still use the REST API
  // (requireApiKey at the verb).
  const offline = command === "check" || command === "simulate"
    || command === "scenario:check" || (command === "scenario:create" && !scaffoldFlag)
    || (command === "preflight" && offlineFlag)
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
        const remote = await searchWorkflows(mcp(), log);
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

  /**
   * One-shot MCP verbs (archive/rename/node …): append the enable-MCP
   * guidance to the per-workflow refusal, the same way the pull/push/status
   * loop does (Plan 33 — previously these verbs surfaced only n8n's raw text).
   */
  const withEnableHint = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      if (!isUnavailableInMcp(err)) throw err;
      log.error((err as Error).message);
      log.info(`  ${ENABLE_MCP_HINT}`);
      process.exitCode = 1;
    }
  };

  let refs = rest;
  if (REF_VERBS.has(command)) {
    refs = [];
    for (const r of rest) refs.push(await resolveRef(r));
  } else if ((command === "scenario:create" || command === "scenario:check") && rest.length > 0) {
    // ref-plus-literals verbs: only the first argument is a workflow ref;
    // the rest are literals (a scenario slug) — not resolved.
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
      const remote = remoteFlag ? (await searchWorkflows(mcp(), log)).filter((w) => !known.has(w.id)) : [];
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
      if (refs.length !== 1) throw new Error("simulate needs exactly one workflow ref: n8n-decanter simulate <workflow> [--execution <id> | --scenario <slug>]");
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      migrateScenariosDir(dir, log);
      assertNoLegacyFixtures(dir);
      // Replay source: an explicit committed scenario (--scenario <slug>) or a
      // raw capture (--execution <id>, defaulting to the newest). Mutually exclusive.
      const scenarioSlug = valueFlags.get("scenario");
      if (scenarioSlug !== undefined && valueFlags.get("execution") !== undefined) {
        throw new Error("pass either --scenario <slug> or --execution <id>, not both");
      }
      const source = scenarioSlug !== undefined ? "scenario" : "capture";
      const ref = scenarioSlug ?? valueFlags.get("execution") ?? latestCaptureId(dir) ?? undefined;
      if (ref === undefined) throw new Error(`no execution to simulate: pass --execution <id> (or --scenario <slug>), or fetch one with \`n8n-decanter executions ${refs[0]}\``);
      if (source === "capture" && valueFlags.get("execution") === undefined) log.info(style.dim(`no --execution/--scenario given; using the latest capture ${ref}`));
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
    case "test": {
      if (refs.length !== 1) throw new Error("test needs exactly one workflow ref: n8n-decanter test <workflow> [--execution <id> | --scenario <slug>] [--trigger <node>]");
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      migrateScenariosDir(dir, log);
      assertNoLegacyFixtures(dir);
      const scenarioSlug = valueFlags.get("scenario");
      if (scenarioSlug !== undefined && valueFlags.get("execution") !== undefined) {
        throw new Error("pass either --scenario <slug> or --execution <id>, not both");
      }
      const source = scenarioSlug !== undefined ? "scenario" as const : "capture" as const;
      const ref = scenarioSlug ?? valueFlags.get("execution") ?? latestCaptureId(dir) ?? undefined;
      if (ref === undefined) throw new Error(`no execution to pin from: pass --execution <id> (or --scenario <slug>), or fetch one with \`n8n-decanter executions ${refs[0]}\``);
      if (source === "capture" && valueFlags.get("execution") === undefined) log.info(style.dim(`no --execution/--scenario given; using the latest capture ${ref}`));
      // test_workflow is synchronous with a 5-minute server-side cap — this
      // call needs a client whose timeout outlives it
      const testMcp = createMcpClient({ ...config, requestTimeoutMs: Math.max(config.requestTimeoutMs, 320_000) }, log);
      await withEnableHint(async () => {
        const report = await runTest(testMcp, config, dir, refs[0], { ref, source, trigger: valueFlags.get("trigger") }, log);
        if (jsonFlag) console.log(JSON.stringify(report, null, 2));
        else printTestReport(report, log);
        if (!report.ok) process.exitCode = 1;
      });
      break;
    }
    case "preflight": {
      if (ids.length === 0) {
        throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
      }
      // Profiles are deterministic and distinct — no magic escalation (Plan 36).
      if ([quickFlag, fullFlag, offlineFlag].filter(Boolean).length > 1) {
        throw new Error("--quick, --full and --offline are distinct profiles — pass at most one");
      }
      const profile: Profile = offlineFlag ? "offline" : fullFlag ? "full" : quickFlag ? "quick" : "default";
      const failOn = valueFlags.get("fail-on");
      if (failOn !== undefined && failOn !== "warn") throw new Error('--fail-on only accepts "warn" (e.g. --fail-on=warn)');
      const failOnWarn = failOn === "warn";
      const requireIds: CheckId[] = [];
      for (const r of (valueFlags.get("require") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!ALL_CHECK_IDS.includes(r as CheckId)) throw new Error(`--require: unknown check "${r}" — valid ids: ${ALL_CHECK_IDS.join(", ")}`);
        requireIds.push(r as CheckId);
      }
      const scenarioSlug = valueFlags.get("scenario");
      if (scenarioSlug !== undefined && valueFlags.get("execution") !== undefined) {
        throw new Error("pass either --scenario <slug> or --execution <id>, not both");
      }
      const simVersion = valueFlags.get("n8n-version") ?? config.n8nVersion ?? DEFAULT_N8N_VERSION;
      const hasApiKey = config.apiKey !== "";
      const palette: Palette = { green: style.green, yellow: style.yellow, red: style.red, dim: style.dim, bold: style.bold };
      // test_workflow is synchronous with a 5-min server cap — its client's timeout must outlive it
      let testMcpClient: McpClient | undefined;
      const testMcp = (): McpClient => (testMcpClient ??= createMcpClient({ ...config, requestTimeoutMs: Math.max(config.requestTimeoutMs, 320_000) }, log));
      // read-only REST client (auto-fetch + history fallback) — only invoked when hasApiKey, so it never needs requireApiKey
      const restApi = (): N8nApi => new N8nApi({ host: config.host, apiKey: config.apiKey, requestTimeoutMs: config.requestTimeoutMs });

      const reports: Awaited<ReturnType<typeof runPreflight>>[] = [];
      let failed = false;
      const total = ids.length;
      for (const [i, id] of ids.entries()) {
        const dir = findWorkflowDir(config.root, id, log);
        if (!dir) {
          failed = true;
          log.error(`${id}: not found under ${config.root} — pull it first`);
          continue;
        }
        let name = id;
        try {
          name = readState(dir)?.name ?? id;
        } catch {
          // corrupt state — the layout check surfaces it; keep the id as the label
        }
        if (!jsonFlag) {
          const prefix = total > 1 ? style.dim(`[${i + 1}/${total}] `) : "";
          log.info(`${prefix}${style.bold(`preflight: ${name}`)} ${style.dim(`· ${profile} profile`)}`);
        }
        const report = await runPreflight({
          config, dir, id, name, profile,
          scenarioSlug, executionId: valueFlags.get("execution"), trigger: valueFlags.get("trigger"),
          noFetch: noFetchFlag, failFast: failFastFlag, requireIds, simVersion, hasApiKey,
          mcp, testMcp, api: restApi, dockerAvailable,
          onCheck: jsonFlag ? undefined : (f) => log.info(formatCheckLine(f, palette)),
        });
        reports.push(report);
        if (!jsonFlag) {
          renderPreflightSummary(report, log, palette);
          if (total > 1) log.info("");
        }
        if (exitCodeOf(report.verdict, { failOnWarn }) === 1) failed = true;
      }
      // shape keyed on workflows TARGETED (not reports produced): a multi-ref
      // run stays an array even if some ids didn't resolve (the documented
      // agent contract); a lone unresolved id emits null, not undefined.
      if (jsonFlag) console.log(JSON.stringify(total === 1 ? (reports[0] ?? null) : reports, null, 2));
      if (failed) process.exitCode = 1;
      break;
    }
    case "scenario:create": {
      if (refs.length < 1) throw new Error('scenario create needs a workflow ref: n8n-decanter scenario create <workflow> ["<slug>"] [--execution <id>] [--scaffold]');
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      migrateScenariosDir(dir, log);
      assertNoLegacyFixtures(dir);
      // Seed sources, composable: a capture (--execution <id>, or the newest one)
      // and/or the workflow's schemas (--scaffold, via n8n's read-only
      // prepare_test_pin_data oracle). A bare --scaffold builds from scratch
      // (no capture); no --scaffold uses the latest capture as before.
      const explicitExec = valueFlags.get("execution");
      let execId: string | undefined;
      if (explicitExec !== undefined) {
        execId = explicitExec;
      } else if (!scaffoldFlag) {
        execId = latestCaptureId(dir) ?? undefined;
        if (execId === undefined) throw new Error(`no execution to seed the scenario: pass --execution <id>, add --scaffold to build from the workflow's schemas, or fetch a capture first with \`n8n-decanter executions ${refs[0]}\``);
        log.info(style.dim(`no --execution given; using the latest capture ${execId}`));
      }
      const scaffold = scaffoldFlag ? await prepareTestPinData(mcp(), refs[0]) : undefined;
      const slug = refs[1] ?? execId ?? "scenario";
      const result = await writeScenario(dir, { execId, slug, scaffold }, log);
      if (jsonFlag) console.log(JSON.stringify({ slug: result.slug, file: path.relative(process.cwd(), result.file), gaps: result.gaps, coverage: result.coverage }, null, 2));
      break;
    }
    case "scenario:check": {
      if (refs.length < 1) throw new Error('scenario check needs a workflow ref: n8n-decanter scenario check <workflow> ["<slug>"]');
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      migrateScenariosDir(dir, log);
      const slug = refs[1];
      if (jsonFlag) {
        const slugs = slug !== undefined ? [slug] : listScenarioSlugs(dir);
        const results = slugs.map((s) => {
          const silent: Log = { info() {}, ok() {}, warn() {}, error() {} };
          const invalid = checkScenarios(dir, s, silent);
          return { slug: s, valid: invalid === 0 };
        });
        console.log(JSON.stringify(results, null, 2));
        if (results.some((r) => !r.valid)) process.exitCode = 1;
        break;
      }
      const invalid = checkScenarios(dir, slug, log);
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
    case "watch": {
      if (ids.length !== 1) throw new Error("watch needs exactly one workflow id (pass it, or list a single workflow in decanter.config.json)");
      // the returned handle exists for tests; the CLI watches until Ctrl-C
      await watchWorkflow(mcp(), config, ids[0], { force }, log);
      await new Promise(() => {});
      break;
    }
    case "mcp:serve": {
      const portRaw = valueFlags.get("port");
      const port = portRaw !== undefined ? Number(portRaw) : DEFAULT_GUARD_PORT;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number (0 for ephemeral)");
      const handle = await startGuardProxy({ mcp: mcp(), host: config.host, configDir: config.configDir, port, log });
      log.ok(`MCP guard-proxy listening on ${handle.url}`);
      log.info(`  forwards to ${config.host} with decanter's credentials — the agent never sees them`);
      log.info(`  blocks: update_workflow calls carrying jsCode (Code-node source is files + \`n8n-decanter push\`)`);
      log.info("");
      log.info("point your agent's MCP config at it (session secret rotates per run):");
      log.info(style.dim(JSON.stringify({ mcpServers: { "n8n-instance": { type: "http", url: handle.url, headers: { Authorization: `Bearer ${handle.secret}` } } } }, null, 2)));
      log.info("");
      log.info(style.dim("Ctrl-C stops the proxy (decanter's own sync never routes through it)"));
      await new Promise(() => {});
      break;
    }
    case "mcp:connect": {
      // stdio MCP guard: the agent spawns this process from `.mcp.json`, so
      // stdout carries protocol messages ONLY — every log line goes to stderr,
      // and the MCP client is built with the stderr logger for the same reason.
      const elog: Log = {
        info: (m) => console.error(m),
        ok: (m) => console.error(`${styleErr.green("✓")} ${m}`),
        warn: (m) => console.error(styleErr.yellow(`! ${m}`)),
        error: (m) => console.error(styleErr.red(`✗ ${m}`)),
      };
      await runStdioGuard({ mcp: createMcpClient(config, elog), host: config.host, timeoutMs: config.requestTimeoutMs, log: elog });
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
