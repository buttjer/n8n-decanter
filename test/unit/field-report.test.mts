// Unit tests for the field-test REPORT + ARCHIVE path (test/field-test/report.mts
// and run.mts's `--archive`), Plan 35.
//
// A blind round costs real money and cannot be reproduced, so the machinery that
// preserves and renders one must never be exercised for the first time by an
// actual round. This is that round's stunt double: a synthetic harness — a
// hand-written stream-json transcript, a verify verdict, a guard log and a tiny
// git repo standing in for the workDir — driven through the real scripts as
// subprocesses. No n8n, no Docker, no claude, no spend.
//
// What it pins down:
//   - the renderer surfaces prompts, agent text, tool calls + results, the
//     rendered file diff, the verdict, guard.log and the workflow progression
//   - `--archive` packs a self-sufficient raw.tgz (and only what's needed)
//   - `--from <raw.tgz>` re-renders BYTE-IDENTICALLY with the live run gone —
//     the property that lets a view change later without re-running a round
//   - credentials never reach the archive
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIELD = path.join(HERE, "..", "field-test");
const RUN = path.join(FIELD, "run.mts");
const REPORT = path.join(FIELD, "report.mts");

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-fieldreport-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const MCP_TOKEN = "mcp-tok-e3f9a1b2c3d4e5f6a7b8";
const API_KEY = "api-key-9f8e7d6c5b4a3928170a";
const PROMPT = "Ada, the empty step needs the finished code.";

/** One stream-json line, as the claude CLI emits it. */
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

/**
 * A synthetic round: harnessRoot + a git workDir, shaped exactly like a real one.
 * The transcript deliberately covers every event kind the renderer branches on,
 * including an Edit (which must come back as a rendered diff, not raw text).
 */
function stageSynthetic(): { manifestPath: string; harness: string; workDir: string } {
  const root = mkdtempSync(path.join(TMP, "round-"));
  const harness = path.join(root, "ftrun-12345");
  const workDir = path.join(root, "work");
  const tdir = path.join(harness, "transcripts", "S1");
  mkdirSync(tdir, { recursive: true });

  // --- the workDir: a real git repo whose history IS the workflow progression
  const wfDir = path.join(workDir, "workflows", "contact-normalizer", "code");
  mkdirSync(wfDir, { recursive: true });
  const codeFile = path.join(wfDir, "normalize.js");
  writeFileSync(codeFile, "return items;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", workDir, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", workDir], { stdio: "ignore" });
  git("config", "user.email", "harness@example.test");
  git("config", "user.name", "Harness");
  git("add", "-A");
  git("commit", "-q", "-m", "harness: S1 after turn 0");
  writeFileSync(codeFile, "return items.map((i) => ({ json: { email: i.json.email.toLowerCase() } }));\n");
  git("add", "-A");
  git("commit", "-q", "-m", "harness: S1 after turn 1");

  // --- the transcript: what the agent did, as the CLI streams it
  writeFileSync(path.join(tdir, "turn-1.prompt.txt"), `${PROMPT}\n`);
  writeFileSync(
    path.join(tdir, "turn-1.jsonl"),
    line({ type: "system", subtype: "init", cwd: "/work", session_id: "sess-abc" }) +
      line({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the empty Code node first." }] } }) +
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `n8n-decanter pull --token ${MCP_TOKEN}` } }] } }) +
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "pulled 1 workflow" }] } }) +
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "workflows/contact-normalizer/code/normalize.js", old_string: "return items;", new_string: "return items.map((i) => ({ json: { email: i.json.email.toLowerCase() } }));" } }] } }) +
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "edited" }] } }) +
      line({ type: "result", subtype: "success", result: "Done — the code is in n8n.", total_cost_usd: 1.234 }),
  );

  writeFileSync(path.join(harness, "verify-S1.json"), JSON.stringify({ passed: true, violations: 0, workflows: [{ slug: "contact-normalizer", checks: [{ name: "placeholder integrity", ok: true }, { name: ".js byte-equality", ok: true }] }] }));
  writeFileSync(path.join(harness, "guard.log"), `guard: blocked jsCode write via update_workflow (token ${MCP_TOKEN})\n`);

  const manifest = {
    createdAt: "2026-07-24T09-00-00Z".replace(/-(\d\d)-(\d\dZ)$/, ":$1:$2"),
    host: "http://127.0.0.1:5678",
    container: null,
    mcpToken: MCP_TOKEN,
    apiKey: API_KEY,
    workDir,
    harnessRoot: harness,
    root: "workflows",
    allowExtension: [],
    cliTarball: null,
    decanterSpec: null,
    seeded: [{ id: "w1", name: "Contact normalizer", slug: "contact-normalizer", kind: "s1-skeleton", availableInMCP: true }],
  };
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, harness, workDir };
}

