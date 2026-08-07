#!/usr/bin/env node
import path from "node:path";
import { N8nApi } from "./lib/api.mts";
import { backupCreate, backupList, backupRestore } from "./lib/backup.mts";
import { loadConfig, requireApiKey } from "./lib/config.mts";
import { cleanDataTables, fetchDataTables } from "./lib/datatables.mts";
import { DEFAULT_N8N_VERSION, dockerAvailable } from "./lib/engine.mts";
import { assertNoLegacyFixtures, cleanExecutions, EXECUTIONS_DIR, fetchExecutionById, fetchExecutions, latestCaptureId, migrateScenariosDir } from "./lib/executions.mts";
import { cliVersion, init, printBanner } from "./lib/init.mts";
import { checkScenarios, listScenarioSlugs, writeScenario } from "./lib/simulate.mts";
import { publishWorkflow, unpublishWorkflow } from "./lib/lifecycle.mts";
import { createMcpClient, ENABLE_MCP_HINT, isUnavailableInMcp, type McpClient, prepareTestPinData, searchWorkflows } from "./lib/mcp.mts";
import { runStdioGuard } from "./lib/mcpconnect.mts";
import { DEFAULT_GUARD_PORT, startGuardProxy } from "./lib/mcpserve.mts";
import { createMirror } from "./lib/mirror.mts";
import { ENABLE_MCP_VERB, mergeRemote, runPicker, runVerbWithForceRetry, sortByRecency, type PickerResume } from "./lib/picker.mts";
import { ALL_CHECK_IDS, type CheckId, describeFlags, exitCodeOf, formatCheckDetails, formatCheckLine, type Palette, renderPreflightSummary, RETIRED_CHECK_IDS, runPreflight } from "./lib/preflight.mts";
import { pullWorkflow } from "./lib/pull.mts";
import { pushWorkflow } from "./lib/push.mts";
import { printTestReport, runStaticTest, runTest } from "./lib/testrun.mts";
import { runNode } from "./lib/run.mts";
import { findWorkflowDir, listWorkflowRefs, looksLikeWorkflowId, matchWorkflowRef, readState } from "./lib/state.mts";
import { diffWorkflow } from "./lib/diff.mts";
import { style, styleErr, transientLine } from "./lib/style.mts";
import type { DecanterConfig, Log } from "./lib/types.mts";
import { runTypecheck, runTypecheckPerDir, type TypecheckResult } from "./lib/validate.mts";
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
  ${b("init")} [dir] [--force] [--host <url> --token <mcp-token> --api-key <public-api-key>]
  ${d("                                              setup: .env, starter files, config (flags drive it non-interactively)")}
  ${b("completion")} zsh|bash                     ${d("print a shell completion script for your rc file")}

${b("Sync")} ${d("(over n8n's MCP server — Code-node source only; structure lives in n8n)")}
  ${b("pull")} [workflow…]                        ${d("pull code into workflows/<kebab>/ (default: config list)")}
  ${b("push")} [workflow…] [--force] [--publish] [--no-typecheck]   ${d("push code to the draft (--publish takes it live)")}
  ${b("watch")} [workflow]                        ${d("watch code/, push each save to the draft")}
  ${b("publish")} [workflow…]                     ${d("take the draft(s) live")}
  ${b("unpublish")} [workflow…]                   ${d("return the draft(s) to draft-only")}

${b("Inspect & test")}
  ${b("preflight")} [workflow…] [--simulate] [--offline] [--json] [--fail-on=warn] [--fail-fast] [--require=<ids>]
  ${d("                                            the gate: grades LOCAL code into one scored, read-only verdict")}
  ${d("                                            --simulate ADDS a local-engine run (Docker); --offline DROPS instance reads")}
  ${b("diff")} [workflow…]                        ${d("per-node line diff, local code vs the n8n draft (always exits 0)")}
  ${b("executions")} [workflow…] [--status=…] [--limit=N]   ${d("fetch execution data (numeric arg = one by id)")}
  ${b("executions")} [workflow…] clean            ${d("delete fetched execution data (offline)")}
  ${b("data-tables")} [table…] [--filter=… --search=… --sort=… --limit=N --all]   ${d("fetch data-table schema + rows (read-only)")}
  ${b("data-tables")} [table…] clean              ${d("delete fetched data-table data (offline)")}
  ${b("test")} <workflow> [--execution <execution-id> | --scenario <slug>] [--trigger <node>] [--json]
  ${d("                                            grades the INSTANCE's draft (after push). Bare: static check only,")}
  ${d("                                            nothing runs. With --execution/--scenario: pinned run, exits 1 on divergence")}
  ${b("list")} [--remote] [--json]                ${d("pulled workflows: name, id, folder")}

