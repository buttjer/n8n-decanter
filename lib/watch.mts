import { watch } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { pushSingleNode } from "./push.mts";
import { readState } from "./state.mts";
import type { Log } from "./types.mts";
import { CODE_DIR } from "./util.mts";

/**
 * Fast inner loop: watch one node file and push only that node on change.
 * Watches the directory (not the file) so atomic editor saves keep working.
 * Node files live in <workflow>/code/, so the state file sits one level up.
 */
export async function watchFile(api: N8nApi, file: string, { force = false, commitOnPush = false }: { force?: boolean; commitOnPush?: boolean } = {}, log: Log): Promise<void> {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const name = path.basename(abs);
  let stateDir = dir;
  let state = readState(stateDir);
  if (!state && path.basename(dir) === CODE_DIR) {
    stateDir = path.dirname(dir);
    state = readState(stateDir);
  }
  if (!state) throw new Error(`no .decanter.json in ${dir} or its parent — is this a pulled workflow folder?`);
  const rel = path.relative(stateDir, abs).split(path.sep).join("/");
  const entry = Object.entries(state.nodes).find(([, ns]) => ns.file === rel);
  if (!entry) throw new Error(`${rel} is not a tracked node file (check .decanter.json)`);
  const [nodeId] = entry;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;

  async function run() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await pushSingleNode(api, stateDir, nodeId, { force, commitOnPush }, log);
    } catch (err) {
      log.error((err as Error).message);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        trigger();
      }
    }
  }

  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  };

  watch(dir, (_event, changed) => {
    if (changed === name) trigger();
  });
  log.info(`watching ${rel} (node ${nodeId}) — Ctrl-C to stop`);
  await new Promise(() => {});
}
