// Plan 55 — offer the official n8n skills pack (n8n-io/skills, Apache-2.0) at
// the tail of a first `init`. decanter owns Code-node source; n8n's skills teach
// the agent everything else, so the two pair by design (docs/agents/n8n-skills.md).
//
// Three upstream facts shape this module — all verified 2026-07-24:
//   - Claude Code's `/plugin …` are IN-SESSION slash commands, not shell. The
//     scriptable equivalents are `claude plugin marketplace add <repo>` and
//     `claude plugin install <plugin>@<marketplace>` (user scope unless
//     `--scope`), and the installed plugin needs `/reload-plugins` (or a
//     restart) before the running session sees it.
//   - Codex's are genuine shell commands, but need Codex >= 0.142.0.
//   - `npx skills` is vercel-labs/skills, NOT an n8n artifact: it prompts unless
//     given `-y`, and that route has no SessionStart hook — the scaffolded
//     AGENTS.md carries the `using-n8n-skills-official` routing cue instead.
//
// Not used here on purpose: Claude Code's `<claude-code-hint …/>` stderr
// protocol, which would let decanter make Claude Code itself offer the install.
// Hints are silently dropped unless the plugin sits in an Anthropic-controlled
// marketplace, and `n8n-skills@n8n-io` is third-party. Revisit if that changes.
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { style } from "./style.mts";
import type { Log } from "./types.mts";

const execFile = promisify(execFileCb);

/** The marketplace repo and the plugin id inside it (n8n owns both strings). */
export const SKILLS_REPO = "n8n-io/skills";
export const SKILLS_PLUGIN = "n8n-skills@n8n-io";
export const SKILLS_DOCS = "https://n8n-decanter.dev/docs/agents/n8n-skills/";

/** How long a single installer command may run before it is given up on. */
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * What `init` should do about the skills pack. `print` shows the commands
 * without running anything (the piped / re-init / no-detection default);
 * `none` stays silent entirely.
 */
export type SkillsTarget = "claude-code" | "codex" | "skills-sh" | "none" | "print";

/** The agents whose install decanter can actually drive. */
export type DetectedAgent = "claude-code" | "codex";

export const SKILLS_TARGETS: readonly SkillsTarget[] = ["claude-code", "codex", "skills-sh", "none", "print"];

export function isSkillsTarget(value: string): value is SkillsTarget {
  return (SKILLS_TARGETS as readonly string[]).includes(value);
}

const AGENT_LABEL: Record<DetectedAgent, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** `skills add --agent` names for the agents we can detect (skills.sh vocabulary). */
const SKILLS_SH_AGENT: Record<DetectedAgent, string> = { "claude-code": "claude-code", codex: "codex" };

/** Is `bin` on this PATH? A split + existsSync — deliberately spawns nothing. */
function onPath(bin: string, pathValue: string | undefined): boolean {
  if (pathValue === undefined || pathValue === "") return false;
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  return pathValue.split(path.delimiter).some((dir) => dir !== "" && exts.some((ext) => existsSync(path.join(dir, bin + ext))));
}

/**
 * Best guess at which coding agent this user drives, used only to pre-select the
 * default answer — the user always chooses. Precedence: running *inside* an
 * agent beats having its binary installed, which beats a stale home-dir marker.
 * Pure apart from `existsSync`, so it unit-tests without an environment.
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
 * The exact argv the chosen route runs, in order. Pinned by a unit test: n8n can
 * rename the marketplace or the plugin, and that should be a deliberate edit
 * here rather than a silent 404 in a user's terminal.
 */
export function skillsCommands(target: SkillsTarget, detected: DetectedAgent | null = null): string[][] {
  switch (target) {
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
      // -y skips skills.sh's own confirmations; -a pins the target agent when we
      // know it (without it the CLI auto-detects, and prompts when it can't).
      return [["npx", "skills", "add", SKILLS_REPO, "-y", ...(detected !== null ? ["-a", SKILLS_SH_AGENT[detected]] : [])]];
    case "none":
    case "print":
      return [];
  }
}

/** What the user must do after an install for the pack to actually load. */
function activationHint(target: SkillsTarget): string | null {
  switch (target) {
    case "claude-code":
      return "run /reload-plugins (or restart Claude Code) to activate the pack";
    case "codex":
      return "restart Codex — it will ask once to trust the plugin's hooks; approve them";
    case "skills-sh":
      return "start a new agent session; the scaffolded AGENTS.md carries the routing cue this route needs";
    default:
      return null;
  }
}

const quote = (argv: string[]): string => argv.join(" ");

/**
 * The no-install path: show what to run, so a piped run, a re-init, or a "skip"
 * still leaves the user one copy-paste away. Prints the detected agent's route
 * first, then the others.
 */
