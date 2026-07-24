// Plan 35 — blind-agent field test: ORCHESTRATOR (dev-only, unsandboxed).
//
// Drives one or more scenarios as blind, headless `claude -p --model sonnet`
// sessions against a staged n8n, captures transcripts + the guard's stderr, and
// runs the scripted invariant verifier after each. This is the REPRODUCIBLE
// spine — it replays each scenario's linear scripted turns (the `## Orchestration`
// block in test/field-test/scenarios/S*.md). ADAPTIVE beats (the prose
// "Beats" sections) are for a live orchestrator/grader to layer on; a fully
// deterministic script cannot judge "did the agent stall". GRADING (Opus over
// transcripts) is a separate, unblinded pass.
//
// Blind-run mechanics (verified against the current CLI in the validation pass):
//   - each turn is `claude -p "<msg>" --model sonnet --output-format stream-json
//     --verbose` run in the scratch workDir (the agent's cwd)
//   - turn 1 carries a generous --allowedTools bootstrap set (permission-UX is
//     out of scope; the template DENY rules still apply); the session id is read
//     from the stream, and turns 2..n use `--resume <id>` (fresh process, re-reads
//     .claude/ + .mcp.json from cwd each turn)
//   - AFTER turn 1 (init): merge the manifest's allowExtension into the
//     init-scaffolded .claude/settings.local.json (deny rules preserved) and
//     rewrite .mcp.json's n8n-instance command to capture the guard's stderr:
//     `sh -c 'n8n-decanter mcp connect 2>><harnessRoot>/guard.log'`
//
// Usage:
//   node test/field-test/run.mts <manifest.json> [S1 S2 …]   # default: S1–S4
//   node test/field-test/run.mts <manifest.json> --dry-run    # print turns, spawn nothing
//   node test/field-test/run.mts --help
import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SESSION_START_NUDGE } from "./skills-install.mts";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, "scenarios");
const VERIFY = path.join(HERE, "verify.mts");
const REPORT = path.join(HERE, "report.mts");

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node test/field-test/run.mts <manifest.json> [S1 S2 …] [--dry-run]");
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
// Container mode (Plan 35): run the blind agents in a Docker container, egress
// fenced to Anthropic-only — the safe way to run them UNATTENDED (see the
// container-mode design in the plan + test/field-test/docker/).
const containerMode = argv.includes("--container");
const positional = argv.filter((a) => !a.startsWith("--"));
const manifestPath = positional[0] ?? process.env.FIELD_MANIFEST;
if (!manifestPath) { console.error("run: pass <manifest.json> or set FIELD_MANIFEST"); process.exit(2); }
const scenarioIds = positional.slice(1).length ? positional.slice(1) : ["S1", "S2", "S3", "S4"];

interface Manifest { createdAt?: string; host: string; container: string | null; mcpToken: string; apiKey: string; workDir: string; harnessRoot: string; root: string; allowExtension: string[]; cliTarball: string | null; decanterSpec: string | null; seeded: Array<{ id: string; name: string; kind: string; availableInMCP: boolean }>; }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const WORKDIR = manifest.workDir;
const HARNESS = manifest.harnessRoot;
const GUARD_LOG = path.join(HARNESS, "guard.log");

// container-mode constants
const DOCKER_DIR = path.join(HERE, "docker");
const COMPOSE = path.join(DOCKER_DIR, "docker-compose.yml");
const ENV_FILE = path.join(HERE, ".env"); // gitignored; holds ANTHROPIC_API_KEY
const INTERNAL_NET = "decanter-fieldtest_internal"; // compose project + network
const RUN_BUDGET_MS = Math.max(1, Number(process.env.FIELD_RUN_BUDGET_MIN ?? 60)) * 60_000;
/** FIELD_* vars compose interpolates on EVERY subcommand — set by containerSetup. */
let composeEnv: Record<string, string> = {};
/**
 * Seed the sync dir's node_modules IN THE IMAGE, so nothing ever needs
 * `npm install` inside the fence (the npm registry is unreachable there) and the
 * volume — which Docker initializes from this path — is agent-owned. Round-2 S1
 * hit `EACCES … /work/node_modules/@esbuild` and spent turns fixing OUR bug.
 * A Linux n8n-decanter goes where `npm run <script>` looks first; typescript
 * where the CLI's typecheck resolver looks.
 */
const SEED_NODE_MODULES = [
  "RUN mkdir -p /work/node_modules/.bin \\",
  ' && ln -sf "$(command -v n8n-decanter)" /work/node_modules/.bin/n8n-decanter \\',
  " && ln -sf /usr/local/lib/node_modules/typescript /work/node_modules/typescript \\",
  " && chown -R agent:agent /work",
].join("\n");