/** Every file in a tree, as posix-ish relative paths. */
function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

describe("field-test report", () => {
  const { manifestPath, harness } = stageSynthetic();
  const out = path.join(TMP, "live.html");
  execFileSync(process.execPath, [REPORT, manifestPath, "--out", out], { stdio: "ignore" });
  const html = readFileSync(out, "utf8");

  it("renders the recorded prompt, agent text and turn result", () => {
    assert.match(html, /Ada, the empty step needs the finished code\./);
    assert.match(html, /Looking at the empty Code node first\./);
    assert.match(html, /Done — the code is in n8n\./);
    assert.match(html, /\$1\.234/); // per-turn cost, so a round's spend is visible
  });

  it("renders each tool call with its result", () => {
    assert.match(html, /n8n-decanter pull/);
    assert.match(html, /pulled 1 workflow/);
  });

  it("renders a file edit as a diff, not as raw tool input", () => {
    // the diff view is what makes a round readable — old/new lines, syntax-highlighted
    assert.match(html, /class="dl ddel">- /, "expected a removed line under the Edit");
    assert.match(html, /class="dl dadd">\+ /, "expected an added line under the Edit");
    assert.match(html, /email\.toLowerCase\(\)/);
    assert.match(html, /class="tk">return<\/span>/, "diff lines should be syntax-highlighted");
  });

  it("renders the scripted verdict and the guard log", () => {
    assert.match(html, /PASS/);
    assert.match(html, /placeholder integrity/);
    assert.match(html, /blocked jsCode write/);
  });

  it("renders the workflow progression from the workDir git history", () => {
    assert.match(html, /id="progression"/);
    assert.match(html, /harness: S1 after turn 1/);
  });

  it("redacts credentials everywhere", () => {
    assert.ok(!html.includes(MCP_TOKEN), "MCP token leaked into the report");
    assert.ok(!html.includes(API_KEY), "API key leaked into the report");
  });

  it("survives the harness dir disappearing, via the archive", async () => {
    // This is the whole point of archiving: teardown must not be able to cost us
    // a round. Archive, delete the live run, then re-render from the tarball.
    const dest = path.join(TMP, "archived");
    execFileSync(process.execPath, [RUN, "--archive", manifestPath], { env: { ...process.env, FIELD_ARCHIVE_DIR: dest }, stdio: "ignore" });
    const tgz = path.join(dest, "raw.tgz");
    assert.ok(existsSync(tgz), "raw.tgz not written");
    assert.ok(existsSync(path.join(dest, "report.html")), "report.html not written next to the raw");

    // the raw carries the run's inputs AND outputs — and nothing reconstructable
    const unpacked = path.join(TMP, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    execFileSync("tar", ["-xzf", tgz, "-C", unpacked], { stdio: "ignore" });
    const files = walk(unpacked);
    assert.ok(files.includes("transcripts/S1/turn-1.jsonl"), "transcripts missing");
    assert.ok(files.includes("transcripts/S1/turn-1.prompt.txt"), "recorded prompt missing");
    assert.ok(files.includes("scenarios/S1.md"), "scenario files missing");
    assert.ok(files.includes("verify-S1.json"), "verify verdict missing");
    assert.ok(files.includes("guard.log"), "guard log missing");
    assert.ok(files.includes("work.git/HEAD"), "bare workflow history missing");
    assert.ok(!files.some((f) => f.startsWith("work/")), "working tree should not be archived");

    // it lands in git, so no credential may survive the packing
    for (const f of files) {
      const body = readFileSync(path.join(unpacked, f), "utf8").toString();
      assert.ok(!body.includes(MCP_TOKEN), `MCP token leaked into ${f}`);
      assert.ok(!body.includes(API_KEY), `API key leaked into ${f}`);
    }

    rmSync(harness, { recursive: true, force: true }); // the run is gone
    const revived = path.join(TMP, "revived.html");
    execFileSync(process.execPath, [REPORT, "--from", tgz, "--out", revived], { stdio: "ignore" });
    assert.equal(
      readFileSync(revived, "utf8"),
      readFileSync(path.join(dest, "report.html"), "utf8"),
      "re-rendering from the archive must reproduce the shipped report byte for byte",
    );
    assert.match(readFileSync(revived, "utf8"), /Ada, the empty step needs the finished code\./);
  });
});
