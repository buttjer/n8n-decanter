// Plan 35 field test — HTML report generator ("what actually happened in the
// agentic part"). Turns a round's stream-json transcripts + verify results +
// guard.log into ONE self-contained, redacted HTML file: a chat-style timeline
// of each blind session — user prompts, agent reasoning, every tool call +
// result, guard events, and the scripted invariant verdict. Debuggability, not
// grading (grading is a separate unblinded pass).
//
// Usage:
//   node scripts/field-test/report.mts <manifest.json> [--out <file.html>] [S1 S2 …]
//   node scripts/field-test/report.mts --help
//
// With no scenario ids, every folder under <harnessRoot>/transcripts is included.
// Secrets (MCP token / API key from the manifest) are redacted everywhere.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.join(HERE, "scenarios");

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node scripts/field-test/report.mts <manifest.json> [--out <file.html>] [S1 S2 …]");
  process.exit(0);
}
const outFlag = argv.indexOf("--out");
const outArg = outFlag >= 0 ? argv[outFlag + 1] : undefined;
// NB: only skip the token AFTER --out when --out is actually present. Without
// this guard, outFlag === -1 makes `outFlag + 1 === 0` swallow the manifest
// itself, so `report.mts <manifest>` always failed with "pass <manifest.json>".
const positional = argv.filter((a, i) => !a.startsWith("--") && !(outFlag >= 0 && i === outFlag + 1));
const manifestPath = positional[0] ?? process.env.FIELD_MANIFEST;
if (!manifestPath) { console.error("report: pass <manifest.json> or set FIELD_MANIFEST"); process.exit(2); }

interface Manifest { host: string; mcpToken?: string; apiKey?: string; harnessRoot: string; workDir?: string; seeded?: Array<{ name: string; kind: string }>; }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const HR = manifest.harnessRoot;
const TDIR = path.join(HR, "transcripts");
const OUT = outArg ?? path.join(HR, "report.html");

// ---------- redaction + escaping ----------
const SECRETS = [manifest.mcpToken, manifest.apiKey].filter((s): s is string => !!s && s.length > 8);
function redact(s: string): string {
  let out = s;
  for (const sec of SECRETS) out = out.split(sec).join("‹redacted›");
  return out;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (s: string) => esc(redact(s));
const trunc = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

// ---------- transcript parsing ----------
type Ev =
  | { kind: "agent-text"; text: string }
  | { kind: "tool-call"; name: string; id: string; input: Record<string, unknown> }
  | { kind: "tool-result"; id: string; text: string; isError: boolean }
  | { kind: "result"; text: string; cost?: number; turns?: number };

function parseTurn(file: string): Ev[] {
  const evs: Ev[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("[stderr]") || line.startsWith("[harness]")) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text?.trim()) evs.push({ kind: "agent-text", text: c.text });
        else if (c.type === "tool_use") evs.push({ kind: "tool-call", name: c.name, id: c.id, input: c.input ?? {} });
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === "tool_result") {
          const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("\n") : JSON.stringify(c.content);
          evs.push({ kind: "tool-result", id: c.tool_use_id, text, isError: !!c.is_error });
        }
      }
    } else if (ev.type === "result" && typeof ev.result === "string") {
      evs.push({ kind: "result", text: ev.result, cost: ev.total_cost_usd, turns: ev.num_turns });
    }
  }
  return evs;
}

// ---------- scenario prompts (for the "user says" bubbles) ----------
function scenarioTurns(id: string): { persona: string; turns: string[] } {
  const file = path.join(SCENARIO_DIR, `${id}.md`);
  if (!existsSync(file)) return { persona: "", turns: [] };
  const m = readFileSync(file, "utf8").match(/##\s*Orchestration[\s\S]*?```json\n([\s\S]*?)\n```/);
  if (!m) return { persona: "", turns: [] };
  try { const o = JSON.parse(m[1]); return { persona: o.persona ?? "", turns: o.turns ?? [] }; } catch { return { persona: "", turns: [] }; }
}

// ---------- syntax highlighting + diffs (server-side; the file stays self-contained) ----------
/**
 * Tiny JS/TS/JSON highlighter. Deliberately regex-based and dependency-free —
 * the report must remain ONE self-contained file (no CDN). Redacts first, then
 * tokenizes, escaping every emitted piece.
 */
function hl(src: string): string {
  const s = redact(src);
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|of|in|while|do|new|await|async|class|extends|import|export|from|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this)\b)/g;
  let out = "";
  let last = 0;
  for (const m of s.matchAll(re)) {
    const at = m.index ?? 0;
    out += esc(s.slice(last, at));
    const cls = m[1] ? "tc" : m[2] ? "ts" : m[3] ? "tn" : "tk";
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = at + m[0].length;
  }
  return out + esc(s.slice(last));
}