// ---------- scenario parsing ----------
interface Scenario { id: string; turns: string[]; verifyWorkflows: string; preHook?: string; optional?: boolean; unsandboxedOnly?: boolean; persona?: string; requires?: string[] }
function loadScenario(id: string): Scenario {
  const file = path.join(SCENARIO_DIR, `${id}.md`);
  const md = readFileSync(file, "utf8");
  const m = md.match(/##\s*Orchestration[\s\S]*?```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${id}.md has no \`\`\`json Orchestration block`);
  return JSON.parse(m[1]) as Scenario;
}

/**
 * Refuse a scenario subset whose prerequisites are missing — BEFORE spending.
 *
 * Some scenarios act on state an earlier one built: S4 opens with "let's tidy
 * *the orders workflow* … the step that tags high value", which is the workflow
 * **S2 creates**. A full S1–S4 round satisfies that implicitly, so the coupling
 * stayed invisible until someone ran a subset.
 *
 * Run `S4` alone and the round is not merely wrong, it is wrong in the most
 * expensive way: the agent hunts for a workflow that does not exist, never
 * pulls, and `verify.mts` reports "no tracked workflow folders" — a FAIL that
 * reads like a product defect but is an operator error. That happened
 * (ftrun-93355, $0.70 burned for zero signal).
 *
 * So: declare the dependency in the scenario spine and check it here. Refusing
 * beats silently auto-including the prerequisite, which would double the spend
 * without asking.
 */
function assertPrerequisites(ids: string[]): void {
  const problems: string[] = [];
  ids.forEach((id, i) => {
    const earlier = new Set(ids.slice(0, i));
    for (const need of loadScenario(id).requires ?? []) {
      if (!earlier.has(need)) problems.push(`${id} requires ${need} to run first (it acts on state ${need} creates)`);
    }
  });
  if (problems.length === 0) return;
  const suggested = [...new Set(ids.flatMap((id) => [...(loadScenario(id).requires ?? []), id]))];
  // plain message + exit 2, like the other preconditions — a stack trace here
  // would bury the one line that tells the operator what to run instead
  console.error("scenario prerequisites unmet — nothing was spent:");
  for (const p of problems) console.error(`  ${p}`);
  console.error(`try: node test/field-test/run.mts <manifest> ${suggested.join(" ")}`);
  process.exit(2);
}

// Non-secret placeholders — safe to log / dry-run print / store in the turns
// array. The credential placeholders stay UNfilled here so no log path ever
// emits them in clear text.
function fillPublic(text: string): string {
  const oldFlow = manifest.seeded.find((s) => s.kind === "s4-archive-target")?.name ?? "Old contact import";
  return text.replaceAll("{{HOST}}", manifest.host).replaceAll("{{OLD_FLOW_NAME}}", oldFlow);
}
// Credential placeholders — substituted ONLY at the moment of spawning claude,
// on a string that is never logged or stored (avoids clear-text-logging of the
// MCP token / API key that the S1 prompt carries).
function fillSecrets(text: string): string {
  return text.replaceAll("{{MCP_TOKEN}}", manifest.mcpToken).replaceAll("{{API_KEY}}", manifest.apiKey || "(none — skip it)");
}

// ---------- the one credential that crosses the fence ----------
/** Minimal KEY=VALUE reader for the harness `.env` (no deps; ignores comments). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Choose the single auth credential passed into the fenced container.
 *
 * Two accepted shapes, both plain env vars — which is what keeps the isolation
 * contract intact: no mounted credential store, no browser inside the fence.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` — a Claude subscription token (`claude
 *     setup-token`). Costs quota from your 5-hour windows instead of dollars.
 *   - `ANTHROPIC_API_KEY` — pay-per-token API billing. Scope it with a LOW
 *     spend cap; that cap is a backstop a subscription token does NOT have,
 *     so with a token `FIELD_RUN_BUDGET_MIN` is the only limit left.
 *
 * Exactly ONE is exported, never both and never an empty one: an empty
 * `ANTHROPIC_API_KEY` in the container is worse than an absent one, because the
 * CLI would try to use it. The token wins when both are present.
 */
function credentialEnv(): { env: Record<string, string>; described: string } {
  const file = readEnvFile(ENV_FILE);
  const pick = (name: string) => (file[name] ?? process.env[name] ?? "").trim();
  const token = pick("CLAUDE_CODE_OAUTH_TOKEN");
  const key = pick("ANTHROPIC_API_KEY");
  if (token) {
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, described: `subscription token${key ? " (ANTHROPIC_API_KEY also set — ignored)" : ""} — billed as quota, no spend cap; FIELD_RUN_BUDGET_MIN is the limit` };
  }
  if (key) return { env: { ANTHROPIC_API_KEY: key }, described: "API key — pay-per-token" };
  throw new Error(`--container needs a credential in ${ENV_FILE}: CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`) or ANTHROPIC_API_KEY (cp test/field-test/.env.example test/field-test/.env)`);
}

// ---------- container-mode orchestration (Plan 35: fenced, unattended) ----------
/** `docker compose` with the fixed -f/--env-file + the interpolation env. */
async function dockerCompose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile("docker", ["compose", "-f", COMPOSE, "--env-file", ENV_FILE, ...args], { env: { ...process.env, ...composeEnv }, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Build the fenced images, bake the CLI in (build-time — the runtime fence has
 * no npm), bring up proxy+agent, rewrite the workDir `.env` to reach n8n by its
 * in-network name, and join the staged n8n to the internal net. Arms a total
 * wall-clock kill so an unattended round can't run (or bill) forever.
 */
async function containerSetup(): Promise<void> {
  if (!manifest.container) throw new Error("--container needs a Docker-booted n8n (manifest.container is null — external/FIELD_N8N_URL mode is host-only)");
  const cred = credentialEnv(); // throws with the fix-it message when neither is set
  console.log(`container mode: auth = ${cred.described}`);
  if (!manifest.cliTarball && !manifest.decanterSpec) throw new Error("no CLI to bake — manifest.cliTarball and decanterSpec are both null (re-stage)");

  console.log("container mode: building fenced images (unfenced build) …");
  await execFile("docker", ["build", "-t", "decanter-fieldtest-proxy", "-f", path.join(DOCKER_DIR, "Dockerfile.proxy"), DOCKER_DIR]);
  await execFile("docker", ["build", "-t", "decanter-fieldtest-agent", "-f", path.join(DOCKER_DIR, "Dockerfile.agent"), DOCKER_DIR]);
  // bake the decanter CLI into a per-run image FROM the base
  let bakeStep: string;
  if (manifest.cliTarball) {
    copyFileSync(manifest.cliTarball, path.join(DOCKER_DIR, "cli.tgz"));
    bakeStep = `USER root\nCOPY cli.tgz /tmp/cli.tgz\nRUN npm install -g --no-audit --no-fund /tmp/cli.tgz && n8n-decanter --help >/dev/null\n${SEED_NODE_MODULES}\nUSER agent`;
  } else {
    bakeStep = `USER root\nRUN npm install -g --no-audit --no-fund ${manifest.decanterSpec} && n8n-decanter --help >/dev/null\n${SEED_NODE_MODULES}\nUSER agent`;
  }
  const AGENT_IMAGE = "decanter-fieldtest-agent-run";
  writeFileSync(path.join(DOCKER_DIR, "Dockerfile.agent-baked"), `# generated by run.mts — bakes the decanter CLI into the fenced agent image\nFROM decanter-fieldtest-agent\n${bakeStep}\n`);
  await execFile("docker", ["build", "-t", AGENT_IMAGE, "-f", path.join(DOCKER_DIR, "Dockerfile.agent-baked"), DOCKER_DIR]);
  console.log(`  baked CLI into ${AGENT_IMAGE}`);

  composeEnv = {
    FIELD_AGENT_IMAGE: AGENT_IMAGE,
    FIELD_WORKDIR: WORKDIR,
    FIELD_HARNESS: HARNESS,
    // n8n (by container name) + loopback bypass the proxy — they're on the internal net
    FIELD_NO_PROXY: `${manifest.container},localhost,127.0.0.1`,
    // the chosen credential, exported to the compose child so the bare
    // pass-through entries in docker-compose.yml resolve deterministically
    // (rather than depending on --env-file semantics for un-valued names)
    ...cred.env,
  };

  // the agent reaches n8n by its container name on the internal net (the host's
  // published port stays manifest.host for host-side verify.mts)
  const inNet = `http://${manifest.container}:5678`;
  const envPath = path.join(WORKDIR, ".env");
  if (existsSync(envPath)) {
    writeFileSync(envPath, readFileSync(envPath, "utf8").replace(/^N8N_HOST=.*$/m, `N8N_HOST=${inNet}`));
    console.log(`  rewrote .env N8N_HOST -> ${inNet}`);
  } else {
    console.warn(`  no ${envPath} — the agent's init must supply the in-network host (avoid FIELD_NO_SEED_ENV in container mode)`);
  }

  await dockerCompose(["up", "-d"]);
  await execFile("docker", ["network", "connect", INTERNAL_NET, manifest.container]).catch((e: Error) => {
    if (!/already |Error response.*already/i.test(e.message)) throw e; // idempotent re-connect
  });
  console.log(`  up: proxy + agent (fenced); n8n ${manifest.container} joined ${INTERNAL_NET}`);

  const kill = setTimeout(() => {
    console.error(`\n[harness] FIELD_RUN_BUDGET_MIN (${RUN_BUDGET_MS / 60000}m) exceeded — killing the run + tearing down`);
    void containerTeardown().finally(() => process.exit(2));
  }, RUN_BUDGET_MS);
  kill.unref();
}

