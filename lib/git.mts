import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Log } from "./types.mts";

const execFile = promisify(execFileCb);

/** True when `dir` sits inside a git work tree (the live-mirror safety-net gate). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFile("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Outcome of a commit attempt; "failed" covers no-git and not-a-repo too. */
export type CommitResult = "committed" | "clean" | "failed";

/**
 * Best-effort git commit of one workflow folder after a successful sync.
 * Never fails the sync: no git / not a repo / mid-merge all degrade to a
 * warning ("failed"); a tree with nothing to commit reports "clean". The
 * commit is pathspec-scoped to the folder, so staged-but-unrelated changes
 * elsewhere in the repo stay untouched and unstaged. `extraPaths` (relative
 * to dir) covers a renamed-away old folder, whose deletions live outside the
 * new folder's pathspec.
 */
export async function commitWorkflowDir(dir: string, message: string, log: Log, extraPaths: string[] = []): Promise<CommitResult> {
  try {
    await execFile("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    log.warn('not inside a git repository — skipping commit ("commitOnPush"/"commitOnPull": false silences this)');
    return "failed";
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
    if (stdout.trim() === "") return "clean"; // nothing changed under this folder
    await execFile("git", ["-C", dir, "commit", "-m", message, "--", ...spec]);
    log.info(`committed: ${message}`);
    return "committed";
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr || e.message || "").toString().trim().split("\n")[0];
    log.warn(`git commit failed (${detail}) — push succeeded, commit skipped`);
    return "failed";
  }
}