/** Minimal LCS line diff. Inputs are single-edit snippets, so O(n·m) is fine (capped). */
function lineDiff(a: string[], b: string[]): Array<{ t: " " | "-" | "+"; s: string }> {
  const n = a.length;
  const m = b.length;
  const out: Array<{ t: " " | "-" | "+"; s: string }> = [];
  if (n * m > 250_000) { // pathological input — fall back to a plain block diff
    for (const l of a) out.push({ t: "-", s: l });
    for (const l of b) out.push({ t: "+", s: l });
    return out;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "-", s: a[i] }); i++; }
    else { out.push({ t: "+", s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "-", s: a[i++] });
  while (j < m) out.push({ t: "+", s: b[j++] });
  return out;
}

/** A highlighted +/- diff, rendered directly under the agent action that caused it. */
function diffHtml(oldS: string, newS: string): string {
  const rows = lineDiff(trunc(oldS, 6000).split("\n"), trunc(newS, 6000).split("\n"));
  const lines = rows.map((r) => `<span class="dl ${r.t === "+" ? "dadd" : r.t === "-" ? "ddel" : "dctx"}">${esc(r.t)} ${hl(r.s)}</span>`).join("\n");
  return `<pre class="tin diff">${lines}</pre>`;
}

/** A new file: every line is an addition. */
function addedHtml(content: string): string {
  const lines = trunc(content, 6000).split("\n").map((l) => `<span class="dl dadd">+ ${hl(l)}</span>`).join("\n");
  return `<pre class="tin diff">${lines}</pre>`;
}

// ---------- tool-call summaries ----------
function toolSummary(name: string, input: Record<string, unknown>): { icon: string; label: string; body: string; html?: string } {
  const s = (v: unknown) => String(v ?? "");
  if (name === "Bash") return { icon: "⌘", label: "Bash", body: s(input.command) };
  if (name === "Read") return { icon: "▤", label: "Read", body: s(input.file_path) };
  // File-changing actions render as a highlighted diff INLINE, under the action
  // that caused the change (rather than only in the separate progression view).
  if (name === "Write") return { icon: "✎", label: "Write " + s(input.file_path), body: s(input.content), html: addedHtml(s(input.content)) };
  if (name === "Edit") return { icon: "✎", label: "Edit " + s(input.file_path), body: "", html: diffHtml(s(input.old_string), s(input.new_string)) };
  if (name === "Glob" || name === "Grep") return { icon: "⌕", label: name, body: s(input.pattern ?? input.query) };
  if (name === "TodoWrite") return { icon: "☑", label: "TodoWrite", body: JSON.stringify(input.todos ?? input, null, 2) };
  if (name.startsWith("mcp__")) return { icon: "⚙", label: "MCP · " + name.replace(/^mcp__[^_]*__/, ""), body: JSON.stringify(input, null, 2) };
  if (name === "Skill") return { icon: "◆", label: "Skill " + s(input.command ?? ""), body: JSON.stringify(input, null, 2) };
  return { icon: "•", label: name, body: JSON.stringify(input, null, 2) };
}

