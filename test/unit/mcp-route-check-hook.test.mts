// Unit tests for the scaffolded SessionStart route-check hook
// (template/.claude/hooks/mcp-route-check.mjs.example, Plan 33 + Plan 58 task 2).
//
// The hook is the drift warning for the "second door": an MCP config that
// reaches an n8n `/mcp-server/http` endpoint directly instead of through the
// decanter guard. It is driven exactly as a harness drives it — spawned in the
// sync dir — with HOME pointed at a scratch dir so the user-scope checks
// (~/.claude.json, ~/.cursor/mcp.json, VS Code user profile, opencode global)
// are exercised hermetically.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-routehook-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// `.mjs.example` is inert on purpose; materialize it the way `init` does.
const HOOK = path.join(TMP, "mcp-route-check.mjs");
copyFileSync(path.join(PROJECT, "template/.claude/hooks/mcp-route-check.mjs.example"), HOOK);

const DIRECT = "https://n8n.example.com/mcp-server/http";
const LOOPBACK = "http://127.0.0.1:5680/mcp-server/http";

let seq = 0;
/** A project dir and an empty fake HOME, both under TMP. */
function scaffold(): { dir: string; home: string } {
  const base = path.join(TMP, `case-${seq++}`);
  const dir = path.join(base, "proj");
  const home = path.join(base, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { dir, home };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** VS Code's user-profile mcp.json, mirroring the hook's per-platform path. */
function vscodeUserPath(home: string): string {
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

/** Drive the hook the way the harness does: spawned in the sync dir. */
function run(dir: string, home: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [HOOK], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("mcp-route-check hook", () => {
  it("still warns on a project-level direct route (regression)", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(dir, ".mcp.json"), { mcpServers: { n8n: { url: DIRECT } } });
    const { code, out } = run(dir, home);
    assert.equal(code, 0, out);
    assert.match(out, /"n8n" in \.mcp\.json/);
    assert.match(out, /decanter guard/);
  });

  it("stays silent on the guard routes: stdio command and loopback url", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(dir, ".mcp.json"), {
      mcpServers: { "n8n-instance": { command: "npx", args: ["--no-install", "n8n-decanter", "mcp", "connect"] } },
    });
    writeJson(path.join(dir, ".cursor/mcp.json"), { mcpServers: { n8n: { url: LOOPBACK } } });
    const { code, out } = run(dir, home);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "");
  });

  it("sees a user-scoped server in ~/.claude.json", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(home, ".claude.json"), { mcpServers: { "global-n8n": { url: DIRECT } } });
    const { out } = run(dir, home);
    assert.match(out, /"global-n8n" in ~\/\.claude\.json/);
  });

  it("sees THIS project's entry inside ~/.claude.json, and ignores other projects'", () => {
    const { dir, home } = scaffold();
    // The hook looks the entry up by the child's cwd, which the OS resolves —
    // key the map by the realpath so the test holds on macOS's symlinked /tmp.
    const real = realpathSync(dir);
    writeJson(path.join(home, ".claude.json"), {
      projects: {
        [real]: { mcpServers: { "local-n8n": { url: DIRECT } } },
        "/somewhere/else": { mcpServers: { "other-n8n": { url: DIRECT } } },
      },
    });
    const { out } = run(real, home);
    assert.match(out, /"local-n8n" in ~\/\.claude\.json \(entry for this project\)/);
    assert.doesNotMatch(out, /other-n8n/);
  });

  it("sees Cursor's and VS Code's user-level configs", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { cursor: { url: DIRECT } } });
    writeJson(vscodeUserPath(home), { servers: { vscode: { url: DIRECT } } });
    const { out } = run(dir, home);
    assert.match(out, /"cursor" in ~\/\.cursor\/mcp\.json/);
    assert.match(out, /"vscode" in /);
  });

  it("reads opencode's real shape (`mcp.<name>`) — globally and in the project", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      mcp: { "global-oc": { type: "remote", url: DIRECT } },
    });
    writeJson(path.join(dir, "opencode.json"), {
      mcp: { "project-oc": { type: "remote", url: DIRECT } },
    });
    const { out } = run(dir, home);
    assert.match(out, /"global-oc" in ~\/\.config\/opencode\/opencode\.json/);
    assert.match(out, /"project-oc" in opencode\.json/);
  });

  it("leaves guard-routed user config alone", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(home, ".claude.json"), { mcpServers: { n8n: { url: LOOPBACK } } });
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      mcp: { "n8n-instance": { type: "local", command: ["npx", "--no-install", "n8n-decanter", "mcp", "connect"] } },
    });
    const { code, out } = run(dir, home);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "");
  });

  it("survives junk config and always exits 0 — guidance, not a gate", () => {
    const { dir, home } = scaffold();
    writeFileSync(path.join(home, ".claude.json"), "not json");
    writeJson(path.join(dir, ".mcp.json"), { mcpServers: { n8n: { url: DIRECT } } });
    const { code, out } = run(dir, home);
    assert.equal(code, 0, out);
    assert.match(out, /"n8n" in \.mcp\.json/);
  });
});