async function containerTeardown(): Promise<void> {
  if (!containerMode || Object.keys(composeEnv).length === 0) return; // setup didn't run (dry-run / early failure)
  if (manifest.container) await execFile("docker", ["network", "disconnect", INTERNAL_NET, manifest.container]).catch(() => {});
  await dockerCompose(["down", "-v"]).catch(() => {});
  console.log("container mode: torn down (compose down -v)");
}

// ---------- post-init scaffolding tweaks (guard-log capture + allow extension) ----------
function applyPostInit(): void {
  // 1. merge allowExtension into the LOCAL settings layer — the harness's own
  //    (highest precedence). Never the template's settings.json: that is the
  //    project contract whose DENY rules (push --force, .decanter.json, .env)
  //    are under test, and deny wins over allow regardless of layer. Created
  //    when absent, so this holds whichever filename the template ships.
  const settingsPath = path.join(WORKDIR, ".claude", "settings.local.json");
  let s: { permissions?: { allow?: string[] } } = {};
  try {
    s = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof s;
  } catch { /* absent or unreadable — start fresh */ }
  s.permissions ??= {};
  s.permissions.allow = Array.from(new Set([...(s.permissions.allow ?? []), ...manifest.allowExtension]));
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  console.log(`  merged allowExtension into ${settingsPath}`);
  // 2. rewrite .mcp.json's n8n-instance command to capture the guard's stderr
  const mcpPath = path.join(WORKDIR, ".mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    const srv = mcp.mcpServers?.["n8n-instance"];
    if (srv && srv.command === "n8n-decanter") {
      const inner = ["n8n-decanter", ...(srv.args ?? [])].join(" ");
      // container mode redirects to the harnessRoot's bind-mount inside the agent
      // (/harness) so the guard stderr still lands in HARNESS on the host.
      const guardTarget = containerMode ? "/harness/guard.log" : GUARD_LOG;
      mcp.mcpServers["n8n-instance"] = { command: "sh", args: ["-c", `exec ${inner} 2>>${guardTarget}`] };
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
      console.log(`  rewired .mcp.json n8n-instance to capture stderr -> ${guardTarget}`);
    }
  } else {
    console.warn(`  WARN no .mcp.json after init (${mcpPath})`);
  }
  // 3. reproduce the pack's SessionStart routing cue (plain-skills installs have
  //    no SessionStart hook) by appending it to the init-scaffolded AGENTS.md
  const agentsPath = path.join(WORKDIR, "AGENTS.md");
  if (existsSync(agentsPath) && !readFileSync(agentsPath, "utf8").includes("using-n8n-skills-official")) {
    appendFileSync(agentsPath, SESSION_START_NUDGE);
    console.log("  appended the n8n-skills SessionStart cue to AGENTS.md");
  }
}