${b("Scenario")} ${d("(named, committed pin-data sets — captured or schema-scaffolded)")}
  ${b("scenario create")} <workflow> ["<slug>"] [--execution <id>] [--scaffold]   ${d("write a committed scenario from a capture and/or the workflow's schemas")}
  ${b("scenario create")} <workflow> "<slug>" --extend            ${d("top an existing scenario up with the nodes `test` still needs")}
  ${b("scenario check")} <workflow> ["<slug>"]                     ${d("structurally validate a scenario (or all); exits 1 on invalid")}

${b("Backup")} ${d("(git-native, redeployable disaster-recovery store — REST, needs N8N_API_KEY)")}
  ${b("backup create")} <workflow>                  ${d("capture the workflow's full REST export into backups/ (not auto-committed)")}
  ${b("backup restore")} <workflow> [<backup>]      ${d("redeploy a backup as a NEW, unpublished workflow (node ids preserved)")}
  ${b("backup list")} <workflow>                    ${d("list retained backups: timestamp · versionId · node count")}

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
powers executions, data-tables, and backup.`;
};

// Verb-first grammar (Plan 27): the command is positional[0]. The structure/
// lifecycle verbs (rename, create, archive, node create, node rename) are
// retired — those acts go through n8n's MCP (guarded via `mcp connect`/
// `mcp serve`) and `pull` reconciles the local mirror.
const VERBS = new Set(["init", "pull", "push", "diff", "watch", "list", "executions", "data-tables", "test", "preflight", "scenario", "backup", "mcp", "publish", "unpublish", "completion", "node", "__complete", "help"]);
/**
 * Verbs removed by Plan 59 → the replacement, printed as a hard error (exit 1)
 * instead of a bare "unknown verb". They are deliberately NOT in `VERBS`: a
 * removed verb must not re-enter the value-flag lookahead, the `--version`
 * guard, or `check:docs`'s surface parity.
 */
const REMOVED_VERBS: Record<string, string> = {
  check: "static-only checking is `n8n-decanter preflight --offline` (layout + types, no network, no engine)",
  status: "the drift summary is `n8n-decanter preflight`; the per-node line diff is `n8n-decanter diff`",
  simulate: "the local-engine replay is `n8n-decanter preflight --simulate` — add `--offline` for the credential-free, no-instance form the verb had, and `--viewer` for the browsable run",
};
/** Sub-verbs of the `node` namespace; dispatched as internal `node:<sub>` commands. */
const NODE_VERBS = new Set(["run"]);
/** Sub-verbs of the `scenario` namespace; dispatched as internal `scenario:<sub>` commands. */
const SCENARIO_VERBS = new Set(["create", "check"]);
/** Sub-verbs of the `backup` namespace; dispatched as internal `backup:<sub>` commands. */
const BACKUP_VERBS = new Set(["create", "restore", "list"]);
/** Sub-verbs of the `mcp` namespace; dispatched as internal `mcp:<sub>` commands. */
const MCP_VERBS = new Set(["serve", "connect"]);
/** Verbs whose workflow arguments go through name resolution. */
const REF_VERBS = new Set(["pull", "push", "diff", "watch", "test", "preflight", "publish", "unpublish"]);

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
  // `--version`/`-v` is the one flag name every CLI is expected to answer, so it
  // stays out of every verb's namespace and is handled before anything else — no
  // config load, no verb. Alongside a verb it is a hard error instead: no verb
  // takes a `--version`, and staying silent would mean swallowing the command
  // (printing a version and skipping the work the user asked for).
  {
    const raw = process.argv.slice(2);
    if (raw.some((a) => a === "--version" || a === "-v" || a.startsWith("--version="))) {
      const verb = raw.find((a) => VERBS.has(a));
      if (verb === undefined) {
        console.log(cliVersion());
        return;
      }
      const hint = verb === "backup" ? " — `backup restore` takes the backup as an argument: `backup restore <workflow> [<timestamp|versionId>]`" : "";
      throw new Error(`--version prints the CLI version and takes no value; it is not a \`${verb}\` flag${hint}`);
    }
  }
  // --status/--limit take a value (--limit=5 or --limit 5); they're peeled
  // off first so the boolean-flag and positional logic below stays untouched.
  const valueFlags = new Map<string, string>();
  const args: string[] = [];
  {
    const raw = process.argv.slice(2);
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i].match(/^--(status|limit|execution|n8n-version|scenario|filter|search|sort|port|trigger|fail-on|require|host|token|mcp-token|api-key)(?:=(.*))?$/);
      if (!m) {
        args.push(raw[i]);
        continue;
      }
      const example = m[1] === "limit" ? "5" : m[1] === "status" ? "success" : m[1] === "host" ? "http://localhost:5678" : m[1] === "token" || m[1] === "mcp-token" ? "<mcp-token>" : m[1] === "api-key" ? "<api-key>" : "123";
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
    throw new Error("`--mock`/`--pin` were removed (Plan 37): use `--scenario <slug>` — create scenarios with `scenario create --execution <id>`, then replay with `preflight --simulate --scenario <slug>`");
  }
  // Same treatment for `backup restore`'s v0.6.0 selectors, now a positional
  // backup ref. Silence would be worse than for most retired flags: `--at=<ts>`
  // matches nothing, gets dropped from the positionals, and the restore would
  // quietly land the LATEST backup instead of the requested one.
  if (process.argv.slice(2).some((a) => a === "--at" || a.startsWith("--at=") || a === "--version-id" || a.startsWith("--version-id="))) {
    throw new Error("`--at`/`--version-id` were removed: `backup restore` takes the backup as an argument — `n8n-decanter backup restore <workflow> [<timestamp|versionId>]` (see `backup list`)");
  }
  const force = args.includes("--force");
  const publishFlag = args.includes("--publish");
  const noTypecheck = args.includes("--no-typecheck");
  const scaffoldFlag = args.includes("--scaffold");
  const extendFlag = args.includes("--extend");
  const allowEnv = args.includes("--allow-env");
  const remoteFlag = args.includes("--remote");
  const jsonFlag = args.includes("--json");
  const allFlag = args.includes("--all");
  // Plan 59: preflight's depth is two orthogonal booleans — `--simulate` adds
  // the local-engine stage, `--offline` drops the instance tier. They compose.
  const simulateFlag = args.includes("--simulate");
  const offlineFlag = args.includes("--offline");
  const viewerFlag = args.includes("--viewer");
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
  } else if (command === "backup") {
    const sub = positional[1];
    if (sub === undefined || !BACKUP_VERBS.has(sub)) {
      console.log(usage());
      throw new Error(`unknown backup command: ${sub ?? "(none)"} — try: n8n-decanter backup create|restore|list`);
    }
    command = `backup:${sub}`;
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
  if (!command.startsWith("node:") && !command.startsWith("scenario:") && !command.startsWith("backup:") && !command.startsWith("mcp:") && !VERBS.has(command)) {
    // A verb this CLI used to have gets its replacement, not a bare "unknown
    // verb" — the same courtesy `mock` got in Plan 37. `main()`'s catch turns
    // the throw into exit 1, which is what the migration contract promises.
    const replacement = REMOVED_VERBS[command];
    if (replacement !== undefined) throw new Error(`the \`${command}\` verb was removed (Plan 59): ${replacement}`);
    console.log(usage());
    throw new Error(`unknown verb: ${command}`);
  }

  if (command === "init") {
    // must run before loadConfig: a fresh directory has no config/.env yet
    if (rest.length > 1) throw new Error("init takes at most one directory argument");
    // --host/--token/--api-key drive init non-interactively (Plan 35 finding).
    // `--mcp-token` is an accepted alias: two blind rounds probed for the name
    // (`--token FAKE`, then `--mcp-token FAKE`) before committing (Plan 75). The
    // token IS the MCP one, so the longer spelling is the reasonable guess.
    await init(rest[0], { force, host: valueFlags.get("host"), token: valueFlags.get("token") ?? valueFlags.get("mcp-token"), apiKey: valueFlags.get("api-key") }, log);
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
    words.push(...NODE_VERBS, ...SCENARIO_VERBS, ...BACKUP_VERBS, ...MCP_VERBS); // sub-verbs after `node` / `scenario` / `backup` / `mcp`
    words.push("--force", "--publish", "--no-typecheck", "--remote", "--status=", "--limit=", "--allow-env", "--execution=", "--scenario=", "--scaffold", "--extend", "--json", "--n8n-version=", "--filter=", "--search=", "--sort=", "--all", "--port=", "--trigger=", "--simulate", "--offline", "--viewer", "--fail-on=", "--fail-fast", "--require=", "--no-fetch", "--host=", "--token=", "--mcp-token=", "--api-key=", "--help", "--version");
    try {
      const config = loadConfig(process.cwd(), { requireHost: false });
      for (const ref of listWorkflowRefs(config.root)) words.push(...ref.names, ref.id);
    } catch {
      // no decanter.config.json in reach — verbs and flags still complete
    }
    console.log([...new Set(words)].join("\n"));
    return;
  }

  await dispatch(command, rest, { force, publishFlag, noTypecheck, scaffoldFlag, extendFlag, remoteFlag, jsonFlag, allFlag, simulateFlag, offlineFlag, viewerFlag, failFastFlag, noFetchFlag, valueFlags });
}

