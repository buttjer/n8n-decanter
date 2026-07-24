// Plan 35 — blind-agent field test: ORCHESTRATOR (dev-only, unsandboxed).
//
// Drives one or more scenarios as blind, headless `claude -p --model sonnet`
// sessions against a staged n8n, captures transcripts + the guard's stderr, and
// runs the scripted invariant verifier after each. This is the REPRODUCIBLE
// spine — it replays each scenario's linear scripted turns (the `## Orchestration`
// block in scripts/field-test/scenarios/S*.md). ADAPTIVE beats (the prose
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
//   node scripts/field-test/run.mts <manifest.json> [S1 S2 …]   # default: S1–S4
//   node scripts/field-test/run.mts <manifest.json> --dry-run    # print turns, spawn nothing
//   node scripts/field-test/run.mts --help
import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  console.log("usage: node scripts/field-test/run.mts <manifest.json> [S1 S2 …] [--dry-run]");
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
// Container mode (Plan 35): run the blind agents in a Docker container, egress
// fenced to Anthropic-only — the safe way to run them UNATTENDED (see the
// container-mode design in the plan + scripts/field-test/docker/).
const containerMode = argv.includes("--container");
const positional = argv.filter((a) => !a.startsWith("--"));
const manifestPath = positional[0] ?? process.env.FIELD_MANIFEST;
if (!manifestPath) { console.error("run: pass <manifest.json> or set FIELD_MANIFEST"); process.exit(2); }
const scenarioIds = positional.slice(1).length ? positional.slice(1) : ["S1", "S2", "S3", "S4"];

interface Manifest { host: string; container: string | null; mcpToken: string; apiKey: string; workDir: string; harnessRoot: string; root: string; allowExtension: string[]; cliTarball: string | null; decanterSpec: string | null; seeded: Array<{ id: string; name: string; kind: string; availableInMCP: boolean }>; }
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