// ---------- pre-hooks (harness plays a second client) ----------
async function remoteDrift(): Promise<void> {
  // S3: a colleague edits a Code node's jsCode directly over raw MCP (guard-free).
  const target = manifest.seeded.find((s) => s.kind === "s1-skeleton" && s.availableInMCP)
    ?? manifest.seeded.find((s) => s.availableInMCP);
  if (!target) { console.warn("  remote-drift: no available seeded workflow to edit"); return; }
  const { McpClient } = await import(new URL("../../lib/mcp.mts", import.meta.url).href);
  const client = new McpClient({ host: manifest.host, auth: { kind: "bearer", token: manifest.mcpToken }, requestTimeoutMs: 20_000 });
  const details = (await client.callTool("get_workflow_details", { workflowId: target.id })) as { workflow: { nodes: Array<{ name: string; type: string; parameters?: { jsCode?: string } }> } };
  const code = details.workflow.nodes.find((n) => n.type === "n8n-nodes-base.code" && typeof n.parameters?.jsCode === "string");
  if (!code) { console.warn("  remote-drift: target has no Code node"); return; }
  const edited = `// Sam was here\n${code.parameters!.jsCode}`;
  await client.callTool("update_workflow", { workflowId: target.id, operations: [{ type: "updateNodeParameters", nodeName: code.name, parameters: { jsCode: edited } }] });
  console.log(`  remote-drift: colleague edited "${code.name}" in "${target.name}" (${target.id}) over raw MCP`);
}

