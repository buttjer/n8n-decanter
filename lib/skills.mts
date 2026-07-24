// Plan 55 — point a fresh sync dir at the official n8n skills pack
// (n8n-io/skills, Apache-2.0). decanter owns Code-node source; n8n's skills
// teach the agent everything else, so the two pair by design
// (docs/agents/n8n-skills.md) — but the pairing was documented only on a page
// users read *after* setup. A first `init` now names it and prints the exact
// commands for the agent it detects.
//
// It PRINTS; it does not install. decanter deliberately spawns no installer:
// `claude`/`codex`/`npx skills` are three third-party CLIs with their own
// version floors, they mutate user-global agent state a directory bootstrapper
// has no business touching, and a plugin installed mid-session isn't active
// until the agent reloads — so the subprocess buys the user nothing a printed
// command doesn't. Actually installing is Plan 56's job, declaratively.
//
// Three upstream facts the printed commands depend on (verified 2026-07-24):
//   - Claude Code's `/plugin …` are IN-SESSION slash commands, not shell. The
//     shell equivalents are `claude plugin marketplace add <repo>` and
//     `claude plugin install <plugin>@<marketplace>`.
//   - Codex's ARE shell commands, but need Codex >= 0.142.0.
//   - `npx skills` is vercel-labs/skills, NOT an n8n artifact, and that route
//     ships no SessionStart router — which is why the scaffolded AGENTS.md
//     carries the `using-n8n-skills-official` routing cue instead.
//
// Not used on purpose: Claude Code's `<claude-code-hint …/>` stderr protocol,
// which would let decanter make Claude Code itself offer the install. Hints are
// silently dropped unless the plugin sits in an Anthropic-controlled
// marketplace, and `n8n-skills@n8n-io` is third-party. Revisit if that changes.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { style } from "./style.mts";
import type { Log } from "./types.mts";

/** The marketplace repo and the plugin id inside it (n8n owns both strings). */
export const SKILLS_REPO = "n8n-io/skills";
export const SKILLS_PLUGIN = "n8n-skills@n8n-io";
export const SKILLS_DOCS = "https://n8n-decanter.dev/docs/agents/n8n-skills/";

/** The install routes we know commands for. */
export type SkillsRoute = "claude-code" | "codex" | "skills-sh";

/** The agents decanter can recognize from the environment. */
export type DetectedAgent = "claude-code" | "codex";

const ROUTE_LABEL: Record<SkillsRoute, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "skills-sh": "other agents (skills.sh)",
};

/** Is `bin` on this PATH? A split + existsSync — deliberately spawns nothing. */
function onPath(bin: string, pathValue: string | undefined): boolean {
  if (pathValue === undefined || pathValue === "") return false;
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  return pathValue.split(path.delimiter).some((dir) => dir !== "" && exts.some((ext) => existsSync(path.join(dir, bin + ext))));
}

/**
 * Best guess at which coding agent this user drives — it only decides which
 * route is listed first and marked `(detected)`; every route is always printed.
 * Precedence: running *inside* an agent beats having its binary installed,
 * which beats a stale home-dir marker. Pure apart from `existsSync`.
 */
export function detectAgent(env: NodeJS.ProcessEnv = process.env, pathValue: string | undefined = process.env.PATH, homeDir: string = os.homedir()): DetectedAgent | null {
  if (env.CLAUDECODE !== undefined || env.CLAUDE_CODE_CHILD_SESSION !== undefined) return "claude-code";
  if (env.CODEX_HOME !== undefined || env.CODEX_SANDBOX !== undefined) return "codex";
  if (onPath("claude", pathValue)) return "claude-code";
  if (onPath("codex", pathValue)) return "codex";
  if (homeDir !== "" && existsSync(path.join(homeDir, ".claude"))) return "claude-code";
  if (homeDir !== "" && existsSync(path.join(homeDir, ".codex"))) return "codex";
  return null;
}

/**
 * The commands a route needs, in order. Pinned by a unit test: n8n can rename
 * the marketplace or the plugin, and that should be a deliberate edit here
 * rather than a 404 in a user's terminal.
 */
export function skillsCommands(route: SkillsRoute): string[][] {
  switch (route) {
    case "claude-code":
      return [
        ["claude", "plugin", "marketplace", "add", SKILLS_REPO],
        ["claude", "plugin", "install", SKILLS_PLUGIN],
      ];
    case "codex":
      return [
        ["codex", "plugin", "marketplace", "add", SKILLS_REPO],
        ["codex", "plugin", "add", SKILLS_PLUGIN],
      ];
    case "skills-sh":
      // -y skips skills.sh's own confirmations. No `-a <agent>`: this route is
      // the one for agents decanter did NOT detect, so naming one would
      // contradict the heading — skills.sh auto-detects what's installed.
      return [["npx", "skills", "add", SKILLS_REPO, "-y"]];
  }
}

/** What the user must still do for the pack to load once installed. */
export function activationHint(route: SkillsRoute): string {
  switch (route) {
    case "claude-code":
      return "then /reload-plugins (or restart Claude Code)";
    case "codex":
      return "then restart Codex and approve the plugin's hooks (needs Codex >= 0.142.0)";
    case "skills-sh":
      return "no plugin hooks on this route — the scaffolded AGENTS.md carries the routing cue it needs";
  }
}

/** Detected route first, then the rest — every route is always listed. */
export function routeOrder(detected: DetectedAgent | null): SkillsRoute[] {
  const rest: SkillsRoute[] = (["claude-code", "codex", "skills-sh"] as SkillsRoute[]).filter((r) => r !== detected);
  return detected !== null ? [detected, ...rest] : rest;
}

/**
 * The recommendation block — the whole feature. Names the pack, says why it
 * matters here, and prints copy-pasteable commands for every route. `init`
 * calls it once, on a first init; there is no flag to tune it, because a few
 * lines printed once per sync dir is not worth a CLI surface.
 */
export function printSkillsRecommendation(detected: DetectedAgent | null, log: Log): void {
  log.info("");
  log.info(`${style.bold("Recommended:")} n8n's official skills pack (${SKILLS_REPO}) — it teaches your agent to`);
  log.info("build workflow structure over MCP while decanter keeps every Code node a file.");
  for (const route of routeOrder(detected)) {
    log.info(`  ${style.bold(ROUTE_LABEL[route])}${route === detected ? style.green(" (detected)") : ""}`);
    for (const argv of skillsCommands(route)) log.info(`    ${argv.join(" ")}`);
    log.info(style.dim(`    ${activationHint(route)}`));
  }
  log.info(style.dim(`  guide: ${SKILLS_DOCS}`));
}
