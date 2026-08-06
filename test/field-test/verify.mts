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
/**
 * `--expect-drift <workflowId>`: this scenario DELIBERATELY left the instance
 * ahead of local (S3's `remote-drift` preHook edits a node over raw MCP, and the
 * agent is supposed to refuse to push over it). Without this, the injected drift
 * scores as two violations and a correct run reports FAIL — which is exactly
 * what happened to S3, and to S4 for inheriting it.
 *
 * Byte-equality alone cannot tell "agent correctly refused" from "agent pulled
 * and resolved" — both are acceptable outcomes per S3's checklist, and a blind
 * `--force` clobber looks identical to a legitimate resolve. So both states pass
 * here and the detail records which one happened; judging the recovery is the
 * grader's job, from the transcript.
 */
const expectDrift = flag("--expect-drift");
/**
 * `--expect-unchanged <workflowId>=<versionId>`: this scenario is supposed to be
 * READ-ONLY on the instance, and this is the draft version it started on
 * (Plan 61 task 9). `preflight`, `diff` and `executions` all document that they
 * never write; nothing has ever checked it, and "the verb quietly pushed" is
 * invisible in a transcript full of successful-looking output. Repeatable so a
 * scenario can pin several workflows.
 */
const expectUnchanged = new Map<string, string>();
for (const [i, a] of argv.entries()) {
  if (a !== "--expect-unchanged") continue;
  const [id, version] = (argv[i + 1] ?? "").split("=");
  if (id && version) expectUnchanged.set(id, version);
}
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--scenario" && argv[i - 1] !== "--out" && argv[i - 1] !== "--expect-drift" && argv[i - 1] !== "--expect-unchanged");
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
async function getRemote(id: string): Promise<{ versionId?: string; nodes: Array<{ id: string; name: string; type: string; parameters?: { jsCode?: string } }> }> {
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

/**
 * Did any commit touch the fetched-data caches? (Plan 61 task 9.)
 *
 * `workflows/<slug>/executions/` and the sync-dir's `data-tables/` are working
 * data, self-gitignored. A real capture can carry production payloads, so a
 * commit is a **leak**, not untidiness — and `git add -A` past an ignore file is
 * a thing agents do.
 */
async function cachesCommitted(slug: string): Promise<{ ok: boolean; detail: string }> {
  const paths = [path.posix.join(manifest.root ?? "workflows", slug, "executions"), "data-tables"];
  const offenders: string[] = [];
  for (const rel of paths) {
    try {
      const { stdout } = await execFile("git", ["-C", manifest.workDir, "log", "--format=%h", "--", rel]);
      if (stdout.trim() !== "") offenders.push(`${rel} (${stdout.trim().split("\n").length} commit(s))`);
    } catch {
      // no git, or the path never existed — nothing committed either way
    }
  }
  return offenders.length === 0
    ? { ok: true, detail: "executions/ and data-tables/ are untracked, as designed" }
    : { ok: false, detail: `fetched data reached git: ${offenders.join(", ")}` };
}

/**
 * Are the COMMITTED scenarios loadable? (Plan 61 task 9.)
 *
 * Deliberately a hand-rolled shape check, not an import of `lib/simulate.mts`:
 * this oracle stays independent of the code under test, so a bug that makes the
 * CLI accept a malformed scenario cannot also make the verifier accept it.
 * Returns null when the folder has no scenarios (nothing to assert).
 */
function scenariosValid(dir: string): { ok: boolean; detail: string } | null {
  const scenDir = path.join(dir, "scenarios");
  if (!existsSync(scenDir)) return null;
  const files = readdirSync(scenDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  const problems: string[] = [];
  for (const file of files) {
    let exec: unknown;
    try {
      exec = JSON.parse(readFileSync(path.join(scenDir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: not JSON (${(err as Error).message.split("\n")[0]})`);
      continue;
    }
    const runData = (exec as { data?: { resultData?: { runData?: unknown } } })?.data?.resultData?.runData;
    if (!runData || typeof runData !== "object" || Array.isArray(runData)) {
      problems.push(`${file}: no data.resultData.runData object`);
      continue;
    }
    for (const [node, runs] of Object.entries(runData as Record<string, unknown>)) {
      if (!Array.isArray(runs)) { problems.push(`${file}: ${node} is not an array of runs`); continue; }
      for (const [i, r] of runs.entries()) {
        const main = (r as { data?: { main?: unknown } })?.data?.main;
        if (!Array.isArray(main)) { problems.push(`${file}: ${node} run ${i} has no data.main array`); continue; }
        for (const out of main) {
          if (out === null) continue; // an unused output is legitimately null
          if (!Array.isArray(out)) { problems.push(`${file}: ${node} run ${i} output is neither array nor null`); continue; }
          for (const it of out) {
            if (!it || typeof it !== "object" || Array.isArray(it) || !("json" in it)) {
              problems.push(`${file}: ${node} run ${i} has an item without a "json" field`);
              break;
            }
          }
        }
      }
    }
  }
  return problems.length === 0
    ? { ok: true, detail: `${files.length} scenario(s) parse and carry well-formed runData` }
    : { ok: false, detail: problems.slice(0, 4).join("; ") };
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

/**
 * n8n's pre-`code` Code nodes (Plan 61 task 9). decanter extracts
 * `n8n-nodes-base.code` only, so a workflow whose logic lives in these pulls
 * down with **no code file and no warning** — a documented blind spot, pinned
 * offline in `test/unit/validate.test.mts`.
 *
 * This is EVIDENCE, never a violation: S7 adopts real imported workflows that
 * legitimately contain them, and scoring their absence as a failure would flag
 * the agent for the tool's own limitation. What the round grades is whether the
 * agent *noticed and said so*; what this line does is make the fact visible in
 * the verdict instead of leaving a reader to wonder why a 24-node workflow
 * produced two code files.
 */
function legacyCodeNodes(nodes: Array<{ name: string; type: string }>): string[] {
  return nodes.filter((n) => n.type === "n8n-nodes-base.function" || n.type === "n8n-nodes-base.functionItem").map((n) => n.name);
}

async function checkWorkflow(slug: string): Promise<WorkflowResult> {
  const dir = path.join(ROOT, slug);
  const state = JSON.parse(readFileSync(path.join(dir, ".decanter.json"), "utf8")) as { workflowId: string; nodes: Record<string, { file: string; lastPushedHash?: string }> };
  const wfJson = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8")) as { nodes: Array<{ id: string; name: string; type: string; parameters?: { jsCode?: string } }> };
  const checks: Check[] = [];
  const id = state.workflowId;
  // this workflow is the scenario's deliberate drift target — see --expect-drift
  const driftExpected = expectDrift !== undefined && expectDrift === id;

  // 1. workflow.json Code nodes are all //@file: placeholders
  const codeNodes = wfJson.nodes.filter((n) => n.type === CODE_NODE_TYPE);
  const nonPlaceholder = codeNodes.filter((n) => typeof n.parameters?.jsCode === "string" && !n.parameters.jsCode.startsWith(FILE_PLACEHOLDER_PREFIX));
  checks.push({
    name: "workflow.json placeholders intact",
    ok: nonPlaceholder.length === 0,
    detail: nonPlaceholder.length === 0 ? `${codeNodes.length} Code node(s), all //@file:` : `inline code leaked into workflow.json for: ${nonPlaceholder.map((n) => n.name).join(", ")}`,
  });

  // 2. LOCAL hygiene, asserted before the instance is touched (Plan 61 task 9).
  //    Deliberately ahead of the remote read: these are local invariants, and a
  //    scenario whose whole point is a broken instance (S13) must still have
  //    them graded rather than short-circuited by an unreachable host.
  const cached = await cachesCommitted(slug);
  checks.push({ name: "fetched caches never committed (executions/, data-tables/)", ok: cached.ok, detail: cached.detail });
  const scen = scenariosValid(dir);
  if (scen !== null) checks.push({ name: "committed scenarios are structurally valid", ok: scen.ok, detail: scen.detail });
  const legacy = legacyCodeNodes(wfJson.nodes);
  if (legacy.length > 0) {
    checks.push({
      name: "legacy function/functionItem nodes are untracked — expected, not a violation",
      ok: true,
      detail: `${legacy.length} legacy node(s) hold source decanter does not extract: ${legacy.join(", ")}`,
    });
  }

  // 3/4/5. remote code vs local file, per state node
  let remote: Awaited<ReturnType<typeof getRemote>>;
  try {
    remote = await getRemote(id);
  } catch (err) {
    checks.push({ name: "remote code read", ok: false, detail: (err as Error).message });
    const evidence = await historyEvidence(id);
    return { slug, workflowId: id, checks, evidence: { historyVersions: evidence.versions, historyNote: evidence.note } };
  }
  // A read-only scenario must leave the draft exactly where it found it.
  const baseline = expectUnchanged.get(id);
  if (baseline !== undefined) {
    const now = remote.versionId ?? "(none)";
    checks.push({
      name: "read-only scenario: the instance draft never moved",
      ok: now === baseline,
      detail: now === baseline
        ? `versionId still ${baseline.slice(0, 8)}… — nothing was written`
        : `versionId moved ${baseline.slice(0, 8)}… → ${now.slice(0, 8)}… — something WROTE during a scenario that only reads`,
    });
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
      // A read-only scenario's local edits CANNOT have been pushed — S9 is
      // air-gapped, and its whole task is "make the change and check it as far
      // as you can without the instance". Demanding parity there faults the
      // agent for doing exactly what it was asked (it cost S9's first round a
      // FAIL). The instance-untouched guarantee is the versionId check above;
      // this one drops to evidence, and the *direction* still matters — a
      // divergence is only benign because nothing could have written.
      const editedOffline = !byteEqual && baseline !== undefined;
      checks.push({
        name: `${label}: remote jsCode byte-equals local .js`,
        ok: byteEqual || driftExpected || editedOffline,
        detail: byteEqual
          ? `${local.length} bytes identical${driftExpected ? " — the injected drift was resolved (grade HOW from the transcript)" : ""}`
          : driftExpected
            ? `expected: the scenario injected this remote drift and the agent left it (remote ${remoteJs.length}b ≠ local ${local.length}b)`
            : editedOffline
              ? `expected: a read-only scenario edited locally and could not push (remote ${remoteJs.length}b ≠ local ${local.length}b) — the draft itself never moved`
              : `remote (${remoteJs.length}b) ≠ local (${local.length}b) — first diff around ${firstDiff(remoteJs, local)}`,
      });
      checks.push({ name: `${label}: no stray TS marker on a .js node`, ok: noMarker, detail: noMarker ? "clean" : "a .js node carries a @ts-n8n marker (rogue TS push?)" });
    }
    // in-sync tie: recorded remote hash must match what's actually remote (belt-and-braces on check 4)
    if (node.lastPushedHash) {
      const expected = isTs ? splitMarker(remoteJs).markerHash : sha256(remoteJs);
      const hashOk = expected !== null && node.lastPushedHash === expected;
      checks.push({
        name: `${label}: .decanter.json lastPushedHash matches remote`,
        ok: hashOk || driftExpected,
        detail: hashOk
          ? "in sync"
          : driftExpected
            ? `expected: local sync state trails the injected remote drift (state ${String(node.lastPushedHash).slice(0, 20)} ≠ remote ${String(expected).slice(0, 20)})`
            : `state ${String(node.lastPushedHash).slice(0, 20)} ≠ remote ${String(expected).slice(0, 20)} — local sync state drifted from the instance`,
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
