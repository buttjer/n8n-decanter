import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Best-effort git commit of one workflow folder after a successful push.
 * Never fails the push: no git / not a repo / mid-merge all degrade to a
 * warning. The commit is pathspec-scoped to the folder, so staged-but-
 * unrelated changes elsewhere in the repo stay untouched and unstaged.
 */
export async function commitWorkflowDir(dir, message, log) {
  try {
    await execFile("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    log.warn('not inside a git repository — skipping commit ("commitOnPush": false silences this)');
    return false;
  }
  try {
    await execFile("git", ["-C", dir, "add", "-A", "--", "."]);
    const { stdout } = await execFile("git", ["-C", dir, "status", "--porcelain", "--", "."]);
    if (stdout.trim() === "") return false; // nothing changed under this folder
    await execFile("git", ["-C", dir, "commit", "-m", message, "--", "."]);
    log.info(`committed: ${message}`);
    return true;
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().trim().split("\n")[0];
    log.warn(`git commit failed (${detail}) — push succeeded, commit skipped`);
    return false;
  }
}
