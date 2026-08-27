// The linked-worktree credential fallback: every credential file decanter
// needs is gitignored, so a fresh worktree has none and every credentialed
// verb — `mcp connect` included — dies before it can say why. `credentialFile`
// reads the main checkout's copy instead, and for the OAuth auth file that is
// the only correct shape (one rotating single-use token, one writer).
//
// `mainCheckoutTwin` is pure filesystem, so most of this builds the layouts by
// hand — but one case drives a REAL `git worktree add`, because a hand-built
// fixture can only prove the resolver matches my idea of the layout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { credentialFile, mainCheckoutTwin } from "../../lib/git.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-worktree-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A dir under TMP, created. */
function dir(...segments: string[]): string {
  const d = path.join(TMP, ...segments);
  mkdirSync(d, { recursive: true });
  return d;
}

/** A real git repo with one commit, so `git worktree add` has a HEAD to branch. */
function realRepo(name: string): string {
  const repo = dir(name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  mkdirSync(path.join(repo, "flows"), { recursive: true });
  writeFileSync(path.join(repo, "flows", "decanter.config.json"), '{"root":"./workflows","workflows":[]}\n');
  git("add", "-A");
  git("commit", "-m", "init");
  return repo;
}

describe("mainCheckoutTwin", () => {
  it("is null in a plain checkout (.git is a directory)", () => {
    const repo = dir("plain");
    mkdirSync(path.join(repo, ".git"));
    assert.equal(mainCheckoutTwin(repo), null);
    assert.equal(mainCheckoutTwin(dir("plain", "flows")), null);
  });

  it("is null outside any repository", () => {
    assert.equal(mainCheckoutTwin(dir("loose", "flows")), null);
  });

  it("is null for a submodule, whose .git is also a file", () => {
    // A submodule points into .git/modules/<name>, not .git/worktrees/<name> —
    // resolving it against the superproject would be flatly wrong.
    const sub = dir("super", "sub");
    writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    mkdirSync(path.join(TMP, "super", ".git", "modules", "sub"), { recursive: true });
    assert.equal(mainCheckoutTwin(sub), null);
  });

  it("maps a real linked worktree's sync dir onto the main checkout's", () => {
    const repo = realRepo("real");
    const wt = path.join(TMP, "real-wt");
    execFileSync("git", ["worktree", "add", "-b", "probe", wt, "main"], { cwd: repo, stdio: "ignore" });

    assert.equal(mainCheckoutTwin(wt), repo);
    assert.equal(mainCheckoutTwin(path.join(wt, "flows")), path.join(repo, "flows"));
    // The main checkout itself has no twin.
    assert.equal(mainCheckoutTwin(path.join(repo, "flows")), null);
  });
});

describe("credentialFile", () => {
  const NAME = ".env";

  it("returns the local file when this dir has its own", () => {
    const repo = realRepo("local-wins");
    const wt = path.join(TMP, "local-wins-wt");
    execFileSync("git", ["worktree", "add", "-b", "probe2", wt, "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(path.join(repo, "flows", NAME), "N8N_HOST=http://main\n");
    writeFileSync(path.join(wt, "flows", NAME), "N8N_HOST=http://staging\n");

    // A worktree deliberately pointed at another instance keeps its own.
    assert.equal(credentialFile(path.join(wt, "flows"), NAME), path.join(wt, "flows", NAME));
  });

  it("falls back to the main checkout's copy when the worktree has none", () => {
    const repo = realRepo("fallback");
    const wt = path.join(TMP, "fallback-wt");
    execFileSync("git", ["worktree", "add", "-b", "probe3", wt, "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(path.join(repo, "flows", NAME), "N8N_HOST=http://main\n");

    assert.equal(credentialFile(path.join(wt, "flows"), NAME), path.join(repo, "flows", NAME));
  });

  it("returns the local path when neither side has the file", () => {
    // So the resulting "not set" error still names the file the user creates.
    const repo = realRepo("neither");
    const wt = path.join(TMP, "neither-wt");
    execFileSync("git", ["worktree", "add", "-b", "probe4", wt, "main"], { cwd: repo, stdio: "ignore" });

    assert.equal(credentialFile(path.join(wt, "flows"), NAME), path.join(wt, "flows", NAME));
  });

  it("is the plain local path outside a worktree", () => {
    const plain = dir("no-repo");
    assert.equal(credentialFile(plain, NAME), path.join(plain, NAME));
  });
});