// ---------- one blind claude -p turn ----------
const TURN_TIMEOUT_MS = Number(process.env.FIELD_TURN_TIMEOUT_MS ?? 900_000); // 15 min/turn safety net
async function claudeTurn(msg: string, turnIndex: number, resumeId: string | undefined, transcript: string): Promise<{ sessionId: string | undefined; resultText: string }> {
  const args = ["-p", msg, "--model", "sonnet", "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.push("--resume", resumeId);
  // Broad "consenting user" grant on EVERY turn (permission-UX is out of scope,
  // Plan 35). The settings.local.json DENY rules still win (push --force,
  // .decanter.json, .env) once init scaffolds them, and the jsCode-over-MCP block
  // is enforced by the mcp connect guard itself, not by permissions.
  args.push("--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,TodoWrite,mcp__n8n-instance,mcp__n8n-docs");
  return await new Promise((resolve, reject) => {
    let proc: import("node:child_process").ChildProcessWithoutNullStreams;
    if (containerMode) {
      // each turn is a `docker exec` into the long-lived fenced agent container;
      // it already carries ANTHROPIC_API_KEY / HTTPS_PROXY / NO_PROXY + the baked
      // CLI on PATH, and cwd /work is the bind-mounted sync dir. -T = no TTY (pipe).
      proc = spawn("docker", ["compose", "-f", COMPOSE, "--env-file", ENV_FILE, "exec", "-T", "-w", "/work", "agent", "claude", ...args], { env: { ...process.env, ...composeEnv } });
    } else {
      // Prepend the workDir's node_modules/.bin so a bare `n8n-decanter` (in the
      // agent's Bash and in the guard's .mcp.json command, both spawned by claude)
      // resolves to the WORKDIR-LOCAL install — no global npm link needed.
      const localBin = path.join(WORKDIR, "node_modules", ".bin");
      const env = { ...process.env, PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ""}` };
      proc = spawn("claude", args, { cwd: WORKDIR, env });
    }
    let buf = "";
    let sessionId: string | undefined;
    let resultText = "";
    const lines: string[] = [];
    const timer = setTimeout(() => { lines.push(`[harness] turn ${turnIndex} exceeded ${TURN_TIMEOUT_MS}ms — killing`); proc.kill("SIGKILL"); }, TURN_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        lines.push(line);
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) sessionId = ev.session_id;
          if (ev.type === "result" && typeof ev.result === "string") resultText = ev.result;
        } catch { /* non-JSON line — keep raw */ }
      }
    });
    proc.stderr.on("data", (c: Buffer) => lines.push(`[stderr] ${c.toString().trimEnd()}`));
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(transcript, lines.join("\n") + "\n");
      if (code !== 0 && !resultText) reject(new Error(`claude turn ${turnIndex} exited ${code} (see ${transcript})`));
      else resolve({ sessionId, resultText });
    });
  });
}

/**
 * Harness-owned commit of the workflows tree after each turn.
 *
 * Observability must not depend on the system under test: decanter only
 * auto-commits on pull/push, so a change the agent never pushed is invisible in
 * git — round-2 S4's .js→.ts conversion (write .ts, re-point placeholder, rm .js,
 * then `check` instead of `push`) was exactly that. Committing HERE gives
 * per-TURN granularity that is actor-agnostic (agent edits, pull overwrites,
 * live-mirror writes, drift injection all land), while reusing git's
 * baseline+delta format instead of copying the tree once per turn. Scoped to
 * `workflows/` so the scaffold — identical in every run — never bloats the archive.
 */
function commitTurn(scenario: string, turn: number): void {
  if (!existsSync(path.join(WORKDIR, "workflows"))) return; // nothing pulled yet
  try {
    execFileSync("git", ["-C", WORKDIR, "add", "--", "workflows"], { stdio: "ignore" });
    const staged = execFileSync("git", ["-C", WORKDIR, "diff", "--cached", "--name-only", "--", "workflows"], { encoding: "utf8" }).trim();
    if (!staged) return; // nothing changed this turn — no empty commits
    execFileSync("git", ["-C", WORKDIR, "commit", "-q", "-m", `harness: ${scenario} after turn ${turn}`], { stdio: "ignore" });
  } catch (e) {
    console.warn(`  turn commit ${scenario}/turn-${turn} failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

// ---------- run one scenario ----------
async function runScenario(id: string): Promise<{ id: string; verifyExit: number | null; turns: number }> {
  const scn = loadScenario(id);
  const outDir = path.join(HARNESS, "transcripts", id);
  mkdirSync(outDir, { recursive: true });
  const turns = scn.turns.map(fillPublic); // credential placeholders stay unfilled (never logged)
  console.log(`\n########## ${id} — ${scn.persona ?? ""} ##########`);
  if (dryRun) {
    turns.forEach((t, i) => { console.log(`\n--- turn ${i + 1} ---\n${t}`); });
    return { id, verifyExit: null, turns: turns.length };
  }

  if (scn.preHook === "remote-drift") await remoteDrift();

  // The STAGE now pre-runs `init`, so .claude/ + .mcp.json exist before the agent
  // starts — wire the allow-extension + guard-stderr capture up front (idempotent,
  // so re-running it per scenario is harmless).
  applyPostInit();
  let sessionId: string | undefined;
  commitTurn(id, 0); // baseline commit, so turn 1's effect is diffable
  for (let i = 0; i < turns.length; i++) {
    console.log(`\n[${id}] turn ${i + 1}/${turns.length} ${sessionId ? `(resume ${sessionId.slice(0, 8)})` : "(new session)"}`);
    const transcript = path.join(outDir, `turn-${i + 1}.jsonl`);
    // The prompt is passed as argv, so it appears NOWHERE in the stream-json
    // transcript (its `user` events are tool results). Record it verbatim —
    // public-filled, secrets still placeholders — so a round's prompts are a fact
    // of the round, not something re-derived from scenario files that move on.
    writeFileSync(path.join(outDir, `turn-${i + 1}.prompt.txt`), `${turns[i]}\n`);
    const { sessionId: sid, resultText } = await claudeTurn(fillSecrets(turns[i]), i + 1, sessionId, transcript);
    sessionId ??= sid;
    console.log(`  → ${resultText.slice(0, 200).replace(/\n/g, " ")}${resultText.length > 200 ? "…" : ""}`);
    commitTurn(id, i + 1); // tool-independent, per-turn record of what actually changed
  }

  // scripted invariant verifier
  const verifyOut = path.join(HARNESS, `verify-${id}.json`);
  let verifyExit: number | null = null;
  try {
    const { stdout, stderr } = await execFile(process.execPath, [VERIFY, manifestPath, "--scenario", id, "--out", verifyOut], { encoding: "utf8" });
    console.log(stdout + stderr);
    verifyExit = 0;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    console.log((e.stdout ?? "") + (e.stderr ?? ""));
    verifyExit = e.code ?? 1;
  }
  return { id, verifyExit, turns: turns.length };
}

// ---------- archive: render the HTML view + STORE EVERYTHING RAW (survives teardown) ----------
//
// Archives land in `test/field-test/runs/<iso>-<runId>/` and are COMMITTED —
// that, not a path outside the worktree, is what makes them prune-proof: a
// `git worktree remove` can't take a committed run with it, and a round's
// findings stay reviewable in the PR that produced them. `raw.tgz` is the
// source of truth (any view re-renders from it); `report.html` sits next to it
// so the run is readable straight from the repo. Both must be committed before
// the worktree is removed — `run.mts` deliberately does NOT commit for you.
/** Scrub run credentials from a text artifact — the archive is COMMITTED. */
function scrubFile(file: string, secrets: string[]): void {
  try {
    let text = readFileSync(file, "utf8");
    let hit = false;
    for (const s of secrets) if (text.includes(s)) { text = text.split(s).join("‹redacted›"); hit = true; }
    if (hit) writeFileSync(file, text);
  } catch { /* binary or unreadable — nothing to scrub */ }
}
function scrubTree(dir: string, secrets: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scrubTree(p, secrets);
    else scrubFile(p, secrets);
  }
}

async function archiveRun(): Promise<void> {
  // Assemble the RAW payload, then commit it compressed next to the harness.
  //    Only what a view actually needs, and each fact stored ONCE:
  //      transcripts/  — the conversation + every agent edit (per-EDIT record)
  //      work.git      — a BARE clone: the whole workflows/ history as
  //                      baseline+deltas (per-TURN harness commits + decanter's
  //                      own), which is git's job and replaces the old per-turn
  //                      tree copies, the flat .diff dump and the workDir copy
  //      verify-*.json / guard.log / manifest.json
  //    Deliberately NOT archived: the working tree (reconstructable from
  //    work.git) and the vendored skills pack (identical every run; provenance
  //    lives in manifest.skills).
  // harnessRoot is `…/ftrun-<pid>` for a live run, but a re-archived older run
  // may sit a level down (`…/ftrun-<pid>/harness`) — take the id, not the leaf
  const runId = HARNESS.split(path.sep).reverse().find((s) => /^ftrun-\d+$/.test(s)) ?? path.basename(HARNESS);
  // the RUN's time, not the archive's — so a re-archive (--archive) of an old
  // round keeps its original identity instead of minting a second dated dir
  const stamp = (manifest.createdAt ?? new Date().toISOString()).replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
  const dest = process.env.FIELD_ARCHIVE_DIR ?? path.join(HERE, "runs", `${stamp}-${runId}`);
  const staging = path.join(HARNESS, "__raw");
  const secrets = [manifest.mcpToken, manifest.apiKey].filter((s) => typeof s === "string" && s.length > 8);
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    if (existsSync(path.join(HARNESS, "transcripts"))) cpSync(path.join(HARNESS, "transcripts"), path.join(staging, "transcripts"), { recursive: true });
    // the scenario files AS RUN — the report renders each turn's prompt from
    // them, so without a copy an archived round would re-render against whatever
    // the scenarios say today (they get reworked between rounds; that's the point
    // of a round). This is the run's input; the transcripts are its output.
    cpSync(SCENARIO_DIR, path.join(staging, "scenarios"), { recursive: true });
    for (const f of readdirSync(HARNESS)) {
      if (/^verify-.*\.json$/.test(f) || f === "guard.log") copyFileSync(path.join(HARNESS, f), path.join(staging, f));
    }
    // committed-history only — no working tree, no node_modules, no scaffold
    if (existsSync(path.join(WORKDIR, ".git"))) {
      execFileSync("git", ["clone", "--quiet", "--bare", WORKDIR, path.join(staging, "work.git")], { stdio: "ignore" });
    }
    // the manifest travels WITHOUT credentials (this lands in git). `scenariosAsRun`
    // is false when re-archiving an older round: the scenarios/ copy is then
    // today's, not provably the ones that ran, and the report says so.
    writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ ...manifest, mcpToken: "‹redacted›", apiKey: "‹redacted›", scenariosAsRun: !argv.includes("--archive") }, null, 2) + "\n");
    scrubTree(staging, secrets); // transcripts/guard.log may echo a token in tool output

    mkdirSync(dest, { recursive: true });
    const tgz = path.join(dest, "raw.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", staging, "."], { stdio: "ignore" });
    rmSync(staging, { recursive: true, force: true });
    // Render the shipped view FROM the tarball, not from the live run. Two
    // reasons: the committed report is then provably what the raw yields (every
    // round self-tests its own archive), and rendering after packing means a
    // renderer failure can no longer cost us the raw.
    try {
      const { stdout } = await execFile(process.execPath, [REPORT, "--from", tgz, "--out", path.join(dest, "report.html")], { maxBuffer: 64 * 1024 * 1024 });
      if (stdout.trim()) console.log(stdout.trim());
    } catch (e) { console.warn(`report generation failed (${(e as Error).message.split("\n")[0]}) — the raw archive is intact; re-render with --from`); }
    console.log(`\narchived (committed) -> ${dest}`);
    console.log(`  read now:               open ${path.join(dest, "report.html")}`);
    console.log(`  re-render from the raw: node test/field-test/report.mts --from ${path.join(dest, "raw.tgz")}`);
  } catch (e) { console.warn(`archive failed: ${(e as Error).message.split("\n")[0]}`); }
}

