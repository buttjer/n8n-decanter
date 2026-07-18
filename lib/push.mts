import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { compileTs } from "./compile.mts";
import { commitWorkflowDir } from "./git.mts";
import { notifyPushed } from "./proxy.mts";
import { findWorkflowDir, readState, writeState } from "./state.mts";
import type { DecanterState, Log, Workflow } from "./types.mts";
import {
  isJsCodeNode,
  placeholderFile,
  sanitizeForPut,
  sha256,
  splitMarker,
  withMarker,
  workflowStructureHash,
} from "./util.mts";
import { validateNodeFile, validateWorkflowDir, type ValidationResult } from "./validate.mts";

/** Layout-compliance gate: warnings pass through, errors abort the push. */
function assertCompliant({ errors, warnings }: ValidationResult, log: Log, what: string): void {
  for (const w of warnings) log.warn(w);
  if (errors.length === 0) return;
  for (const e of errors) log.error(e);
  throw new Error(`${what} does not comply with the decanter layout (${errors.length} problem${errors.length === 1 ? "" : "s"}) — fix the issues above, see also: n8n-decanter check`);
}

/** Turn a node source file into the jsCode payload (+ hash of the marker-less body). */
export async function buildNodeCode(dir: string, file: string): Promise<{ jsCode: string; hash: string }> {
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) throw new Error(`referenced node file missing: ${filePath}`);
  if (file.endsWith(".ts")) {
    return withMarker(await compileTs(filePath));
  }
  const jsCode = readFileSync(filePath, "utf8");
  return { jsCode, hash: sha256(jsCode) };
}

/**
 * Compare the freshly fetched remote workflow against the last-synced hashes.
 * Returns human-readable problems; empty array means safe to push.
 * `onlyNodeIds` restricts the per-node check (watch mode).
 */
export function driftProblems(remote: Workflow, state: DecanterState, onlyNodeIds: Set<string> | null = null): string[] {
  const problems: string[] = [];
  for (const node of remote.nodes) {
    if (!isJsCodeNode(node)) continue;
    if (onlyNodeIds && !onlyNodeIds.has(node.id)) continue;
    const nodeState = state.nodes[node.id];
    const { body } = splitMarker(node.parameters.jsCode);
    if (!nodeState) {
      problems.push(`node "${node.name}" exists remotely but is unknown locally`);
    } else if (nodeState.lastPushedHash !== sha256(body)) {
      problems.push(`node "${node.name}": remote code changed since last sync`);
    }
  }
  if (!onlyNodeIds && state.lastPulledWorkflowHash &&
      workflowStructureHash(remote) !== state.lastPulledWorkflowHash) {
    problems.push("workflow structure changed remotely since last sync (nodes/connections/settings)");
  }
  return problems;
}

function assertNoDrift(problems: string[], force: boolean, log: Log): void {
  if (problems.length === 0) return;
  for (const p of problems) log[force ? "warn" : "error"](p);
  if (!force) {
    throw new Error("remote changed since last sync — pull first (or repeat with --force to overwrite)");
  }
  log.warn("--force: overwriting remote changes");
}

/** Update per-node + structure hashes from the workflow the server confirmed. */
function recordSync(state: DecanterState, confirmed: Workflow): void {
  for (const node of confirmed.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id];
    if (nodeState) nodeState.lastPushedHash = sha256(splitMarker(node.parameters.jsCode).body);
  }
  state.lastPulledWorkflowHash = workflowStructureHash(confirmed);
}

export async function pushWorkflow(api: N8nApi, root: string, id: string, { force = false, commitOnPush = false }: { force?: boolean; commitOnPush?: boolean } = {}, log: Log): Promise<{ dir: string; name: string }> {
  const dir = findWorkflowDir(root, id, log);
  if (!dir) throw new Error(`workflow ${id} not found under ${root} — pull it first`);
  assertCompliant(validateWorkflowDir(dir), log, `"${path.basename(dir)}"`);
  const state = readState(dir)!;
  const wf = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8")) as Workflow;

  for (const node of wf.nodes) {
    if (!isJsCodeNode(node)) continue;
    const file = placeholderFile(node);
    if (file === null) continue;
    node.parameters.jsCode = (await buildNodeCode(dir, file)).jsCode;
    state.nodes[node.id] = { ...state.nodes[node.id], file };
  }

  const remote = await api.getWorkflow(id);
  assertNoDrift(driftProblems(remote, state, null), force, log);

  const confirmed = await api.updateWorkflow(id, sanitizeForPut(wf));
  recordSync(state, confirmed ?? wf);
  writeState(dir, state);
  log.info(`pushed "${wf.name}" (${id})`);
  notifyPushed(id);
  if (commitOnPush) await commitWorkflowDir(dir, `decanter: pushed "${wf.name}" (${id})`, log);
  return { dir, name: wf.name };
}

/** Push a single node's code (watch mode): GET, swap jsCode, PUT. */
export async function pushSingleNode(api: N8nApi, dir: string, nodeId: string, { force = false, commitOnPush = false }: { force?: boolean; commitOnPush?: boolean } = {}, log: Log): Promise<void> {
  const state = readState(dir);
  if (!state) throw new Error(`missing .decanter.json in ${dir} — pull first`);
  const nodeState = state.nodes[nodeId];
  if (!nodeState) throw new Error(`node ${nodeId} has no entry in ${dir}/.decanter.json — pull first`);
  assertCompliant(validateNodeFile(dir, nodeState.file), log, nodeState.file);
  const { jsCode } = await buildNodeCode(dir, nodeState.file);

  const remote = await api.getWorkflow(state.workflowId);
  assertNoDrift(driftProblems(remote, state, new Set([nodeId])), force, log);

  const node = remote.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`node ${nodeId} no longer exists in remote workflow ${state.workflowId}`);
  node.parameters.jsCode = jsCode;

  const confirmed = await api.updateWorkflow(state.workflowId, sanitizeForPut(remote));
  recordSync(state, confirmed ?? remote);
  writeState(dir, state);
  log.info(`pushed node "${node.name}" -> workflow "${remote.name}"`);
  notifyPushed(state.workflowId);
  if (commitOnPush) {
    await commitWorkflowDir(dir, `decanter: pushed "${remote.name}" / node "${node.name}" (${state.workflowId})`, log);
  }
}
