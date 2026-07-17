import { watch } from "node:fs";
import path from "node:path";
import { pushSingleNode } from "./push.mts";
import { readState } from "./state.mts";

/**
 * Fast inner loop: watch one node file and push only that node on change.
 * Watches the directory (not the file) so atomic editor saves keep working.
 */
export async function watchFile(api, file, { force = false, commitOnPush = false } = {}, log) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const name = path.basename(abs);
  const state = readState(dir);
  if (!state) throw new Error(`no ${dir}/.decanter.json — is this a pulled workflow folder?`);
  const entry = Object.entries(state.nodes).find(([, ns]) => ns.file === name);
  if (!entry) throw new Error(`${name} is not a tracked node file (check .decanter.json)`);
  const [nodeId] = entry;

  let timer = null;
  let running = false;
  let queued = false;

  async function run() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await pushSingleNode(api, dir, nodeId, { force, commitOnPush }, log);
    } catch (err) {
      log.error(err.message);
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
  log.info(`watching ${name} (node ${nodeId}) — Ctrl-C to stop`);
  await new Promise(() => {});
}
