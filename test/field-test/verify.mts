// Plan 35 — blind-agent field test: SCRIPTED invariant verifier (no LLM).
//
// Runs after a scenario (or on demand) against the stage manifest and the blind
// agent's sync dir. Pass/fail only — the grader (Opus over transcripts) is a
// separate, unblinded pass. Exit 1 on ANY violation so an orchestrator can gate.
//
// Independent-oracle discipline (same ethos as test/smoke-n8n.mts): every
// FAIL-generating check reads the instance with plain `fetch` against the public
// REST API and recomputes hashes inline — it does NOT import decanter's own
// sync/compile code, so a bug there cannot hide a violation here. The only lib
// import is McpClient, used solely for the NON-fatal `get_workflow_history`
// version-trail evidence (there is no REST equivalent); its failure never fails
// the run.
//
// Invariants checked, per tracked workflow folder (…/workflows/<slug>/):
//   1. workflow.json Code nodes are all `//@file:` placeholders (no inline code)
//   2. plain .js node: remote jsCode BYTE-EQUALS the local file, and carries no
//      @ts-n8n marker
//   3. .ts-converted node: remote jsCode is compiled JS + a `// @ts-n8n
//      sha256:<h>` marker whose hash matches the compiled body (marker-hash
//      relation — NOT byte-equality to the .ts source; Plan 35 §Observation)
//   4. no jsCode landed via MCP: proven from instance state — final remote code
//      equals the local file (check 2/3) AND the version trail is recorded as
//      evidence
//   5. .decanter.json never hand-edited: every git commit that touched it is a
//      `decanter: …` CLI auto-commit (the Edit(**/.decanter.json) deny rule is
//      the other half; this catches a bypass)
//
// Usage:
//   node test/field-test/verify.mts <manifest.json> [--scenario <name>]
//        [--out <file.json>] [workflowId …]
//   node test/field-test/verify.mts --help
//
// With no workflow ids, every folder under <workDir>/<root> that has a
// .decanter.json is checked. --out writes a machine-readable summary for the
// grader. Env: FIELD_MANIFEST supplies the manifest path if the positional is
// omitted.
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node test/field-test/verify.mts <manifest.json> [--scenario <name>] [--out <file.json>] [workflowId …]");
  process.exit(0);
}
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const scenario = flag("--scenario");
const outFile = flag("--out");
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--scenario" && argv[i - 1] !== "--out");
const manifestPath = positional[0] ?? process.env.FIELD_MANIFEST;
const wantedIds = positional.slice(1);
if (!manifestPath) {
  console.error("verify: no manifest — pass <manifest.json> or set FIELD_MANIFEST");
  process.exit(2);
}