// ---------- main ----------
// re-archive an already-finished round without re-running it (recovery path when
// archiving failed, and how the archive mechanics get exercised for $0)
if (argv.includes("--archive")) { await archiveRun(); process.exit(0); }

if (!existsSync(WORKDIR)) { console.error(`workDir missing: ${WORKDIR} — run stage.mts first`); process.exit(2); }

// Gate the subset BEFORE the image build and long before any claude turn — the
// whole value of this check is that it costs nothing when it fires.
const diagnosticOnly = argv.includes("--precheck") || argv.includes("--netcheck") || argv.includes("--smoke");
if (!diagnosticOnly) assertPrerequisites(scenarioIds);

let exitCode = 0;
if (containerMode && !dryRun) await containerSetup();
const deadline = Date.now() + RUN_BUDGET_MS; // budget starts AFTER the build/setup
/** The n8n URL the agent uses — in-network name in container mode, host URL otherwise. */
const agentN8n = containerMode ? `http://${manifest.container}:5678` : manifest.host;
try {
  if (argv.includes("--precheck")) {
    // container-mode plumbing check, NO claude spend: the baked CLI loads and
    // the fenced agent reaches n8n on the internal net.
    if (!containerMode) { console.error("--precheck is container-mode only (add --container)"); exitCode = 2; }
    else {
      const exec = async (label: string, cmd: string): Promise<boolean> => {
        try { const { stdout, stderr } = await dockerCompose(["exec", "-T", "-w", "/work", "agent", "sh", "-c", cmd]); console.log(`  ✓ ${label}: ${(stdout + stderr).trim().split("\n").slice(-1)[0].slice(0, 160)}`); return true; }
        catch (e) { console.error(`  ✗ ${label}: ${(e as Error).message.split("\n").slice(-2).join(" ").slice(0, 200)}`); return false; }
      };
      console.log("precheck: baked CLI + in-network n8n reachability (no claude spend) …");
      const a = await exec("baked CLI loads", "n8n-decanter --help >/dev/null && echo loaded-ok");
      const b = await exec("n8n /healthz reachable", `curl -s -o /dev/null -w '%{http_code}' ${agentN8n}/healthz`);
      exitCode = a && b ? 0 : 1;
      console.log(exitCode === 0 ? "precheck OK — plumbing works; ready for a scenario run" : "precheck FAILED — inspect above");
    }
  } else if (argv.includes("--netcheck")) {
    // prove the blind session can REACH n8n (host mode: sandbox off; container
    // mode: on the internal net). One claude turn that curls n8n's /healthz.
    mkdirSync(path.join(HARNESS, "transcripts"), { recursive: true });
    console.log(`netcheck: asking a claude -p turn to curl ${agentN8n}/healthz …`);
    try {
      const { resultText } = await claudeTurn(`Run exactly this shell command and reply with ONLY its raw output and nothing else: curl -s -o /dev/null -w '%{http_code}' ${agentN8n}/healthz`, 0, undefined, path.join(HARNESS, "netcheck.jsonl"));
      const ok = /200/.test(resultText);
      console.log(`netcheck: n8n /healthz -> ${JSON.stringify(resultText.trim()).slice(0, 120)} — ${ok ? "REACHABLE" : "NOT reachable"}`);
      exitCode = ok ? 0 : 1;
    } catch (err) { console.error(`netcheck FAILED: ${(err as Error).message}`); exitCode = 1; }
  } else if (argv.includes("--smoke")) {
    // cheapest validation that a headless claude -p turn works (auth, --model,
    // stream-json parsing, session_id capture) before spending a full scenario.
    mkdirSync(path.join(HARNESS, "transcripts"), { recursive: true });
    console.log(`smoke: spawning one claude -p turn ${containerMode ? "in the fenced container" : `in ${WORKDIR}`} …`);
    try {
      const { sessionId, resultText } = await claudeTurn("Reply with exactly the word READY and nothing else.", 0, undefined, path.join(HARNESS, "smoke.jsonl"));
      const ok = !!sessionId && /READY/i.test(resultText);
      console.log(`smoke: session=${sessionId ?? "(none)"} result=${JSON.stringify(resultText).slice(0, 160)}`);
      console.log(ok ? "smoke OK — headless claude works; safe to run scenarios" : "smoke INCONCLUSIVE — inspect " + path.join(HARNESS, "smoke.jsonl"));
      exitCode = ok ? 0 : 1;
    } catch (err) { console.error(`smoke FAILED: ${(err as Error).message}`); exitCode = 1; }
  } else {
    console.log(`orchestrating ${scenarioIds.join(", ")} against ${manifest.host}${containerMode ? " (fenced container)" : ""}\n  workDir ${WORKDIR}\n  guard.log ${GUARD_LOG}`);
    const summary: Array<{ id: string; verifyExit: number | null; turns: number }> = [];
    for (const id of scenarioIds) {
      if (containerMode && !dryRun && Date.now() > deadline) { console.error(`[harness] run budget exhausted — stopping before ${id}`); exitCode = 2; break; }
      summary.push(await runScenario(id));
    }
    console.log("\n=== run summary ===");
    for (const r of summary) console.log(`  ${r.id}: ${r.turns} turns, verify ${r.verifyExit === 0 ? "PASS" : r.verifyExit === null ? "(dry-run)" : "FAIL"}`);
    if (existsSync(GUARD_LOG)) console.log(`\nguard stderr captured -> ${GUARD_LOG}`);
    console.log(`transcripts -> ${path.join(HARNESS, "transcripts")}`);
    console.log("\nNext: grade transcripts (Opus, unblinded) + contamination check, then append the run report to plans/open/35-blind-agent-field-test.md");
    if (!dryRun) await archiveRun(); // auto-render + archive BEFORE any teardown
  }
} finally {
  await containerTeardown();
}
process.exit(exitCode);
