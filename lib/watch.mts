import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { commitWorkflowDir } from "./git.mts";
import type { McpClient } from "./mcp.mts";
import { pullWorkflow } from "./pull.mts";
import { pushSingleNode } from "./push.mts";
import { findWorkflowDir, readState } from "./state.mts";
import { style } from "./style.mts";
import type { DecanterConfig, Log } from "./types.mts";
import { CODE_DIR } from "./util.mts";

/** Returned by watchWorkflow so tests can stop a session; the CLI never closes it. */
export interface WatchHandle {
  /** Stop watching: closes the fs watchers and the debounce timer. */
  close(): Promise<void>;
}

/**
 * Fast inner loop for a workflow's CODE (Plan 32: code only — structure is
 * n8n's job). `code/` saves map back to their node (via `.decanter.json`,
 * re-read each time so a mid-session rename still resolves) and push **only
 * that node** over MCP (`updateNodeParameters`, draft-only). `workflow.json`
 * is a read-only snapshot now: a save there is warned about once and never
 * pushed — the structural-conflict prompt and `workflow.remote.json` flow
 * died with the API backend.
 *
 * Every session starts with a safety snapshot commit followed by a pull, so
 * the working tree begins committed and in sync with remote — pull overwrites
 * plain .js files and workflow.json, hence the commit-first order. If the
 * snapshot fails (no git), the startup pull is skipped rather than risk
 * losing uncommitted local edits.
 *
 * No client-side reload is needed (Plan 52): n8n's own editor reflects an MCP
 * draft edit live (soft canvas re-render, skipped if the tab has unsaved
 * changes) — decanter just prints the deep link.
 */
export async function watchWorkflow(
  mcp: McpClient,
  config: DecanterConfig,
  id: string,
  { force = false }: { force?: boolean } = {},
  log: Log,
): Promise<WatchHandle> {
  const found = findWorkflowDir(config.root, id, log);
  if (!found) throw new Error(`workflow ${id} not found under ${config.root} — pull it first`);
  let dir = found;
  const { commitOnPush, commitOnPull } = config;

  // --- watch start: snapshot commit, then pull (commit BEFORE pull — pull
  // overwrites plain .js files and workflow.json with remote unconditionally)
  const snapshot = await commitWorkflowDir(dir, `decanter: watch start snapshot (${id})`, log);
  if (snapshot === "failed") {
    log.warn("no git safety net — skipping the watch-start pull; pull manually if desired");
  } else {
    const pulled = await pullWorkflow(mcp, config.root, id, { commitOnPull }, log);
    dir = pulled.dir;
  }
  log.info(style.dim('pushes update the draft only — run "n8n-decanter publish" to take changes live'));

  const editorUrl = `${config.host.replace(/\/+$/, "")}/workflow/${id}`;
  log.info(`editor: ${style.link(editorUrl, editorUrl)}`);
  log.info(style.dim("keep the n8n editor open — it updates live on each push"));

  /** Resolve a file name inside code/ back to its node id (state re-read live). */
  const nodeIdForFile = (fileName: string): string | undefined => {
    const rel = `${CODE_DIR}/${fileName}`;
    const state = readState(dir);
    if (!state) return undefined;
    return Object.entries(state.nodes).find(([, ns]) => ns.file === rel)?.[0];
  };

  const dirty = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;
  let warnedSnapshotEdit = false;

  async function flush() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const ids = [...dirty];
      dirty.clear();
      for (const nodeId of ids) {
        try {
          await pushSingleNode(mcp, dir, nodeId, { force, commitOnPush }, log);
        } catch (err) {
          log.error((err as Error).message);
        }
      }
    } finally {
      running = false;
      if (queued || dirty.size > 0) {
        queued = false;
        trigger();
      }
    }
  }

  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };

  let codeWatcher: FSWatcher | undefined;
  let dirWatcher: FSWatcher | undefined;
  /** Arm both watchers — dir watches, not file watches: editor saves replace inodes. */
  const armWatchers = (): void => {
    codeWatcher?.close();
    dirWatcher?.close();
    const codeDir = path.join(dir, CODE_DIR);
    codeWatcher = existsSync(codeDir)
      ? watch(codeDir, (_event, changed) => {
          if (!changed) return;
          const nodeId = nodeIdForFile(changed);
          if (!nodeId) return; // not a tracked node file (.d.ts or unknown)
          dirty.add(nodeId);
          trigger();
        })
      : undefined;
    // workflow.json is a read-only snapshot: warn once, never push
    dirWatcher = watch(dir, (_event, changed) => {
      if (changed !== "workflow.json" || warnedSnapshotEdit) return;
      warnedSnapshotEdit = true;
      log.warn("workflow.json is a read-only structure snapshot — edits there are never pushed; make structure changes in n8n (pull refreshes the file)");
    });
  };

  armWatchers();
  const count = Object.keys(readState(dir)?.nodes ?? {}).length;
  log.info(`watching workflow ${id} — ${count} Code node${count === 1 ? "" : "s"} in ${path.join(path.basename(dir), CODE_DIR)} — Ctrl-C to stop`);
  return {
    async close() {
      clearTimeout(timer);
      codeWatcher?.close();
      dirWatcher?.close();
    },
  };
}
