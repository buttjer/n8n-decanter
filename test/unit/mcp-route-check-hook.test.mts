// Unit tests for the scaffolded SessionStart route-check hook
// (template/.claude/hooks/mcp-route-check.mjs.example, Plan 33 + Plan 58 task 2).
//
// The hook is the drift warning for the "second door": an MCP config that
// reaches an n8n `/mcp-server/http` endpoint directly instead of through the
// decanter guard. It is driven exactly as a harness drives it — from the sync
// dir — with HOME pointed at a scratch dir so the user-scope checks
// (~/.claude.json, ~/.cursor/mcp.json, VS Code user profile, opencode global)
// are exercised hermetically.
//
// Since Plan 81 the hook locates the sync dir from its OWN path, so every case
// materializes it where `init` puts it (`<syncDir>/.claude/hooks/`) and the
// cwd it is spawned with is a free variable — a nested sync dir's hooks run
// with cwd = the enclosing repo's root.
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
const HOOK_SRC = path.join(PROJECT, "template/.claude/hooks/mcp-route-check.mjs.example");

const DIRECT = "https://n8n.example.com/mcp-server/http";
const LOOPBACK = "http://127.0.0.1:5680/mcp-server/http";

let seq = 0;
interface Case {
  /** The case root — the sync dir and the fake HOME both live under it. */
  base: string;
  /** The sync dir, with the hook installed at `.claude/hooks/`. */
  dir: string;
  home: string;
}

/**
 * A sync dir and an empty fake HOME, both under TMP. `sync` places the sync dir
 * relative to the case root (nest it to build a parent repo); `git` marks the
 * sync dir itself as a repo root, which is the standalone shape and bounds the
 * hook's ancestor walk at the sync dir — so these cases stay hermetic no matter
 * what sits above the temp dir.
 */
