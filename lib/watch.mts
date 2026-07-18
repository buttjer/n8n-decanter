import { existsSync, watch } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { startProxy } from "./proxy.mts";
import { pushSingleNode } from "./push.mts";
import { findWorkflowDir, readState } from "./state.mts";
import type { DecanterConfig, Log } from "./types.mts";
import { CODE_DIR } from "./util.mts";

/**
 * Fast inner loop for a whole workflow: resolve its folder by id, watch the
 * `code/` dir, and on every save map the changed file back to its node (via
 * `.decanter.json`, re-read each time so a mid-session rename still resolves)
 * and push **only that node** — the same per-node GET→PUT as before, now
 * covering every Code node in the workflow instead of a single file.
 *
 * With `browserReload: "proxy"` a transparent dev proxy boots first (Plan 5);
 * each successful push signals the browser tab to refresh (pushSingleNode ->
 * notifyPushed in lib/proxy).
 */
export async function watchWorkflow(api: N8nApi, config: DecanterConfig, id: string, { force = false }: { force?: boolean } = {}, log: Log): Promise<void> {
  const found = findWorkflowDir(config.root, id);
  if (!found) throw new Error(`workflow ${id} not found under ${config.root} — pull it first`);
  const dir = found; // narrowed to string; the nested flush() closure needs a non-null binding
  const codeDir = path.join(dir, CODE_DIR);
  if (!existsSync(codeDir) || Object.keys(readState(dir)!.nodes).length === 0) {
    throw new Error(`workflow ${id} has no Code nodes to watch`);
  }
  const commitOnPush = config.commitOnPush;

  if (config.browserReload === "proxy") {
    await startProxy({ upstream: config.host, port: config.proxyPort }, log);
  }

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
          await pushSingleNode(api, dir, nodeId, { force, commitOnPush }, log);
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

  watch(codeDir, (_event, changed) => {
    if (!changed) return;
    const nodeId = nodeIdForFile(changed);
    if (!nodeId) return; // not a tracked node file (.remote.js, .d.ts, or unknown)
    dirty.add(nodeId);
    trigger();
  });
  const count = Object.keys(readState(dir)!.nodes).length;
  log.info(`watching workflow ${id} — ${count} Code node${count === 1 ? "" : "s"} in ${path.join(path.basename(dir), CODE_DIR)} — Ctrl-C to stop`);
  await new Promise(() => {});
}
