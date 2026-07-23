// Live snapshot mirror (Plan 51 Part A): keep the read-only `workflow.json`
// review snapshot auto-fresh after an agent restructures a workflow *through*
// decanter's guarded MCP gateway (`mcp connect`/`serve`). The guard forwards
// every non-blocked structure op but the local mirror only refreshed on the
// next MANUAL `pull` — so the clean-git-diff story lagged the agent. This
// orchestrator closes that gap: on a forwarded non-blocked `update_workflow`
// the guard calls `schedule(id)`, and a debounced background `pull` refreshes
// the snapshot (+ code files + state, incl. rename file-moves) with the
// gateway's own credential.
//
// Safety rails that make default-on acceptable:
//  - Fire-and-forget: `schedule` returns instantly; the pull runs in the
//    background and never blocks the agent's next tool call.
//  - Require git + safety-commit-before-pull: no git → skip (warn once); a
//    dirty tree is committed before pulling, so an overwrite of an unpushed
//    `.js` edit stays recoverable (the same pattern `watch` uses).
//  - Debounce + overlap guard: coalesce an op burst into one pull; never two
//    pulls for the same workflow at once (a burst arriving mid-pull re-runs
//    it once afterwards).
//  - Tracked-only: refresh only workflows listed in config or already pulled;
//    an untracked id (e.g. `create_workflow_from_code`) is skipped with a hint.
import { commitWorkflowDir, isGitRepo } from "./git.mts";
import type { McpClient } from "./mcp.mts";
import { pullWorkflow } from "./pull.mts";
import { findWorkflowDir } from "./state.mts";
import type { Log } from "./types.mts";

/** Debounce window (ms) — coalesces an op burst into a single pull. */
const DEFAULT_DEBOUNCE_MS = 400;

/** Injectable timer seam so the debounce/overlap logic is unit-testable. */
export interface MirrorClock {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: MirrorClock = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Mirror {
  /**
   * Debounced background refresh of one workflow's snapshot. Fire-and-forget:
   * returns immediately; gating (tracked/git) and the pull happen async.
   */
  schedule(id: string): void;
  /** Await all pending + in-flight refreshes (shutdown / tests). */
  drain(): Promise<void>;
}

export interface MirrorOptions {
  mcp: McpClient;
  root: string;
  /** Tracked workflow ids (config.workflows). A locally-pulled dir also counts. */
  workflows: string[];
  commitOnPull: boolean;
  /** Master switch — `false` makes `schedule` a no-op (CI/deterministic setups). */
  liveMirror: boolean;
  log: Log;
  // --- test seams (all optional) ---
  debounceMs?: number;
  clock?: MirrorClock;
  /** Override the effectful refresh (default: safety-commit + `pullWorkflow`). */
  refresh?: (id: string) => Promise<void>;
  /** Override the git-presence probe (default: `isGitRepo`). */
  isGitRepo?: (dir: string) => Promise<boolean>;
}

interface WorkflowMirrorState {
  timer?: unknown;
  running: boolean;
  queued: boolean;
}

/**
 * Build the shared mirror orchestrator. One instance per guard process; both
 * guard transports (`mcp connect`, `mcp serve`) call `schedule` after they
 * forward a non-blocked `update_workflow`.
 */
export function createMirror(opts: MirrorOptions): Mirror {
  const { mcp, root, workflows, commitOnPull, liveMirror, log } = opts;
  const clock = opts.clock ?? realClock;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const gitCheck = opts.isGitRepo ?? isGitRepo;
  const refresh = opts.refresh ?? defaultRefresh;

  const state = new Map<string, WorkflowMirrorState>();
  const inFlight = new Set<Promise<void>>();
  const warned = new Set<string>(); // one hint per (reason[:id]) key
  /** Cached git-presence probe: undefined = not yet checked. */
  let gitOk: boolean | undefined;

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(message);
  };

  /** Tracked = listed in config OR already pulled to a local folder. */
  const tracked = (id: string): boolean => workflows.includes(id) || findWorkflowDir(root, id) !== null;

  /** The default effectful refresh: commit a dirty tree, then pull the tip. */
  async function defaultRefresh(id: string): Promise<void> {
    const dir = findWorkflowDir(root, id);
    // Commit BEFORE pull — pull overwrites plain .js files and workflow.json
    // with the remote unconditionally, so an unpushed edit must be committed
    // first to stay recoverable (mirrors watch's snapshot-then-pull order).
    if (dir) await commitWorkflowDir(dir, `decanter: live-mirror snapshot before refresh (${id})`, log);
    const { name } = await pullWorkflow(mcp, root, id, { commitOnPull }, log);
    log.info(`mirrored "${name}" (${id})`);
  }

  /** Run (or re-run) the refresh for one id under the per-workflow overlap guard. */
  function fire(id: string): void {
    const s = state.get(id);
    if (!s) return;
    if (s.running) {
      s.queued = true; // a burst arrived mid-pull — re-run once after it finishes
      return;
    }
    s.running = true;
    const p = (async () => {
      // git gate lives here (async) so `schedule` can stay synchronous.
      if (gitOk === undefined) gitOk = await gitCheck(root);
      if (!gitOk) {
        warnOnce("no-git", "no git in the sync dir — skipping the live mirror (git is its safety net; run `git init` and `pull` to refresh manually)");
        return;
      }
      try {
        await refresh(id);
      } catch (err) {
        log.warn(`live mirror of ${id} failed (${(err as Error).message.split("\n")[0]}) — the snapshot may be stale; \`pull ${id}\` to refresh`);
      }
    })().finally(() => {
      inFlight.delete(p);
      s.running = false;
      if (s.queued) {
        s.queued = false;
        fire(id);
      }
    });
    inFlight.add(p);
  }

  return {
    schedule(id: string): void {
      if (!liveMirror) return;
      if (!tracked(id)) {
        warnOnce(`untracked:${id}`, `${id} isn't tracked locally — skipping the live mirror; run \`n8n-decanter pull ${id}\` to start mirroring it`);
        return;
      }
      const s = state.get(id) ?? { running: false, queued: false };
      state.set(id, s);
      clock.clearTimer(s.timer);
      s.timer = clock.setTimer(() => {
        s.timer = undefined;
        fire(id);
      }, debounceMs);
    },

    async drain(): Promise<void> {
      // Flush any pending debounce timers immediately, then await running work;
      // a refresh may queue another, so loop until nothing is pending.
      for (;;) {
        for (const [id, s] of state) {
          if (s.timer !== undefined) {
            clock.clearTimer(s.timer);
            s.timer = undefined;
            fire(id);
          }
        }
        if (inFlight.size === 0 && ![...state.values()].some((s) => s.timer !== undefined)) return;
        await Promise.all([...inFlight]);
      }
    },
  };
}