function scaffold({ sync = "proj", git = true }: { sync?: string; git?: boolean } = {}): Case {
  const base = path.join(TMP, `case-${seq++}`);
  const dir = path.join(base, sync);
  const home = path.join(base, "home");
  mkdirSync(path.join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(home, { recursive: true });
  copyFileSync(HOOK_SRC, path.join(dir, ".claude", "hooks", "mcp-route-check.mjs"));
  if (git) mkdirSync(path.join(dir, ".git"));
  return { base, dir, home };
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

/**
 * Drive the hook the way the harness does: the copy inside `sync`, spawned in
 * the sync dir — or, with `cwd`, from wherever the agent was actually started.
 */
function run(sync: string, home: string, cwd: string = sync): { code: number; out: string } {
  const hook = path.join(sync, ".claude", "hooks", "mcp-route-check.mjs");
  try {
    const out = execFileSync(process.execPath, [hook], {
      cwd,
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
    // The hook resolves the sync dir from its own module path, which node
    // realpaths — key the map the same way so the test holds on macOS's
    // symlinked /tmp.
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

  // Plan 81: the sync dir comes from the hook's own path, never from cwd.
  it("reads the sync dir's own config and proxy file when spawned elsewhere", () => {
    const { base, dir, home } = scaffold();
    writeJson(path.join(dir, ".mcp.json"), { mcpServers: { n8n: { url: DIRECT } } });
    writeJson(path.join(dir, ".decanter-proxy.json"), { url: "http://127.0.0.1:9999/mcp-server/http" });
    // an unrelated dir with its own offender — a cwd-relative read would find it
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeJson(path.join(elsewhere, ".mcp.json"), { mcpServers: { "cwd-n8n": { url: DIRECT } } });
    const { code, out } = run(dir, home, elsewhere);
    assert.equal(code, 0, out);
    assert.match(out, /"n8n" in \.mcp\.json/);
    assert.doesNotMatch(out, /cwd-n8n/);
    assert.match(out, /127\.0\.0\.1:9999/); // the sync dir's running guard, not the default hint
  });

  it("scans ancestors up to the git root — and not past it", () => {
    const { base, dir, home } = scaffold({ sync: "repo/flows", git: false });
    const repo = path.join(base, "repo");
    // `.git` as a FILE, the worktree/submodule shape — still the boundary
    writeFileSync(path.join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/repo\n");
    writeJson(path.join(repo, ".mcp.json"), { mcpServers: { "root-n8n": { url: DIRECT } } });
    writeJson(path.join(base, ".mcp.json"), { mcpServers: { "outside-n8n": { url: DIRECT } } });
    // the sync dir's own file keeps its bare label; the repo root's is relative
    writeJson(path.join(dir, ".mcp.json"), { mcpServers: { "own-n8n": { url: DIRECT } } });
    const { code, out } = run(dir, home, repo);
    assert.equal(code, 0, out);
    assert.match(out, /"own-n8n" in \.mcp\.json/);
    assert.match(out, /"root-n8n" in \.\.\/\.mcp\.json/);
    assert.doesNotMatch(out, /outside-n8n/);
  });

  // Plan 81 task 8a: Claude Code keys `projects` by the canonical git root, so
  // a nested sync dir's entry sits under an ANCESTOR's path. The cwd here is
  // the SYNC DIR (Option A, the recommended shape) precisely because that is
  // where the old `projects[process.cwd()]` lookup missed — spawning from the
  // git root instead would let the pre-fix code pass this test by accident.
  it("matches an ancestor projects[] key, without matching a same-prefix sibling", () => {
    const { base, dir, home } = scaffold({ sync: "repo/foobar", git: false });
    const repo = realpathSync(path.join(base, "repo"));
    mkdirSync(path.join(repo, ".git"));
    writeJson(path.join(home, ".claude.json"), {
      projects: {
        [repo]: { mcpServers: { "repo-n8n": { url: DIRECT } } },
        // `/…/repo/foo` is a prefix of the sync dir `/…/repo/foobar` as a
        // STRING, but not as a path — it must not match
        [path.join(repo, "foo")]: { mcpServers: { "sibling-n8n": { url: DIRECT } } },
      },
    });
    const { code, out } = run(realpathSync(dir), home);
    assert.equal(code, 0, out);
    assert.match(out, /"repo-n8n" in ~\/\.claude\.json \(entry for this project\)/);
    assert.doesNotMatch(out, /sibling-n8n/);
  });

  it("ignores a relative or empty projects[] key instead of resolving it against cwd", () => {
    const { dir, home } = scaffold();
    writeJson(path.join(home, ".claude.json"), {
      projects: {
        // `path.resolve("")` is cwd — which IS the sync dir here, so a key
        // resolved cwd-relatively would be mistaken for this project's entry
        "": { mcpServers: { "empty-key-n8n": { url: DIRECT } } },
        "relative/path": { mcpServers: { "relative-key-n8n": { url: DIRECT } } },
      },
    });
    const { code, out } = run(realpathSync(dir), home);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "");
  });

  it("names a user-level file once, even when the ancestor walk also reaches it", () => {
    // sync dir under a git-tracked $HOME: `~/.cursor/mcp.json` is both an
    // ancestor's CONFIG_FILES hit and the user-scope file
    const { base, dir, home } = scaffold({ sync: "home/flows", git: false });
    assert.equal(home, path.join(base, "home"));
    mkdirSync(path.join(home, ".git"));
    writeJson(path.join(home, ".cursor", "mcp.json"), { mcpServers: { "cursor-global": { url: DIRECT } } });
    // the hook compares `homedir()` against realpath-resolved scan dirs, so
    // hand it the realpath (macOS's symlinked /tmp would otherwise miss)
    const { code, out } = run(realpathSync(dir), realpathSync(home));
    assert.equal(code, 0, out);
    assert.match(out, /"cursor-global" in ~\/\.cursor\/mcp\.json/);
    assert.doesNotMatch(out, /\.\.\/\.cursor\/mcp\.json/);
    assert.equal(out.match(/cursor-global/g)?.length, 1);
  });
});