// ---------- scenario parsing ----------
interface Scenario { id: string; turns: string[]; verifyWorkflows: string; preHook?: string; optional?: boolean; unsandboxedOnly?: boolean; persona?: string }
function loadScenario(id: string): Scenario {
  const file = path.join(SCENARIO_DIR, `${id}.md`);
  const md = readFileSync(file, "utf8");
  const m = md.match(/##\s*Orchestration[\s\S]*?```json\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`${id}.md has no \`\`\`json Orchestration block`);
  return JSON.parse(m[1]) as Scenario;
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
  if (!existsSync(ENV_FILE)) throw new Error(`--container needs ${ENV_FILE} with ANTHROPIC_API_KEY (cp scripts/field-test/.env.example scripts/field-test/.env)`);
  if (!manifest.cliTarball && !manifest.decanterSpec) throw new Error("no CLI to bake — manifest.cliTarball and decanterSpec are both null (re-stage)");

  console.log("container mode: building fenced images (unfenced build) …");
  await execFile("docker", ["build", "-t", "decanter-fieldtest-proxy", "-f", path.join(DOCKER_DIR, "Dockerfile.proxy"), DOCKER_DIR]);
  await execFile("docker", ["build", "-t", "decanter-fieldtest-agent", "-f", path.join(DOCKER_DIR, "Dockerfile.agent"), DOCKER_DIR]);
  // bake the decanter CLI into a per-run image FROM the base
  let bakeStep: string;
  if (manifest.cliTarball) {
    copyFileSync(manifest.cliTarball, path.join(DOCKER_DIR, "cli.tgz"));
    bakeStep = "USER root\nCOPY cli.tgz /tmp/cli.tgz\nRUN npm install -g --no-audit --no-fund /tmp/cli.tgz && n8n-decanter --help >/dev/null\nUSER agent";
  } else {
    bakeStep = `USER root\nRUN npm install -g --no-audit --no-fund ${manifest.decanterSpec} && n8n-decanter --help >/dev/null\nUSER agent`;
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
  // 1. merge allowExtension into the init-scaffolded settings.local.json (keep deny)
  const settingsPath = path.join(WORKDIR, ".claude", "settings.local.json");
  if (existsSync(settingsPath)) {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    s.permissions ??= {};
    s.permissions.allow = Array.from(new Set([...(s.permissions.allow ?? []), ...manifest.allowExtension]));
    writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
    console.log(`  merged allowExtension into ${settingsPath}`);
  } else {
    console.warn(`  WARN no settings.local.json after init — did init scaffold the template? (${settingsPath})`);
  }
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
 * Harness-owned, per-TURN snapshot of the workflows tree.
 *
 * Deliberately does NOT rely on the system under test for observability. The
 * workDir's git history only contains what decanter chose to auto-commit (on
 * pull/push) — so a change the agent never pushed is INVISIBLE there. Round 2's
 * S4 is the proof: the `.js`→`.ts` conversion (write .ts, re-point placeholder,
 * rm .js) was followed by `check`, never `push`, so it never reached a commit.
 * A field test must not measure with the instrument it is testing. These
 * snapshots are actor-agnostic (agent edits, pull overwrites, live-mirror
 * writes, harness drift injection all show up) and complete at a known cadence.
 * Cheap: the workflows tree is a few KB of text.
 */
function snapshotWorkflows(scenario: string, turn: number): void {
  const src = path.join(WORKDIR, "workflows");
  if (!existsSync(src)) return; // nothing pulled yet (e.g. before turn 1's init)
  const dest = path.join(HARNESS, "snapshots", scenario, `turn-${turn}`);
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  } catch (e) {
    console.warn(`  snapshot ${scenario}/turn-${turn} failed: ${(e as Error).message.split("\n")[0]}`);
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

  let sessionId: string | undefined;
  snapshotWorkflows(id, 0); // baseline, so turn 1's effect is diffable
  for (let i = 0; i < turns.length; i++) {
    console.log(`\n[${id}] turn ${i + 1}/${turns.length} ${sessionId ? `(resume ${sessionId.slice(0, 8)})` : "(new session)"}`);
    const transcript = path.join(outDir, `turn-${i + 1}.jsonl`);
    const { sessionId: sid, resultText } = await claudeTurn(fillSecrets(turns[i]), i + 1, sessionId, transcript);
    sessionId ??= sid;
    console.log(`  → ${resultText.slice(0, 200).replace(/\n/g, " ")}${resultText.length > 200 ? "…" : ""}`);
    if (i === 0) applyPostInit(); // init scaffolded .claude/ + .mcp.json — wire capture + allows now
    snapshotWorkflows(id, i + 1); // tool-independent record of what actually changed
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
async function archiveRun(): Promise<void> {
  // 1. render the HTML report (a derived VIEW) into harnessRoot
  try {
    const { stdout } = await execFile(process.execPath, [REPORT, manifestPath], { maxBuffer: 64 * 1024 * 1024 });
    if (stdout.trim()) console.log(stdout.trim());
  } catch (e) { console.warn(`report generation failed (${(e as Error).message.split("\n")[0]}) — raw artifacts are still archived below`); }
  // 2. store EVERYTHING raw to a durable, gitignored dir that teardown never
  //    touches: harnessRoot (stream-json transcripts + verify JSON + guard.log +
  //    report.html) AND the workDir WITH its .git (the turn-by-turn diffs). The
  //    RAW is the source of truth — any view (html/md/json) re-renders from it, so
  //    "what I want to see" can change later without re-running (Plan 35 §archive).
  const base = process.env.FIELD_ARCHIVE_DIR ?? path.join(process.cwd(), ".field-test-runs");
  const dest = path.join(base, path.basename(HARNESS));
  const noNodeModules = { recursive: true as const, filter: (s: string) => !/[/\\]node_modules([/\\]|$)/.test(s) };
  try {
    mkdirSync(dest, { recursive: true });
    cpSync(HARNESS, path.join(dest, "harness"), { recursive: true });
    if (existsSync(WORKDIR)) cpSync(WORKDIR, path.join(dest, "work"), noNodeModules);
    // ALSO dump the synced progression as plain text — readable without git, and a
    // hedge against the .git copy being awkward to use. (Three layers are kept on
    // purpose: transcripts = per-EDIT, .git = per-SYNC canonical, this = flat view.)
    try {
      const diff = execFileSync("git", ["-C", WORKDIR, "log", "-p", "--", "workflows"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (diff.trim()) writeFileSync(path.join(dest, "workflow-progression.diff"), diff);
    } catch { /* no git / no commits yet — the .git copy and transcripts still carry it */ }
    // a manifest whose paths point at the ARCHIVED copies, so a view re-renders
    // straight from the archive: `node scripts/field-test/report.mts <dest>/manifest.json`
    writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({ ...manifest, harnessRoot: path.join(dest, "harness"), workDir: path.join(dest, "work") }, null, 2));
    console.log(`\narchived (raw + report) -> ${dest}`);
    console.log(`  read now:                  open ${path.join(dest, "harness", "report.html")}`);
    console.log(`  re-render a view later:    node scripts/field-test/report.mts ${path.join(dest, "manifest.json")}`);
  } catch (e) { console.warn(`archive failed: ${(e as Error).message.split("\n")[0]}`); }
}

// ---------- main ----------
if (!existsSync(WORKDIR)) { console.error(`workDir missing: ${WORKDIR} — run stage.mts first`); process.exit(2); }

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
