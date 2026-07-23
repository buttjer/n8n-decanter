// Plan 35 field test — install the official n8n skills pack (n8n-io/skills,
// Apache-2.0) into a scratch project's agent config, so blind sessions see the
// same grounding a real user's agent would.
//
// Fidelity note (recorded in the manifest + report): the *official* install is a
// Claude Code PLUGIN (`/plugin install n8n-skills@n8n-io`) — skills PLUS a
// SessionStart router and PreToolUse hooks that instrument the n8n MCP calls,
// registered user-global and `plugin:`-namespaced. That flow is interactive and
// non-deterministic. The headless-reproducible replica here vendors the 14
// `skills/*` dirs into `<workDir>/.claude/skills/` (auto-discovered by
// `claude -p`, no config) and reproduces the SessionStart cue as an AGENTS.md
// snippet (the plain-skills route the pack documents for "other platforms"). It
// does NOT reproduce the plugin's hooks or namespacing — grade with that in mind
// (a Code-node write nudged over MCP still hits the guard either way).
import { execFile as execFileCb } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const SKILLS_REPO = process.env.FIELD_SKILLS_REPO ?? "https://github.com/n8n-io/skills";

/**
 * The SessionStart routing cue the pack documents for plain-skills installs (no
 * plugin, so no SessionStart hook). Appended to the scratch project's AGENTS.md
 * by the orchestrator after `init` scaffolds it — mirrors README "Other
 * platforms". Verbatim intent, not a fork of the pack.
 */
export const SESSION_START_NUDGE = `
## n8n skills (auto-loaded)

This project uses n8n. When working with workflows, nodes, expressions, or the
n8n MCP tools, always start by loading the \`using-n8n-skills-official\`
meta-skill and follow its routing into the matching capability skill before
acting.
`;

export interface SkillsInstall {
  dest: string;
  count: number;
  /** false when the clone failed (offline) — the run proceeds without the pack. */
  found: boolean;
  license: string | null;
  fidelity: string;
}

/** Directories (recursively) that directly contain a SKILL.md — one Claude Code skill each. */
function findSkillDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) { out.push(dir); return; }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") walk(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

/**
 * Install the n8n skills pack into `<workDir>/.claude/skills/`. Best-effort:
 * never throws — a failed clone returns `found: false` and an empty skills dir.
 */
export async function installSkillsPack(workDir: string): Promise<SkillsInstall> {
  const dest = path.join(workDir, ".claude", "skills");
  mkdirSync(dest, { recursive: true });
  const fidelity = "vendored skills/* only — no plugin hooks / SessionStart router / plugin: namespacing (see skills-install.mts header)";
  const tmp = mkdtempSync(path.join(os.tmpdir(), "n8n-skills-"));
  try {
    await execFile("git", ["clone", "--depth", "1", SKILLS_REPO, tmp], { encoding: "utf8" });
    const skillDirs = findSkillDirs(tmp);
    if (skillDirs.length === 0) {
      console.warn(`skills-install: cloned ${SKILLS_REPO} but found no SKILL.md — check the repo layout; leaving skills dir empty`);
      return { dest, count: 0, found: true, license: null, fidelity };
    }
    for (const src of skillDirs) cpSync(src, path.join(dest, path.basename(src)), { recursive: true });
    // Apache-2.0 attribution: keep the LICENSE alongside the vendored copies
    let license: string | null = null;
    for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
      if (existsSync(path.join(tmp, name))) { copyFileSync(path.join(tmp, name), path.join(dest, name)); license = "Apache-2.0"; break; }
    }
    console.log(`skills-install: vendored ${skillDirs.length} skill(s) from ${SKILLS_REPO} -> ${dest}${license ? " (+ LICENSE)" : ""}`);
    return { dest, count: skillDirs.length, found: true, license, fidelity };
  } catch (err) {
    console.warn(`skills-install: could not clone ${SKILLS_REPO} (${(err as Error).message.split("\n")[0]}) — the field test will run WITHOUT the skills pack; note this in the report`);
    return { dest, count: 0, found: false, license: null, fidelity: "PACK ABSENT — clone failed" };
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}
