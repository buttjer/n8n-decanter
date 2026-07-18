import { existsSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { commitWorkflowDir } from "./git.mts";
import { startProxy } from "./proxy.mts";
import { createPrompt } from "./prompt.mts";
import { pullWorkflow } from "./pull.mts";
import { pushSingleNode, pushWorkflow } from "./push.mts";
import { findWorkflowDir, readState } from "./state.mts";
import type { DecanterConfig, Log, Workflow } from "./types.mts";
import {
  CODE_DIR,
  FILE_PLACEHOLDER_PREFIX,
  isJsCodeNode,
  sha256,
  splitMarker,
  stableWorkflowJson,
  workflowStructureHash,
} from "./util.mts";

export type StructureAction = "skip" | "push" | "conflict";

/**
 * Pure 3-way decision for a workflow.json save event. `baseline` is the
 * structure hash both sides agreed on at the session's last sync point; an
 * absent baseline skips conflict detection (mirrors driftProblems).
 */
export function structureAction(localHash: string, remoteHash: string, baseline: string | undefined): StructureAction {
  if (localHash === baseline || localHash === remoteHash) return "skip";
  if (baseline === undefined || remoteHash === baseline) return "push";
  return "conflict";
}

/**
 * Fast inner loop for a whole workflow: resolve its folder by id, then
 *
 * - `code/` saves map back to their node (via `.decanter.json`, re-read each
 *   time so a mid-session rename still resolves) and push **only that node**
 *   (GET → swap jsCode → PUT), preserving remote structure.
 * - `workflow.json` saves push the *structure* via a full pushWorkflow — but
 *   only after a 3-way check against the session baseline; if the remote
 *   structure also changed since the last sync, an interactive prompt offers
 *   merge (write workflow.remote.json) / keep local / keep remote.
 *
 * Every session starts with a safety snapshot commit followed by a pull, so
 * the working tree begins committed and in sync with remote — pull overwrites
 * plain .js files and workflow.json, hence the commit-first order. If the
 * snapshot fails (no git), the startup pull is skipped rather than risk
 * losing uncommitted local edits.
 *
 * The session baseline is deliberately *not* advanced by single-node pushes:
 * their PUT responses re-baseline `.decanter.json`'s structure hash, silently
 * absorbing n8n-UI structural edits — the in-memory baseline keeps those
 * detectable (early warning after node pushes, conflict prompt on the next
 * structural save).
 *
 * With `browserReload: "proxy"` a transparent dev proxy boots first (Plan 5);
 * each successful push signals the browser tab to refresh (notifyPushed in
 * lib/proxy).
 */
export async function watchWorkflow(api: N8nApi, config: DecanterConfig, id: string, { force = false }: { force?: boolean } = {}, log: Log): Promise<void> {
  const found = findWorkflowDir(config.root, id, log);
  if (!found) throw new Error(`workflow ${id} not found under ${config.root} — pull it first`);
  let dir = found;
  const { commitOnPush, commitOnPull } = config;
  const wfJsonPath = () => path.join(dir, "workflow.json");
  const remoteJsonRel = "workflow.remote.json";

  const readLocalWorkflow = (): Workflow | undefined => {
    try {
      return JSON.parse(readFileSync(wfJsonPath(), "utf8")) as Workflow;
    } catch {
      return undefined;
    }
  };

  // --- watch start: snapshot commit, then pull (commit BEFORE pull — pull
  // overwrites plain .js files and workflow.json with remote unconditionally)
  let structureBaseline = readState(dir)?.lastPulledWorkflowHash;
  const snapshot = await commitWorkflowDir(dir, `decanter: watch start snapshot (${id})`, log);
  if (snapshot === "failed") {
    log.warn("no git safety net — skipping the watch-start pull; pull manually if desired");
  } else {
    const local = readLocalWorkflow();
    const remote = await api.getWorkflow(id);
    if (local && structureAction(workflowStructureHash(local), workflowStructureHash(remote), structureBaseline) === "conflict") {
      log.warn("structural conflict at watch start: workflow.json and the remote workflow both changed since last sync — pulling remote; your local version is preserved in git, reconcile and save workflow.json to push");
    }
    const pulled = await pullWorkflow(api, config.root, id, { commitOnPull }, log);
    dir = pulled.dir;
    structureBaseline = readState(dir)?.lastPulledWorkflowHash;
  }

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
  let structureDirty = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;
  let lastUiWarnHash: string | undefined;

  /** Early warning: a node push's PUT response revealed UI structural edits. */
  const warnOnUiStructureEdit = (): void => {
    const synced = readState(dir)?.lastPulledWorkflowHash;
    if (!synced || synced === structureBaseline || synced === lastUiWarnHash) return;
    lastUiWarnHash = synced;
    log.warn("workflow structure changed in the n8n UI — local workflow.json is stale; pull before editing it (a structural save will prompt)");
  };

  /**
   * Remote workflow as a diff-friendly conflict file: placeholders substituted
   * only where the remote code still matches the last sync (otherwise the
   * changed remote code stays inline and visible).
   */
  const writeRemoteWorkflowFile = (remote: Workflow): void => {
    const state = readState(dir);
    const out = structuredClone(remote);
    for (const node of out.nodes) {
      if (!isJsCodeNode(node)) continue;
      const ns = state?.nodes[node.id];
      if (ns && sha256(splitMarker(node.parameters.jsCode).body) === ns.lastPushedHash) {
        node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + ns.file;
      }
    }
    writeFileSync(path.join(dir, remoteJsonRel), stableWorkflowJson(out));
    log.info(`wrote ${remoteJsonRel} — reconcile into workflow.json, then save (choose "keep local") and delete it`);
  };

  const refreshBaseline = (): void => {
    structureBaseline = readState(dir)?.lastPulledWorkflowHash;
    lastUiWarnHash = undefined;
  };

  const doPushStructure = async (forceFlag: boolean): Promise<void> => {
    await pushWorkflow(api, config.root, id, { force: forceFlag, commitOnPush }, log);
    const stale = path.join(dir, remoteJsonRel);
    if (existsSync(stale)) {
      rmSync(stale);
      log.info(`removed stale ${remoteJsonRel}`);
    }
    refreshBaseline();
  };

  /** Interactive conflict resolution; returns true when the workflow got fully synced. */
  const resolveConflict = async (remote: Workflow): Promise<boolean> => {
    log.error("structural conflict: workflow.json and the remote workflow both changed since last sync");
    if (!process.stdin.isTTY) {
      log.error("non-interactive session — skipped the structural push; pull (or push --force) to resolve");
      return false;
    }
    const rl = createPrompt();
    let choice: string;
    try {
      choice = (await rl.question(
        `  [m]erge  — write ${remoteJsonRel} for manual reconciliation\n` +
        "  [l]ocal  — push workflow.json, overwriting the remote changes\n" +
        "  [r]emote — pull, overwriting workflow.json (previous version is in git)\n" +
        "  [Enter]  — skip for now (asks again on the next save)\n" +
        "choice: ",
      )).trim().toLowerCase();
    } finally {
      rl.close();
    }
    switch (choice) {
      case "m":
        writeRemoteWorkflowFile(remote);
        return false;
      case "l":
        await doPushStructure(true);
        return true;
      case "r": {
        const pulled = await pullWorkflow(api, config.root, id, { commitOnPull }, log);
        log.warn("workflow.json overwritten with the remote version — the previous version is in git");
        if (pulled.dir !== dir) {
          dir = pulled.dir;
          armWatchers();
        }
        refreshBaseline();
        return true;
      }
      default:
        log.info("skipped — the conflict prompt returns on the next workflow.json save");
        return false;
    }
  };

  /** Handle a workflow.json save; returns true when nodes are covered too (full push or pull ran). */
  const pushStructure = async (): Promise<boolean> => {
    const local = readLocalWorkflow();
    if (!local) {
      log.warn("workflow.json missing or unparsable — skipped, retries on the next save");
      return false;
    }
    const localHash = workflowStructureHash(local);
    if (localHash === structureBaseline) return false; // formatting-only save or our own pull rewrite (anti-loop)
    const remote = await api.getWorkflow(id);
    const action = structureAction(localHash, workflowStructureHash(remote), structureBaseline);
    if (action === "skip") {
      log.info("workflow.json: no structural change against remote — nothing to push");
      return false;
    }
    if (action === "conflict" && !force) return resolveConflict(remote);
    if (action === "conflict") log.warn("--force: overwriting remote structural changes");
    // clean push keeps the drift guard armed (UI *code* edits don't move the
    // structure hash, so only pushWorkflow's per-node check can catch them)
    await doPushStructure(action === "conflict" || force);
    return true;
  };

  async function flush() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      let nodesCovered = false;
      if (structureDirty) {
        structureDirty = false;
        try {
          nodesCovered = await pushStructure();
        } catch (err) {
          log.error((err as Error).message);
        }
      }
      const ids = [...dirty];
      dirty.clear();
      if (!nodesCovered) {
        for (const nodeId of ids) {
          try {
            await pushSingleNode(api, dir, nodeId, { force, commitOnPush }, log);
            warnOnUiStructureEdit();
          } catch (err) {
            log.error((err as Error).message);
          }
        }
      }
    } finally {
      running = false;
      if (queued || dirty.size > 0 || structureDirty) {
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
  /** (Re-)arm both watchers — dir watches, not file watches: editor saves replace inodes. */
  const armWatchers = (): void => {
    codeWatcher?.close();
    dirWatcher?.close();
    const codeDir = path.join(dir, CODE_DIR);
    codeWatcher = existsSync(codeDir)
      ? watch(codeDir, (_event, changed) => {
          if (!changed) return;
          const nodeId = nodeIdForFile(changed);
          if (!nodeId) return; // not a tracked node file (.remote.js, .d.ts, or unknown)
          dirty.add(nodeId);
          trigger();
        })
      : undefined;
    dirWatcher = watch(dir, (_event, changed) => {
      if (changed !== "workflow.json") return; // .decanter.json writes etc.
      structureDirty = true;
      trigger();
    });
  };

  armWatchers();
  const count = Object.keys(readState(dir)?.nodes ?? {}).length;
  log.info(`watching workflow ${id} — ${count} Code node${count === 1 ? "" : "s"} in ${path.join(path.basename(dir), CODE_DIR)} + workflow.json — Ctrl-C to stop`);
  await new Promise(() => {});
}
