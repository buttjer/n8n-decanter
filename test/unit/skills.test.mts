// Plan 55 — the pure core of init's n8n skills pointer: agent detection, the
// pinned command table, and when init mentions the pack at all. Nothing here
// (or in lib/skills.mts) runs an installer — the commands are data to print.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { activationHint, detectAgent, routeOrder, skillsCommands, SKILLS_PLUGIN, SKILLS_REPO } from "../../lib/skills.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-skills-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A dir on PATH holding an executable-looking `name` (contents irrelevant). */
function fakeBinDir(name: string): string {
  const dir = path.join(TMP, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  if (process.platform === "win32") writeFileSync(path.join(dir, `${name}.cmd`), "");
  return dir;
}

/** A home dir carrying only the given agent marker dir. */
function fakeHome(marker: string): string {
  const dir = path.join(TMP, `home-${marker.replace(".", "")}`);
  mkdirSync(path.join(dir, marker), { recursive: true });
  return dir;
}

const EMPTY_HOME = path.join(TMP, "home-empty");
mkdirSync(EMPTY_HOME, { recursive: true });

describe("detectAgent", () => {
  it("prefers the env of the agent we are running inside", () => {
    // env beats a PATH that says otherwise — running inside Codex while `claude`
    // happens to be installed must still list Codex first.
    assert.equal(detectAgent({ CODEX_HOME: "/x" }, fakeBinDir("claude"), EMPTY_HOME), "codex");
    assert.equal(detectAgent({ CLAUDECODE: "1" }, fakeBinDir("codex"), EMPTY_HOME), "claude-code");
    assert.equal(detectAgent({ CLAUDE_CODE_CHILD_SESSION: "1" }, undefined, EMPTY_HOME), "claude-code");
  });

  it("falls back to a binary on PATH, then to a home-dir marker", () => {
    assert.equal(detectAgent({}, fakeBinDir("claude"), EMPTY_HOME), "claude-code");
    assert.equal(detectAgent({}, fakeBinDir("codex"), EMPTY_HOME), "codex");
    assert.equal(detectAgent({}, "", fakeHome(".claude")), "claude-code");
    assert.equal(detectAgent({}, "", fakeHome(".codex")), "codex");
  });

  it("returns null when nothing points at an agent", () => {
    assert.equal(detectAgent({}, path.join(TMP, "nope"), EMPTY_HOME), null);
    assert.equal(detectAgent({}, undefined, EMPTY_HOME), null);
  });
});

describe("skillsCommands", () => {
  // Pinned on purpose: n8n owns the marketplace/plugin names, and a rename
  // should be a deliberate edit here rather than a 404 in a user's terminal.
  it("pins the Claude Code route to the SHELL CLI, not the /plugin slash commands", () => {
    assert.deepEqual(skillsCommands("claude-code"), [
      ["claude", "plugin", "marketplace", "add", "n8n-io/skills"],
      ["claude", "plugin", "install", "n8n-skills@n8n-io"],
    ]);
  });

  it("pins the Codex route", () => {
    assert.deepEqual(skillsCommands("codex"), [
      ["codex", "plugin", "marketplace", "add", "n8n-io/skills"],
      ["codex", "plugin", "add", "n8n-skills@n8n-io"],
    ]);
  });

  it("gives skills.sh -y but never -a: it is the route for agents we did NOT detect", () => {
    assert.deepEqual(skillsCommands("skills-sh"), [["npx", "skills", "add", "n8n-io/skills", "-y"]]);
  });

  it("keeps the repo/plugin ids in one place", () => {
    assert.equal(SKILLS_REPO, "n8n-io/skills");
    assert.equal(SKILLS_PLUGIN, "n8n-skills@n8n-io");
  });

  it("names the activation step each route still needs", () => {
    assert.match(activationHint("claude-code"), /reload-plugins/);
    assert.match(activationHint("codex"), /0\.142\.0/);
    assert.match(activationHint("skills-sh"), /AGENTS\.md/);
  });
});

describe("routeOrder", () => {
  it("lists the detected agent first but never drops the others", () => {
    assert.deepEqual(routeOrder("codex"), ["codex", "claude-code", "skills-sh"]);
    assert.deepEqual(routeOrder("claude-code"), ["claude-code", "codex", "skills-sh"]);
    assert.deepEqual(routeOrder(null), ["claude-code", "codex", "skills-sh"]);
  });
});

// When the block is printed (first init only) is asserted end-to-end in
// test/e2e.mts — it is a one-line condition on init's existing `firstInit`.