export function printSkillsRecommendation(detected: DetectedAgent | null, log: Log): void {
  log.info("");
  log.info(`${style.bold("Recommended:")} n8n's official skills pack (${SKILLS_REPO}) — it teaches your agent to build`);
  log.info("workflow structure over MCP while decanter keeps every Code node a file.");
  const order: SkillsTarget[] = detected === "codex" ? ["codex", "claude-code", "skills-sh"] : ["claude-code", "codex", "skills-sh"];
  for (const target of order) {
    const label = target === "skills-sh" ? "other agents (skills.sh)" : AGENT_LABEL[target as DetectedAgent];
    const mark = target === detected ? " (detected)" : "";
    log.info(`  ${style.bold(label + mark)}`);
    for (const argv of skillsCommands(target, detected)) log.info(`    ${quote(argv)}`);
  }
  log.info(style.dim(`  guide: ${SKILLS_DOCS}`));
}

/**
 * Run the chosen route. Best-effort by contract: every command is echoed before
 * it runs, stdio is inherited (these installers talk to the user), and any
 * failure degrades to a warning plus the manual commands — `init` must never
 * fail because a third-party CLI is missing or out of date.
 */
export async function runSkillsInstall(target: SkillsTarget, cwd: string, detected: DetectedAgent | null, log: Log): Promise<boolean> {
  const commands = skillsCommands(target, detected);
  if (commands.length === 0) return false;
  for (const argv of commands) {
    log.info(`  ${style.dim("$")} ${quote(argv)}`);
    try {
      await execFile(argv[0]!, argv.slice(1), { cwd, timeout: INSTALL_TIMEOUT_MS, encoding: "utf8" });
    } catch (err) {
      const e = err as Error & { code?: string | number };
      const reason = e.code === "ENOENT" ? `${argv[0]} is not installed (or not on PATH)` : e.message.split("\n")[0];
      log.warn(`skills install stopped at \`${quote(argv)}\` — ${reason}`);
      log.info("  run the commands above by hand once the tool is available:");
      for (const rest of commands) log.info(`    ${quote(rest)}`);
      log.info(style.dim(`  guide: ${SKILLS_DOCS}`));
      return false;
    }
  }
  log.ok(`installed the official n8n skills (${SKILLS_REPO})`);
  const hint = activationHint(target);
  if (hint !== null) log.info(style.dim(`  ${hint}`));
  return true;
}

/**
 * Which route `init` takes without asking, or `"ask"` when it should put the
 * question to the user. Pure, so the whole matrix (flag / TTY / first-init) is
 * unit-tested — the readline round-trip on a real terminal is the only part
 * left to the CLI.
 */
export function resolveSkillsTarget({ flag, interactive, flagDriven, firstInit }: { flag: SkillsTarget | undefined; interactive: boolean; flagDriven: boolean; firstInit: boolean }): SkillsTarget | "ask" {
  if (flag !== undefined) return flag; // explicit wins everywhere, re-init included
  if (interactive && !flagDriven && firstInit) return "ask";
  // A piped or --host-driven FIRST init still deserves the pointer; a re-init
  // has already had it and stays quiet.
  return firstInit ? "print" : "none";
}

/**
 * The interactive four-way question. A bare Enter takes the detected agent, and
 * anything unrecognized falls to `print` — a garbled answer must never install
 * third-party software. `none` (fully silent) is reachable only via `--skills`.
 */
export function parseSkillsAnswer(answer: string, detected: DetectedAgent | null): SkillsTarget {
  const a = answer.trim().toLowerCase();
  if (a === "") return detected ?? "print";
  if (a === "1" || a.startsWith("cl")) return "claude-code";
  if (a === "2" || a.startsWith("co")) return "codex";
  if (a === "3" || a.startsWith("o") || a.startsWith("s")) return "skills-sh";
  return "print";
}

/** The prompt text — detected agent marked, and named as the Enter default. */
export function skillsPromptLines(detected: DetectedAgent | null): string[] {
  const mark = (t: DetectedAgent): string => (t === detected ? style.green(" (detected)") : "");
  return [
    "",
    `Install n8n's official skills pack? ${style.dim("— recommended for agentic workflow building")}`,
    `  1) Claude Code${mark("claude-code")}`,
    `  2) Codex${mark("codex")}`,
    "  3) Other agent (skills.sh)",
    "  4) Skip — just print the commands",
  ];
}

/** `[1] ` when Claude Code was detected, `[4] ` when nothing was. */
export function skillsPromptQuestion(detected: DetectedAgent | null): string {
  const def = detected === "claude-code" ? "1" : detected === "codex" ? "2" : "4";
  return `Choice [${def}]: `;
}