interface Flags {
  force: boolean;
  publishFlag: boolean;
  noTypecheck: boolean;
  scaffoldFlag: boolean;
  extendFlag: boolean;
  remoteFlag: boolean;
  jsonFlag: boolean;
  allFlag: boolean;
  simulateFlag: boolean;
  offlineFlag: boolean;
  viewerFlag: boolean;
  failFastFlag: boolean;
  noFetchFlag: boolean;
  valueFlags: Map<string, string>;
}

/** Flag defaults for picker-launched verbs (no CLI flags in play). */
const PICKER_FLAGS: Flags = { force: false, publishFlag: false, noTypecheck: false, scaffoldFlag: false, extendFlag: false, remoteFlag: false, jsonFlag: false, allFlag: false, simulateFlag: false, offlineFlag: false, viewerFlag: false, failFastFlag: false, noFetchFlag: false, valueFlags: new Map() };

/**
 * Picker rows that are a verb PLUS flags (Plan 59). Every other row dispatches
 * as a bare verb with `PICKER_FLAGS`. This is what keeps the browsable
 * local-engine run — the old `simulate` menu entry, which defaulted its viewer
 * on for a TTY — reachable now that the verb is a flag.
 */
const PICKER_ACTIONS: Record<string, { command: string; flags: Flags }> = {
  "preflight --simulate": { command: "preflight", flags: { ...PICKER_FLAGS, simulateFlag: true, viewerFlag: true } },
};