// ---------- workflow progression (the workDir git history: pull/push auto-commit) ----------
function gitOut(args: string[]): string {
  if (!manifest.workDir) return "";
  try { return execFileSync("git", ["-C", manifest.workDir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { return ""; }
}
function renderProgression(): string {
  if (!manifest.workDir || !existsSync(path.join(manifest.workDir, ".git"))) return "";
  const log = gitOut(["log", "--reverse", "--format=%H%x1f%ci%x1f%s", "--", "workflows"]).trim();
  if (!log) return "";
  let rows = "";
  for (const line of log.split("\n")) {
    const [sha, date, subj] = line.split("\x1f");
    if (!sha) continue;
    const diff = gitOut(["show", "--format=", "--stat", "-p", sha, "--", "workflows"]);
    rows += `<details class="tool"><summary><span class="ticon">◷</span> <span class="tname">${esc(subj ?? sha.slice(0, 8))}</span> <span class="vdet">${esc((date ?? "").slice(0, 16))}</span></summary><pre class="tin">${clean(trunc(diff, 12000))}</pre></details>`;
  }
  return `<section id="progression"><h2>Workflow progression</h2><p class="persona">Every decanter <code>pull</code>/<code>push</code> auto-commits, so the <code>workflows/</code> tree is a turn-by-turn record — click a commit for its diff (code + <code>workflow.json</code>).</p>${rows}</section>`;
}

// ---------- render ----------
function renderScenario(id: string): { nav: string; html: string; verdict: string } {
  const dir = path.join(TDIR, id);
  const { persona, turns } = scenarioTurns(id);
  const verifyFile = path.join(HR, `verify-${id}.json`);
  const verify = existsSync(verifyFile) ? JSON.parse(readFileSync(verifyFile, "utf8")) : null;
  const verdict = verify ? (verify.passed ? "PASS" : `FAIL (${verify.violations})`) : "—";

  const turnFiles = existsSync(dir) ? readdirSync(dir).filter((f) => /^turn-\d+\.jsonl$/.test(f)).sort() : [];
  let body = "";
  turnFiles.forEach((tf, i) => {
    const evs = parseTurn(path.join(dir, tf));
    const resultById = new Map(evs.filter((e): e is Extract<Ev, { kind: "tool-result" }> => e.kind === "tool-result").map((e) => [e.id, e]));
    body += `<div class="turn"><div class="turn-h">Turn ${i + 1}</div>`;
    if (turns[i]) body += `<div class="msg user"><div class="who">user</div><div class="bubble">${clean(turns[i])}</div></div>`;
    for (const e of evs) {
      if (e.kind === "agent-text") {
        body += `<div class="msg agent"><div class="who">agent</div><div class="bubble">${clean(e.text)}</div></div>`;
      } else if (e.kind === "tool-call") {
        const { icon, label, body: b, html: bHtml } = toolSummary(e.name, e.input);
        const res = resultById.get(e.id);
        const resHtml = res ? `<div class="tres ${res.isError ? "err" : ""}"><span class="tlab">${res.isError ? "error" : "result"}</span><pre>${clean(trunc(res.text))}</pre></div>` : "";
        // a file-changing action carries its own pre-rendered diff; everything else is plain text
        const inHtml = bHtml ?? `<pre class="tin">${clean(trunc(b, 2500))}</pre>`;
        body += `<details class="tool${e.name.startsWith("mcp__") ? " mcp" : ""}${bHtml ? " edit" : ""}${res?.isError ? " has-err" : ""}"><summary><span class="ticon">${icon}</span> <span class="tname">${esc(label)}</span></summary>${inHtml}${resHtml}</details>`;
      } else if (e.kind === "result") {
        const cost = e.cost ? ` · $${e.cost.toFixed(3)}` : "";
        body += `<div class="msg done"><div class="who">↳ turn result${cost}</div><div class="bubble">${clean(e.text)}</div></div>`;
      }
    }
    body += `</div>`;
  });

  let verifyHtml = "";
  if (verify) {
    verifyHtml = `<div class="verify"><h4>Scripted invariants — ${verdict}</h4>`;
    for (const wf of verify.workflows ?? []) {
      verifyHtml += `<div class="vwf"><b>${esc(wf.slug)}</b><ul>`;
      for (const c of wf.checks ?? []) verifyHtml += `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.name)}${c.ok ? "" : `<br><span class="vdet">${esc(c.detail)}</span>`}</li>`;
      verifyHtml += `</ul></div>`;
    }
    verifyHtml += `</div>`;
  }

  const cls = verdict.startsWith("PASS") ? "pass" : verdict === "—" ? "na" : "fail";
  const nav = `<a href="#${id}" class="navlink ${cls}">${id} <span class="badge ${cls}">${verdict}</span></a>`;
  const html = `<section id="${id}"><h2>${id} <span class="badge ${cls}">${verdict}</span></h2><div class="persona">${esc(persona)}</div>${body}${verifyHtml}</section>`;
  return { nav, html, verdict };
}

const wanted = positional.slice(1).length ? positional.slice(1) : (existsSync(TDIR) ? readdirSync(TDIR).filter((d) => existsSync(path.join(TDIR, d))).sort() : []);
if (wanted.length === 0) { console.error(`report: no scenario transcripts under ${TDIR}`); process.exit(2); }

const parts = wanted.map(renderScenario);
const guardLog = existsSync(path.join(HR, "guard.log")) ? readFileSync(path.join(HR, "guard.log"), "utf8") : "";
const guardHtml = guardLog.trim()
  ? `<section id="guard"><h2>Guard stderr (mcp connect)</h2><p class="persona">A blocked <code>jsCode</code>-over-MCP write appears here as a guard warn-line. Empty / connection-only ⇒ the agent went file-first (guard never needed to fire).</p><pre class="tin">${clean(trunc(guardLog, 8000))}</pre></section>`
  : "";
const progressionHtml = renderProgression();

const html = `<title>Field test — agentic report</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e3e3e3;--card:#f7f7f8;--user:#e7f0ff;--agent:#fff;--done:#eefaf0;--code:#f4f4f6;--acc:#2b6cb0;--ok:#1a7f37;--bad:#c1121f;--mcp:#7b3fa0;--tk:#7c3aed;--ts:#b45309;--tn:#0369a1;--tcm:#6b7280;--add:rgba(46,160,67,.16);--del:rgba(248,81,73,.16)}
@media(prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e6e6e6;--mut:#9aa0a6;--line:#2c2e33;--card:#1e2024;--user:#1b2b45;--agent:#1e2024;--done:#16281c;--code:#0f1013;--acc:#63a4ff;--ok:#4ade80;--bad:#ff6b6b;--mcp:#c084fc;--tk:#c084fc;--ts:#fbbf24;--tn:#7dd3fc;--tcm:#8b929b;--add:rgba(46,160,67,.22);--del:rgba(248,81,73,.22)}}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--fg);background:var(--bg)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px;z-index:9;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
header h1{font-size:15px;margin:0 12px 0 0}
.navlink{text-decoration:none;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font-size:13px}
.badge{font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;color:#fff}
.badge.pass{background:var(--ok)}.badge.fail{background:var(--bad)}.badge.na{background:var(--mut)}
main{max-width:920px;margin:0 auto;padding:20px}
section{margin:0 0 40px;border-top:1px solid var(--line);padding-top:16px}
h2{font-size:20px;margin:8px 0}.persona{color:var(--mut);font-style:italic;margin-bottom:14px}
.turn{margin:18px 0}.turn-h{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);border-bottom:1px dashed var(--line);padding-bottom:4px;margin-bottom:10px}
.msg{margin:8px 0}.who{font-size:11px;color:var(--mut);margin-bottom:2px}
.bubble{white-space:pre-wrap;padding:9px 12px;border-radius:8px;border:1px solid var(--line)}
.user .bubble{background:var(--user)}.agent .bubble{background:var(--agent)}.done .bubble{background:var(--done)}
.tool{margin:5px 0;border:1px solid var(--line);border-radius:7px;background:var(--card);overflow:hidden}
.tool.mcp{border-left:3px solid var(--mcp)}.tool.has-err{border-left:3px solid var(--bad)}
.tool>summary{cursor:pointer;padding:6px 10px;font-size:13px;list-style:none;user-select:none}
.tool>summary::-webkit-details-marker{display:none}.ticon{display:inline-block;width:16px;color:var(--acc)}.tname{font-family:ui-monospace,Menlo,monospace}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace}
.tin{background:var(--code);padding:8px 10px;border-top:1px solid var(--line)}
/* inline diffs, shown under the agent action that caused the change */
.diff .dl{display:block;padding:0 4px;border-radius:2px}
.diff .dadd{background:var(--add)}.diff .ddel{background:var(--del)}.diff .dctx{opacity:.65}
.tool.edit{border-left:3px solid var(--acc)}
/* syntax tokens */
.tk{color:var(--tk);font-weight:600}.ts{color:var(--ts)}.tn{color:var(--tn)}.tc{color:var(--tcm);font-style:italic}
.tres{padding:8px 10px;border-top:1px solid var(--line)}.tres.err{color:var(--bad)}.tlab{font-size:10px;text-transform:uppercase;color:var(--mut);letter-spacing:.06em}
.verify{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-top:14px}.verify h4{margin:0 0 8px}
.vwf{margin:6px 0}.vwf ul{margin:4px 0;padding-left:18px}.vwf li.ok{color:var(--ok)}.vwf li.bad{color:var(--bad)}.vdet{color:var(--mut);font-family:ui-monospace,monospace;font-size:11px}
code{background:var(--code);padding:1px 4px;border-radius:3px;font-family:ui-monospace,monospace}
</style>
<header><h1>n8n-decanter · blind field test</h1>${parts.map((p) => p.nav).join("")}${progressionHtml ? `<a href="#progression" class="navlink">progression</a>` : ""}${guardHtml ? `<a href="#guard" class="navlink">guard.log</a>` : ""}</header>
<main>
<p class="persona">Host <code>${clean(manifest.host)}</code> · ${wanted.length} scenario(s) · generated from stream-json transcripts. Secrets redacted. Tool calls are collapsed — click to expand input + result.</p>
${parts.map((p) => p.html).join("\n")}
${progressionHtml}
${guardHtml}
</main>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
for (const [i, p] of parts.entries()) console.log(`  ${wanted[i]}: ${p.verdict}`);
