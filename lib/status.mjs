import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mjs";
import { findWorkflowDir, readState } from "./state.mjs";
import { isJsCodeNode, sha256, splitMarker, workflowStructureHash } from "./util.mjs";

async function localHash(dir, file) {
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) return null;
  if (file.endsWith(".ts")) return sha256(await compileTs(filePath));
  return sha256(readFileSync(filePath, "utf8"));
}

export async function statusWorkflow(api, root, id, log) {
  const remote = await api.getWorkflow(id);
  const dir = findWorkflowDir(root, id);
  if (!dir) {
    log.warn(`${remote.name} (${id}): not pulled yet`);
    return;
  }
  const state = readState(dir);
  log.info(`${remote.name} (${id})  [${path.relative(process.cwd(), dir)}]`);

  const remoteStruct = workflowStructureHash(remote);
  const wfFile = path.join(dir, "workflow.json");
  const localStruct = existsSync(wfFile)
    ? workflowStructureHash(JSON.parse(readFileSync(wfFile, "utf8")))
    : null;
  const base = state.lastPulledWorkflowHash;
  if (remoteStruct !== base && localStruct !== base) log.warn("  structure: changed both locally and remotely");
  else if (remoteStruct !== base) log.warn("  structure: changed remotely — pull");
  else if (localStruct !== base) log.info("  structure: changed locally — push pending");
  else log.info("  structure: in sync");

  for (const node of remote.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id];
    const label = `  ${node.name}`;
    if (!nodeState) {
      log.warn(`${label}: remote code node unknown locally — pull`);
      continue;
    }
    const remoteHash = sha256(splitMarker(node.parameters.jsCode).body);
    const local = await localHash(dir, nodeState.file);
    const last = nodeState.lastPushedHash;
    if (local === null) log.warn(`${label}: local file ${nodeState.file} missing`);
    else if (local === remoteHash) log.info(`${label}: in sync (${nodeState.file})`);
    else if (remoteHash === last) log.info(`${label}: local changes in ${nodeState.file} — push pending`);
    else if (local === last) log.warn(`${label}: changed remotely — pull`);
    else log.error(`${label}: CONFLICT — changed both locally and remotely`);
  }
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (!remote.nodes.some((n) => n.id === nodeId)) {
      log.warn(`  ${nodeState.file}: node ${nodeId} deleted remotely`);
    }
  }
}
