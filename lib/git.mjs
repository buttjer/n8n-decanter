import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Best-effort git commit of one workflow folder after a successful sync.
 * Never fails the sync: no git / not a repo / mid-merge all degrade to a
 * warning. The commit is pathspec-scoped to the folder, so staged-but-
 * unrelated changes elsewhere in the repo stay untouched and unstaged.
 * `extraPaths` (relative to dir) covers a renamed-away old folder, whose
 * deletions live outside the new folder's pathspec.
 */
export async function commitWorkflowDir(dir, message, log, extraPaths = []) {
  try {
    await execFile("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    log.warn('not inside a git repository — skipping commit ("commitOnPush"/"commitOnPull": false silences this)');
    return false;
  }
  try {
    const spec = ["."];
    for (const p of extraPaths) {
      // only include extra paths that actually carry changes — an unmatched
      // pathspec would make add/commit fail
      const { stdout } = await execFile("git", ["-C", dir, "status", "--porcelain", "--", p]);
      if (stdout.trim() !== "") spec.push(p);
    }
    await execFile("git", ["-C", dir, "add", "-A", "--", ...spec]);
    const { stdout } = await execFile("git", ["-C", dir, "status", "--porcelain", "--", ...spec]);
    if (stdout.trim() === "") return false; // nothing changed under this folder
    await execFile("git", ["-C", dir, "commit", "-m", message, "--", ...spec]);
    log.info(`committed: ${message}`);
    return true;
  } catch (err) {
    const detail = (err.stderr || err.message || "").toString().trim().split("\n")[0];
    log.warn(`git commit failed (${detail}) — push succeeded, commit skipped`);
    return false;
  }
}
