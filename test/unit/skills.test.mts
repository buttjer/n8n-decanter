// Plan 55 — the pure core of the init-time n8n skills offer: agent detection,
// the pinned installer command table, and the answer parser. Nothing here runs
// an installer; the whole point of the module is that the argv is data.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  detectAgent,
  isSkillsTarget,
  parseSkillsAnswer,
  resolveSkillsTarget,
  skillsCommands,
  SKILLS_PLUGIN,
  SKILLS_REPO,
  SKILLS_TARGETS,
} from "../../lib/skills.mts";

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
    // happens to be installed must still default to Codex.
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

  it("passes skills.sh the detected agent, and -y so it never blocks on its own prompt", () => {
    assert.deepEqual(skillsCommands("skills-sh", "claude-code"), [["npx", "skills", "add", "n8n-io/skills", "-y", "-a", "claude-code"]]);
    assert.deepEqual(skillsCommands("skills-sh", "codex"), [["npx", "skills", "add", "n8n-io/skills", "-y", "-a", "codex"]]);
    assert.deepEqual(skillsCommands("skills-sh", null), [["npx", "skills", "add", "n8n-io/skills", "-y"]]);
  });

  it("runs nothing for the no-install targets", () => {
    assert.deepEqual(skillsCommands("none"), []);
    assert.deepEqual(skillsCommands("print"), []);
  });

  it("keeps the repo/plugin ids in one place", () => {
    assert.equal(SKILLS_REPO, "n8n-io/skills");
    assert.equal(SKILLS_PLUGIN, "n8n-skills@n8n-io");
  });
});

describe("parseSkillsAnswer", () => {
  it("takes a bare Enter as the detected agent", () => {
    assert.equal(parseSkillsAnswer("", "claude-code"), "claude-code");
    assert.equal(parseSkillsAnswer("  ", "codex"), "codex");
  });

  it("falls back to printing when nothing was detected", () => {
    assert.equal(parseSkillsAnswer("", null), "print");
  });

  it("accepts the number or a name prefix", () => {
    assert.equal(parseSkillsAnswer("1", null), "claude-code");
    assert.equal(parseSkillsAnswer("Claude", null), "claude-code");
    assert.equal(parseSkillsAnswer("2", null), "codex");
    assert.equal(parseSkillsAnswer("codex", null), "codex");
    assert.equal(parseSkillsAnswer("3", null), "skills-sh");
    assert.equal(parseSkillsAnswer("other", null), "skills-sh");
    assert.equal(parseSkillsAnswer("skills.sh", null), "skills-sh");
  });

  it("never installs on a garbled answer — unknown input only prints", () => {
    assert.equal(parseSkillsAnswer("4", "claude-code"), "print");
    assert.equal(parseSkillsAnswer("yes please", "claude-code"), "print");
    assert.equal(parseSkillsAnswer("!!", "codex"), "print");
  });
});

describe("resolveSkillsTarget", () => {
  const base = { flag: undefined, interactive: false, flagDriven: false, firstInit: true };

  it("asks only on a first init, on a TTY, with no flag and no --host/--token", () => {
    assert.equal(resolveSkillsTarget({ ...base, interactive: true }), "ask");
  });

  it("never asks a piped run — it prints instead, so scripts keep their stdin", () => {
    assert.equal(resolveSkillsTarget(base), "print");
  });

  it("never asks the --host/--token path, which stays prompt-free", () => {
    assert.equal(resolveSkillsTarget({ ...base, interactive: true, flagDriven: true }), "print");
  });

  it("goes silent on a re-init — the offer is made once", () => {
    assert.equal(resolveSkillsTarget({ ...base, interactive: true, firstInit: false }), "none");
    assert.equal(resolveSkillsTarget({ ...base, firstInit: false }), "none");
  });

  it("lets an explicit --skills win everywhere, re-init included", () => {
    assert.equal(resolveSkillsTarget({ ...base, flag: "codex", interactive: true }), "codex");
    assert.equal(resolveSkillsTarget({ ...base, flag: "none", interactive: true }), "none");
    assert.equal(resolveSkillsTarget({ ...base, flag: "print", firstInit: false }), "print");
    assert.equal(resolveSkillsTarget({ ...base, flag: "claude-code", flagDriven: true, firstInit: false }), "claude-code");
  });
});

describe("isSkillsTarget", () => {
  it("accepts exactly the documented --skills values", () => {
    for (const t of SKILLS_TARGETS) assert.ok(isSkillsTarget(t));
    assert.ok(!isSkillsTarget("claude"));
    assert.ok(!isSkillsTarget(""));
  });
});