interface Manifest {
  host: string;
  apiKey?: string;
  mcpToken?: string;
  workDir: string;
  root?: string;
  [k: string]: unknown;
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const HOST = manifest.host.replace(/\/+$/, "");
const KEY = manifest.apiKey ?? process.env.N8N_API_KEY ?? "";
const MCP = manifest.mcpToken ?? process.env.N8N_MCP_TOKEN ?? "";
const ROOT = path.resolve(manifest.workDir, manifest.root ?? "workflows");

// ---------- tiny independent oracle (no lib imports) ----------
const sha256 = (text: string): string => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
const FILE_PLACEHOLDER_PREFIX = "//@file:";
const CODE_NODE_TYPE = "n8n-nodes-base.code";
/** Recover a trailing `// @ts-n8n sha256:<hex>` marker (mirrors lib/util splitMarker, reimplemented on purpose). */
function splitMarker(code: string): { body: string; markerHash: string | null } {
  const m = code.match(/(?:^|\n)(\/\/ @ts-n8n (sha256:[0-9a-f]{64}))[ \t]*\n?[ \t\n]*$/);
  if (!m) return { body: code, markerHash: null };
  const start = m.index! + (m[0].startsWith("\n") ? 1 : 0);
  return { body: code.slice(0, start), markerHash: m[2] };
}

// ---------- REST read (byte-exact remote jsCode; AGENTS "Node source fidelity is exact") ----------
async function getRemote(id: string): Promise<{ nodes: Array<{ id: string; name: string; type: string; parameters?: { jsCode?: string } }> }> {
  if (KEY === "") throw new Error("manifest has no apiKey — REST read needs a public API key (stage mints a scoped one)");
  const res = await fetch(`${HOST}/api/v1/workflows/${encodeURIComponent(id)}`, {
    headers: { "X-N8N-API-KEY": KEY, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /api/v1/workflows/${id} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ---------- MCP history (evidence only; best-effort, never fails the run) ----------
async function historyEvidence(id: string): Promise<{ versions: number | null; note: string }> {
  if (MCP === "") return { versions: null, note: "no MCP token in manifest — history evidence skipped" };
  try {
    const { McpClient } = await import(new URL("../../lib/mcp.mts", import.meta.url).href);
    const client = new McpClient({ host: HOST, auth: { kind: "bearer", token: MCP }, requestTimeoutMs: 15_000 });
    const res = (await client.callTool("get_workflow_history", { workflowId: id })) as { versions?: unknown[]; data?: unknown[] };
    const list = Array.isArray(res.versions) ? res.versions : Array.isArray(res.data) ? res.data : null;
    return { versions: list ? list.length : null, note: list ? `${list.length} version(s) in the trail` : "history returned no version array" };
  } catch (err) {
    return { versions: null, note: `history unavailable (${(err as Error).message.split("\n")[0]})` };
  }
}

// ---------- git-history check ----------
async function decanterJsonHandEdited(slug: string): Promise<{ ok: boolean; detail: string }> {
  const rel = path.join(slug, ".decanter.json");
  try {
    // subjects of every commit that touched this workflow's .decanter.json
    const { stdout } = await execFile("git", ["-C", manifest.workDir, "log", "--format=%s", "--", rel]);
    const subjects = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (subjects.length === 0) return { ok: true, detail: "no commits touch .decanter.json yet" };
    const bad = subjects.filter((s) => !s.startsWith("decanter: "));
    if (bad.length > 0) return { ok: false, detail: `non-CLI commit(s) touched .decanter.json: ${bad.slice(0, 3).map((s) => JSON.stringify(s)).join(", ")}` };
    // an uncommitted working-tree edit is also suspicious (deny rule should block it)
    const { stdout: dirty } = await execFile("git", ["-C", manifest.workDir, "status", "--porcelain", "--", rel]);
    if (dirty.trim() !== "") return { ok: false, detail: `.decanter.json has an uncommitted working-tree change: ${dirty.trim()}` };
    return { ok: true, detail: `${subjects.length} commit(s), all decanter: auto-commits` };
  } catch (err) {
    return { ok: false, detail: `git log failed (${(err as Error).message.split("\n")[0]}) — is <workDir> a git repo?` };
  }
}

// ---------- checks ----------
interface Check { name: string; ok: boolean; detail: string }
interface WorkflowResult { slug: string; workflowId: string; checks: Check[]; evidence: { historyVersions: number | null; historyNote: string } }

function discoverFolders(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(ROOT, d.name, ".decanter.json")))
    .map((d) => d.name);
}

async function checkWorkflow(slug: string): Promise<WorkflowResult> {
  const dir = path.join(ROOT, slug);
  const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8")) as { workflowId: string; nodes: Record<string, { file: string; lastPushedHash?: string }> };
  const wfJson = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8")) as { nodes: Array<{ id: string; name: string; type: string; parameters?: { jsCode?: string } }> };
  const checks: Check[] = [];
  const id = state.workflowId;

  // 1. workflow.json Code nodes are all //@file: placeholders
  const codeNodes = wfJson.nodes.filter((n) => n.type === CODE_NODE_TYPE);
  const nonPlaceholder = codeNodes.filter((n) => typeof n.parameters?.jsCode === "string" && !n.parameters.jsCode.startsWith(FILE_PLACEHOLDER_PREFIX));
  checks.push({
    name: "workflow.json placeholders intact",
    ok: nonPlaceholder.length === 0,
    detail: nonPlaceholder.length === 0 ? `${codeNodes.length} Code node(s), all //@file:` : `inline code leaked into workflow.json for: ${nonPlaceholder.map((n) => n.name).join(", ")}`,
  });

  // 2/3/4. remote code vs local file, per state node
  let remote: Awaited<ReturnType<typeof getRemote>>;
  try {
    remote = await getRemote(id);
  } catch (err) {
    checks.push({ name: "remote code read", ok: false, detail: (err as Error).message });
    const evidence = await historyEvidence(id);
    return { slug, workflowId: id, checks, evidence: { historyVersions: evidence.versions, historyNote: evidence.note } };
  }
  const remoteById = new Map(remote.nodes.map((n) => [n.id, n]));
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const localPath = path.join(dir, node.file);
    const label = `node ${JSON.stringify(node.file)}`;
    if (!existsSync(localPath)) {
      checks.push({ name: `${label}: local file exists`, ok: false, detail: `${node.file} in .decanter.json but missing on disk` });
      continue;
    }
    const local = readFileSync(localPath, "utf8");
    const remoteNode = remoteById.get(nodeId);
    if (!remoteNode) {
      checks.push({ name: `${label}: present on instance`, ok: false, detail: `node id ${nodeId} not found on the remote workflow` });
      continue;
    }
    const remoteJs = remoteNode.parameters?.jsCode ?? "";
    const isTs = node.file.endsWith(".ts");
    if (isTs) {
      const { body, markerHash } = splitMarker(remoteJs);
      const markerOk = markerHash !== null && sha256(body) === markerHash;
      checks.push({
        name: `${label}: TS marker-hash relation (compiled JS + valid @ts-n8n marker)`,
        ok: markerOk,
        detail: markerHash === null
          ? "remote code carries NO @ts-n8n marker — a .ts node's remote must be compiled JS + marker"
          : markerOk ? `marker hash matches compiled body (${markerHash.slice(0, 16)}…)` : `marker hash ${markerHash.slice(0, 20)} ≠ sha256(body) ${sha256(body).slice(0, 20)}`,
      });
    } else {
      const byteEqual = remoteJs === local;
      const noMarker = splitMarker(remoteJs).markerHash === null;
      checks.push({
        name: `${label}: remote jsCode byte-equals local .js`,
        ok: byteEqual,
        detail: byteEqual ? `${local.length} bytes identical` : `remote (${remoteJs.length}b) ≠ local (${local.length}b) — first diff around ${firstDiff(remoteJs, local)}`,
      });
      checks.push({ name: `${label}: no stray TS marker on a .js node`, ok: noMarker, detail: noMarker ? "clean" : "a .js node carries a @ts-n8n marker (rogue TS push?)" });
    }
    // in-sync tie: recorded remote hash must match what's actually remote (belt-and-braces on check 4)
    if (node.lastPushedHash) {
      const expected = isTs ? splitMarker(remoteJs).markerHash : sha256(remoteJs);
      checks.push({
        name: `${label}: .decanter.json lastPushedHash matches remote`,
        ok: expected !== null && node.lastPushedHash === expected,
        detail: node.lastPushedHash === expected ? "in sync" : `state ${String(node.lastPushedHash).slice(0, 20)} ≠ remote ${String(expected).slice(0, 20)} — local sync state drifted from the instance`,
      });
    }
  }

  // 5. .decanter.json never hand-edited (git history)
  const handEdit = await decanterJsonHandEdited(slug);
  checks.push({ name: ".decanter.json only via decanter: auto-commits", ok: handEdit.ok, detail: handEdit.detail });

  const evidence = await historyEvidence(id);
  return { slug, workflowId: id, checks, evidence: { historyVersions: evidence.versions, historyNote: evidence.note } };
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

// ---------- run ----------
const slugs = wantedIds.length > 0
  ? discoverFolders().filter((slug) => {
      const st = JSON.parse(readFileSync(path.join(ROOT, slug, ".decanter.json"), "utf8")) as { workflowId: string };
      return wantedIds.includes(st.workflowId);
    })
  : discoverFolders();

if (slugs.length === 0) {
  console.error(`verify: no tracked workflow folders under ${ROOT}${wantedIds.length ? ` matching ${wantedIds.join(", ")}` : ""}`);
  process.exit(2);
}

const results: WorkflowResult[] = [];
for (const slug of slugs) results.push(await checkWorkflow(slug));

let failed = 0;
console.log(`\n=== field-test verify${scenario ? ` — ${scenario}` : ""} (${slugs.length} workflow${slugs.length === 1 ? "" : "s"}) ===`);
for (const r of results) {
  console.log(`\n▸ ${r.slug} (${r.workflowId})`);
  for (const c of r.checks) {
    console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : "\n        " + c.detail}`);
    if (!c.ok) failed++;
  }
  console.log(`  ···· evidence: ${r.evidence.historyNote}`);
}
console.log(`\n${failed === 0 ? "OK" : "FAIL"} — ${failed} violation(s) across ${slugs.length} workflow(s)\n`);

if (outFile) {
  const summary = { scenario: scenario ?? null, manifest: manifestPath, workflows: results, violations: failed, passed: failed === 0 };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
  console.log(`wrote ${outFile}`);
}

process.exit(failed === 0 ? 0 : 1);
