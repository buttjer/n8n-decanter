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
import { execFile as execFileCb, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SESSION_START_NUDGE } from "./skills-install.mts";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, "scenarios");
const VERIFY = path.join(HERE, "verify.mts");

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node scripts/field-test/run.mts <manifest.json> [S1 S2 …] [--dry-run]");
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
const positional = argv.filter((a) => !a.startsWith("--"));
const manifestPath = positional[0] ?? process.env.FIELD_MANIFEST;
if (!manifestPath) { console.error("run: pass <manifest.json> or set FIELD_MANIFEST"); process.exit(2); }
const scenarioIds = positional.slice(1).length ? positional.slice(1) : ["S1", "S2", "S3", "S4"];

interface Manifest { host: string; mcpToken: string; apiKey: string; workDir: string; harnessRoot: string; root: string; allowExtension: string[]; seeded: Array<{ id: string; name: string; kind: string; availableInMCP: boolean }>; }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const WORKDIR = manifest.workDir;
const HARNESS = manifest.harnessRoot;
const GUARD_LOG = path.join(HARNESS, "guard.log");

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
      mcp.mcpServers["n8n-instance"] = { command: "sh", args: ["-c", `exec ${inner} 2>>${GUARD_LOG}`] };
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
      console.log(`  rewired .mcp.json n8n-instance to capture stderr -> ${GUARD_LOG}`);
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
async function claudeTurn(msg: string, turnIndex: number, resumeId: string | undefined, transcript: string): Promise<{ sessionId: string | undefined; resultText: string }> {
  const args = ["-p", msg, "--model", "sonnet", "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.push("--resume", resumeId);
  else args.push("--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,TodoWrite,mcp__n8n-instance,mcp__n8n-docs");
  return await new Promise((resolve, reject) => {
    const proc = spawn("claude", args, { cwd: WORKDIR, env: { ...process.env } });
    let buf = "";
    let sessionId: string | undefined;
    let resultText = "";
    const lines: string[] = [];
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
    proc.on("error", reject);
    proc.on("close", (code) => {
      writeFileSync(transcript, lines.join("\n") + "\n");
      if (code !== 0 && !resultText) reject(new Error(`claude turn ${turnIndex} exited ${code} (see ${transcript})`));
      else resolve({ sessionId, resultText });
    });
  });
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
  for (let i = 0; i < turns.length; i++) {
    console.log(`\n[${id}] turn ${i + 1}/${turns.length} ${sessionId ? `(resume ${sessionId.slice(0, 8)})` : "(new session)"}`);
    const transcript = path.join(outDir, `turn-${i + 1}.jsonl`);
    const { sessionId: sid, resultText } = await claudeTurn(fillSecrets(turns[i]), i + 1, sessionId, transcript);
    sessionId ??= sid;
    console.log(`  → ${resultText.slice(0, 200).replace(/\n/g, " ")}${resultText.length > 200 ? "…" : ""}`);
    if (i === 0) applyPostInit(); // init scaffolded .claude/ + .mcp.json — wire capture + allows now
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

// ---------- main ----------
if (!existsSync(WORKDIR)) { console.error(`workDir missing: ${WORKDIR} — run stage.mts first`); process.exit(2); }
console.log(`orchestrating ${scenarioIds.join(", ")} against ${manifest.host}\n  workDir ${WORKDIR}\n  guard.log ${GUARD_LOG}`);
const summary: Array<{ id: string; verifyExit: number | null; turns: number }> = [];
for (const id of scenarioIds) summary.push(await runScenario(id));

console.log("\n=== run summary ===");
for (const r of summary) console.log(`  ${r.id}: ${r.turns} turns, verify ${r.verifyExit === 0 ? "PASS" : r.verifyExit === null ? "(dry-run)" : "FAIL"}`);
if (existsSync(GUARD_LOG)) console.log(`\nguard stderr captured -> ${GUARD_LOG}`);
console.log(`transcripts -> ${path.join(HARNESS, "transcripts")}`);
console.log("\nNext: grade transcripts (Opus, unblinded) + contamination check, then append the run report to plans/open/35-blind-agent-field-test.md");
