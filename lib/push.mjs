import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mjs";
import { findWorkflowDir, readState, writeState } from "./state.mjs";
import {
  FILE_PLACEHOLDER_PREFIX,
  isJsCodeNode,
  sanitizeForPut,
  sha256,
  splitMarker,
  withMarker,
  workflowStructureHash,
} from "./util.mjs";

/** Turn a node source file into the jsCode payload (+ hash of the marker-less body). */
export async function buildNodeCode(dir, file) {
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
export function driftProblems(remote, state, onlyNodeIds = null) {
  const problems = [];
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

function assertNoDrift(problems, force, log) {
  if (problems.length === 0) return;
  for (const p of problems) log[force ? "warn" : "error"](p);
  if (!force) {
    throw new Error("remote changed since last sync — pull first (or repeat with --force to overwrite)");
  }
  log.warn("--force: overwriting remote changes");
}

/** Update per-node + structure hashes from the workflow the server confirmed. */
function recordSync(state, confirmed) {
  for (const node of confirmed.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id];
    if (nodeState) nodeState.lastPushedHash = sha256(splitMarker(node.parameters.jsCode).body);
  }
  state.lastPulledWorkflowHash = workflowStructureHash(confirmed);
}

export async function pushWorkflow(api, root, id, { force = false } = {}, log) {
  const dir = findWorkflowDir(root, id);
  if (!dir) throw new Error(`workflow ${id} not found under ${root} — pull it first`);
  const state = readState(dir);
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`${wfFile} missing — pull first`);
  const wf = JSON.parse(readFileSync(wfFile, "utf8"));

  for (const node of wf.nodes) {
    if (!isJsCodeNode(node) || !node.parameters.jsCode.startsWith(FILE_PLACEHOLDER_PREFIX)) continue;
    const file = node.parameters.jsCode.slice(FILE_PLACEHOLDER_PREFIX.length).trim();
    node.parameters.jsCode = (await buildNodeCode(dir, file)).jsCode;
    state.nodes[node.id] = { ...state.nodes[node.id], file };
  }

  const remote = await api.getWorkflow(id);
  assertNoDrift(driftProblems(remote, state, null), force, log);

  const confirmed = await api.updateWorkflow(id, sanitizeForPut(wf));
  recordSync(state, confirmed ?? wf);
  writeState(dir, state);
  log.info(`pushed "${wf.name}" (${id})`);
  return { dir, name: wf.name };
}

/** Push a single node's code (watch mode): GET, swap jsCode, PUT. */
export async function pushSingleNode(api, dir, nodeId, { force = false } = {}, log) {
  const state = readState(dir);
  const nodeState = state.nodes[nodeId];
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
}
