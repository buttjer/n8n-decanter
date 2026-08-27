import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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

// ---------- linked worktrees ----------

/**
 * The main checkout's twin of `dir`, or `null` when `dir` is not inside a
 * linked git worktree.
 *
 * Pure filesystem reads — deliberately no `git` subprocess. The callers
 * (`loadEnv`, `resolveMcpAuth`) are synchronous and sit on the startup path of
 * `mcp connect`, which an agent spawns once per session; a spawn there would be
 * paid on every session start of every agent.
 *
 * The walk: a linked worktree's `.git` is a FILE holding
 * `gitdir: <main>/.git/worktrees/<name>`, and that directory's `commondir` file
 * points back at the shared git dir (`../..`), whose parent is the main
 * checkout. A submodule's `.git` is a file too, but points into
 * `.git/modules/<name>` — the `worktrees` parent segment is what tells the two
 * apart, and a submodule must NOT resolve against its superproject.
 *
 * The twin is a path, not a promise that anything exists there: the sync dir is
 * tracked content (`decanter.config.json` is committed), so its path relative
 * to the checkout root is identical on both sides — but a worktree branched
 * from before the sync dir existed has no twin on disk. Callers check.
 */
export function mainCheckoutTwin(dir: string): string | null {
  const resolved = path.resolve(dir);
  let root = resolved;
  while (!existsSync(path.join(root, ".git"))) {
    const parent = path.dirname(root);
    if (parent === root) return null; // walked to the filesystem root, no repo
    root = parent;
  }
  const dotGit = path.join(root, ".git");
  // A directory means the main checkout itself (or a plain clone) — no twin.
  if (statSync(dotGit, { throwIfNoEntry: false })?.isFile() !== true) return null;
  const pointer = readFileSync(dotGit, "utf8").trim();
  if (!pointer.startsWith("gitdir:")) return null;
  const gitdir = path.resolve(root, pointer.slice("gitdir:".length).trim());
  if (path.basename(path.dirname(gitdir)) !== "worktrees") return null; // submodule
  const commonFile = path.join(gitdir, "commondir");
  const common = existsSync(commonFile)
    ? path.resolve(gitdir, readFileSync(commonFile, "utf8").trim())
    : path.resolve(gitdir, "..", ".."); // every git writes commondir; belt and braces
  const twin = path.join(path.dirname(common), path.relative(root, resolved));
  return twin === resolved ? null : twin;
}

/**
 * Where to read a gitignored credential file (`.env`, `.decanter-auth.json`)
 * from: this dir when it has its own, else the main checkout's copy when this
 * is a linked worktree.
 *
 * **Local wins, always.** A worktree deliberately pointed at a staging instance
 * keeps its own credentials; the fallback only fires where the alternative is
 * failing outright, because both files are gitignored and therefore absent from
 * every fresh worktree.
 *
 * For the auth file the shared copy is not merely convenient, it is the only
 * correct shape: the OAuth refresh token is single-use and rotates on every
 * redemption, and the cross-process recovery in `lib/mcp.mts` re-reads *the
 * same file* to adopt the winner's token. Two copies fork into two token chains
 * that recovery cannot repair — which is exactly what copying the file into a
 * worktree (the obvious workaround, and the one Claude Code's `.worktreeinclude`
 * would perform) silently does.
 *
 * Falls back to the local path when nothing is found, so a "not set" error
 * still names the file the user is expected to create.
 */
export function credentialFile(dir: string, name: string): string {
  const local = path.join(dir, name);
  if (existsSync(local)) return local;
  const twin = mainCheckoutTwin(dir);
  if (twin === null) return local;
  const shared = path.join(twin, name);
  return existsSync(shared) ? shared : local;
}