/**
 * Interactive session (Plan 19 + loop follow-up): banner, then pick → run →
 * back in the same workflow's verb menu until Esc (workflow list, then quit)
 * or Ctrl-C. The remote list comes over MCP (`search_workflows` sees every
 * workflow; the `availableInMCP` flag feeds the third picker state, Plan 32),
 * fetched once and cached across iterations; a verb error is logged and
 * returns to the menu instead of ending the session — except a *forceable* one
 * (push drift), which first offers a `--force` retry (Plan 29). Pulled
 * workflows are listed newest-synced first. The process exit code reflects the
 * last verb run.
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
    // re-listed each round: a pull just added a folder (or renamed one), and a
    // push just re-stamped a state file — so recency is re-read here too
    const local = sortByRecency(listWorkflowRefs(config.root, log).map((r) => ({ id: r.id, name: r.name, pulled: true, available: true, syncedAt: r.syncedAt })));
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
    const action = PICKER_ACTIONS[picked.verb] ?? { command: picked.verb, flags: PICKER_FLAGS };
    // A forceable failure (the push drift guard) gets a y/N force-retry offer
    // instead of only printing the hint — Plan 29. The retry re-dispatches the
    // SAME row, so a flag-carrying row keeps its flags.
    const ok = await runVerbWithForceRetry(
      (force) => dispatch(action.command, [picked.id], force ? { ...action.flags, force: true } : action.flags),
      log,
    );
    process.exitCode = ok ? 0 : 1;
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
  const local = sortByRecency(listWorkflowRefs(config.root, log).map((r) => ({ id: r.id, name: r.name, pulled: true, available: true, syncedAt: r.syncedAt })));
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

/** Config-needing verbs: load config, resolve refs, run the verb switch. */
async function dispatch(command: string, rest: string[], flags: Flags): Promise<void> {
  const { force, publishFlag, noTypecheck, scaffoldFlag, extendFlag, remoteFlag, jsonFlag, allFlag, simulateFlag, offlineFlag, viewerFlag, failFastFlag, noFetchFlag, valueFlags } = flags;
  // Since Plan 32 the sync verbs (and the node namespace, which forwards
  // structure acts to n8n) go over MCP; only the executions/data-tables fetches
  // still use the REST API (requireApiKey at the verb).
  //
  // Plan 59: `preflight --offline` is the credential-free gate — including with
  // `--simulate`, which drives a local throwaway engine and never calls n8n. A
  // bare `preflight --simulate` still runs the instance tier, so it needs a host.
  // Plan 76: `scenario create` is offline in ALL its forms. `--scaffold` used to
  // demand a host for the JSON Schemas alone; those are an annotation, and the
  // gaps themselves come from the local workflow.json — so it now degrades to an
  // unannotated scaffold when no host is configured, instead of refusing.
  const offline = command === "scenario:check" || command === "scenario:create"
    || command === "backup:list"
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
   * through unchanged — it may exist only remotely (pull by fresh id must
   * keep working).
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
   * One-shot MCP verbs (test …): append the enable-MCP guidance to the
   * per-workflow refusal, the same way the pull/push/diff loop does (Plan 33 —
   * previously these verbs surfaced only n8n's raw text).
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
  } else if (((command === "scenario:create" || command === "scenario:check") || command.startsWith("backup:")) && rest.length > 0) {
    // ref-plus-literals verbs: only the first argument is a workflow ref;
    // the rest are literals (a scenario slug) — not resolved.
    refs = [await resolveRef(rest[0]), ...rest.slice(1)];
  }
  // No-ref → picker (Plan 27): a pure ref verb (or a backup/scenario sub-verb)
  // with no workflow, on a terminal, picks one; piped/non-TTY falls through to
  // the config default / error below. `scenario:` belongs here for the same
  // reason `backup:` does — both take a workflow ref as their first argument, so
  // hard-erroring on a terminal while every sibling verb offers the picker was
  // an inconsistency (a blind field-test agent tripped it twice, Plan 35).
  if (refs.length === 0 && (REF_VERBS.has(command) || command.startsWith("backup:") || command.startsWith("scenario:")) && interactive()) {
    const picked = await pickOneWorkflow(config, command, log);
    if (picked !== undefined) refs = [picked];
  }
  // `preflight` absorbed `check` (Plan 59), which checked every PULLED
  // workflow when given no refs. Keep that: a scaffold whose config lists no
  // workflows must still get a whole-project gate rather than "no workflow ids".
  const pulledFallback = command === "preflight" && refs.length === 0 && config.workflows.length === 0
    ? listWorkflowRefs(config.root).map((r) => r.id)
    : [];
  const ids = refs.length > 0 ? refs : config.workflows.length > 0 ? config.workflows : pulledFallback;

  switch (command) {
    case "pull":
    case "push":
    case "diff": {
      if (ids.length === 0) {
        throw new Error('no workflow ids: pass them as arguments or list them in decanter.config.json "workflows"');
      }
      if (command === "push" && !noTypecheck) await runTypecheck(config.configDir, log);
      let failed = false;
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
            await diffWorkflow(mcp(), config.root, id, plog);
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
      // A thrown error still exits 1 — but `diff` itself never gates (Plan 59:
      // it is `git diff`, an inspection view; `preflight` is the gate).
      if (failed) process.exitCode = 1;
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
      const ref = scenarioSlug ?? valueFlags.get("execution");
      // Plan 64: NO latest-capture fallback. A bare `test` used to execute for
      // real against the instance, steered by whatever sat in the gitignored
      // executions/ dir — so two people on one commit got different behaviour.
      // Bare is now the read-only static tier; executing means saying so.
      if (ref === undefined) {
        const staticMcp = createMcpClient(config, log);
        await withEnableHint(async () => {
          const report = await runStaticTest(staticMcp, refs[0], log);
          if (jsonFlag) console.log(JSON.stringify(report, null, 2));
          if (!report.ok) process.exitCode = 1;
        });
        break;
      }
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
      // Depth is two orthogonal booleans, deterministic and composable — no
      // profiles, no magic escalation (Plan 36's rule, Plan 59's vocabulary).
      // `--simulate` ADDS the local-engine stage; `--offline` DROPS the
      // instance tier. All four combinations are legal and mean exactly what
      // they say.
      const preflightFlags = { simulate: simulateFlag, offline: offlineFlag };
      if (viewerFlag && !simulateFlag) {
        throw new Error("--viewer browses the local-engine run — pass --simulate too (n8n-decanter preflight <workflow> --simulate --viewer)");
      }
      const failOn = valueFlags.get("fail-on");
      if (failOn !== undefined && failOn !== "warn") throw new Error('--fail-on only accepts "warn" (e.g. --fail-on=warn)');
      const failOnWarn = failOn === "warn";
      const requireIds: CheckId[] = [];
      for (const r of (valueFlags.get("require") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        // a retired id gets its reason + replacement, not a bare "unknown check" —
        // `--require=test` shipped in 0.6.0 and may sit in a user's CI config
        if (RETIRED_CHECK_IDS[r] !== undefined) throw new Error(`--require: "${r}" is no longer a preflight check — ${RETIRED_CHECK_IDS[r]}`);
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
      // read-only REST client (auto-fetch + history fallback) — only invoked when hasApiKey, so it never needs requireApiKey
      const restApi = (): N8nApi => new N8nApi({ host: config.host, apiKey: config.apiKey, requestTimeoutMs: config.requestTimeoutMs });

      const reports: Awaited<ReturnType<typeof runPreflight>>[] = [];
      let failed = false;
      const total = ids.length;
      // One typecheck for the whole run, split per workflow: `tsc` compiles the
      // entire project every time and only filters its OUTPUT, so calling it
      // per workflow made the cost linear in workflow count (3× the retired
      // `check` verb on a 3-workflow dir). Resolve the dirs up front for it.
      const targets = new Map<string, string>();
      for (const id of ids) {
        const dir = findWorkflowDir(config.root, id, log);
        if (dir) targets.set(id, dir);
      }
      const typechecks: Map<string, TypecheckResult> = noTypecheck || targets.size === 0
        ? new Map()
        : await runTypecheckPerDir(config.configDir, [...targets.values()]);
      for (const [i, id] of ids.entries()) {
        const dir = targets.get(id);
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
          log.info(`${prefix}${style.bold(`preflight: ${name}`)} ${style.dim(`· ${describeFlags(preflightFlags)}`)}`);
        }
        const report = await runPreflight({
          config, dir, id, name, flags: preflightFlags,
          viewer: viewerFlag, viewerLog: log, noTypecheck, typecheckResult: typechecks.get(path.resolve(dir)),
          scenarioSlug, executionId: valueFlags.get("execution"),
          noFetch: noFetchFlag, failFast: failFastFlag, requireIds, simVersion, hasApiKey,
          mcp, api: restApi, dockerAvailable,
          onCheck: jsonFlag ? undefined : (f) => {
            log.info(formatCheckLine(f, palette));
            for (const d of formatCheckDetails(f, palette)) log.info(d);
          },
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
      if (refs.length < 1) throw new Error('scenario create needs a workflow ref: n8n-decanter scenario create <workflow> ["<slug>"] [--execution <id>] [--scaffold] [--extend]');
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      migrateScenariosDir(dir, log);
      assertNoLegacyFixtures(dir);
      // --extend tops an EXISTING scenario up with the pinnable nodes it lacks
      // (Plan 65). Offline and additive — it never re-seeds from a capture, so
      // it needs neither --execution nor --scaffold.
      if (extendFlag) {
        if (refs[1] === undefined) throw new Error('scenario create --extend needs the scenario slug: n8n-decanter scenario create <workflow> "<slug>" --extend');
        const extended = await writeScenario(dir, { slug: refs[1], extend: true }, log);
        if (jsonFlag) console.log(JSON.stringify({ slug: extended.slug, file: path.relative(process.cwd(), extended.file), gaps: extended.gaps }, null, 2));
        break;
      }
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
        // Routes sorted by what the reader can act on RIGHT NOW (Plan 76): the
        // first two need nothing but this folder; the last one needs the
        // instance, and says so rather than leaving you to find out.
        if (execId === undefined) throw new Error(`no execution to seed the scenario. Without an instance: pass --execution <id> if a capture is already under ${EXECUTIONS_DIR}/, or add --scaffold to build the fill from this workflow's own nodes. With an instance: fetch a capture first — \`n8n-decanter executions ${refs[0]}\``);
        log.info(style.dim(`no --execution given; using the latest capture ${execId}`));
      }
      // Schemas are an annotation on the fill, not a prerequisite for it — so a
      // schema fetch that cannot happen degrades the scaffold instead of killing
      // it, and says why.
      //
      // BOTH ways it cannot happen matter, and the second is the common one: an
      // air-gapped user has a perfectly good `.env`, they just have no network.
      // The first cut of this only handled `host === ""`, and S9's round found
      // it immediately — `scenario create --scaffold` died on `✗ fetch failed`
      // with an unreachable host still configured (Plan 76).
      let scaffold: Awaited<ReturnType<typeof prepareTestPinData>> | undefined;
      if (scaffoldFlag) {
        if (config.host === "") {
          log.warn("no N8N_HOST configured — scaffolding from workflow.json alone; the fill carries no expectedSchema annotations (they come from the instance)");
        } else {
          try {
            scaffold = await prepareTestPinData(mcp(), refs[0]);
          } catch (err) {
            log.warn(`could not reach n8n for the output schemas (${(err as Error).message.split("\n")[0]}) — scaffolding from workflow.json alone; the fill carries no expectedSchema annotations`);
          }
        }
      }
      const slug = refs[1] ?? execId ?? "scenario";
      const result = await writeScenario(dir, { execId, slug, scaffold, scaffoldRequested: scaffoldFlag }, log);
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
    case "backup:create":
    case "backup:restore":
    case "backup:list": {
      if (refs.length < 1) throw new Error(`backup ${command.slice("backup:".length)} needs a workflow ref: n8n-decanter ${command.replace(":", " ")} <workflow>`);
      const dir = findWorkflowDir(config.root, refs[0], log);
      if (!dir) throw new Error(`workflow ${refs[0]} not found under ${config.root} — pull it first`);
      if (command === "backup:list") {
        backupList(dir, log, { json: jsonFlag });
        break;
      }
      const backupApi = api("backup");
      if (command === "backup:create") {
        await backupCreate(backupApi, dir, { limit: config.backupLimit }, log);
      } else {
        // refs[1] is an optional backup ref (timestamp or versionId, see
        // matchesBackupRef); absent, restore takes the latest or opens the chooser.
        await backupRestore(backupApi, dir, { host: config.host, ref: refs[1], interactive: interactive() }, log);
      }
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
      const serveMcp = mcp();
      // Live snapshot mirror (Plan 51 Part A): refresh workflow.json after a
      // forwarded structure edit, reusing the guard's own credentialed client.
      const serveMirror = createMirror({ mcp: serveMcp, root: config.root, workflows: config.workflows, commitOnPull: config.commitOnPull, liveMirror: config.liveMirror, log });
      const handle = await startGuardProxy({ mcp: serveMcp, host: config.host, configDir: config.configDir, port, mirror: serveMirror, log });
      log.ok(`MCP guard-proxy listening on ${handle.url}`);
      log.info(`  forwards to ${config.host} with decanter's credentials — the agent never sees them`);
      log.info(`  blocks: update_workflow calls carrying jsCode (Code-node source is files + \`n8n-decanter push\`)`);
      log.info(`  blocks: publish_workflow when the draft carries a dangling $('…') reference (fail-closed — an unverifiable draft is not published)`);
      if (config.liveMirror) log.info(`  live mirror: refreshes workflow.json after a forwarded structure edit (liveMirror: false to disable)`);
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
      const connectMcp = createMcpClient(config, elog);
      // Live snapshot mirror (Plan 51 Part A) — same client the guard forwards with.
      const connectMirror = createMirror({ mcp: connectMcp, root: config.root, workflows: config.workflows, commitOnPull: config.commitOnPull, liveMirror: config.liveMirror, log: elog });
      await runStdioGuard({ mcp: connectMcp, host: config.host, timeoutMs: config.requestTimeoutMs, mirror: connectMirror, log: elog });
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
