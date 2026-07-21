import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { compileTs } from "./compile.mts";
import { commitWorkflowDir } from "./git.mts";
import { findWorkflowDir, readState, renameNodeFilePair, writeState } from "./state.mts";
import type { DecanterState, Log, NodeState, Workflow, WorkflowNode } from "./types.mts";
import {
  CODE_DIR,
  FILE_PLACEHOLDER_PREFIX,
  isJsCodeNode,
  kebabCase,
  sha256,
  splitMarker,
  stableWorkflowJson,
  workflowStructureHash,
} from "./util.mts";

function writeIfChanged(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  writeFileSync(file, content);
  return true;
}

/**
 * Locate/create the workflow folder (Plan 27). Folders are a stable local pick:
 * an **existing** folder for this id is kept as-is (never renamed to follow a
 * remote workflow rename — the display name lives in `.decanter.json.name`). A
 * **new** folder gets a kebab-case slug; if that slug is already taken by a
 * different workflow, fall back to `<slug>-<id8>` (the node-file collision
 * strategy) and warn.
 */
function ensureWorkflowDir(root: string, wf: Workflow, log: Log): { dir: string } {
  const existing = findWorkflowDir(root, wf.id, log);
  if (existing) return { dir: existing };
  const wanted = kebabCase(wf.name);
  let slug = wanted;
  if (existsSync(path.join(root, slug))) {
    slug = `${wanted}-${wf.id.slice(0, 8)}`;
    log.warn(`folder "${wanted}/" already taken — using "${slug}/" for "${wf.name}" (${wf.id})`);
  }
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  return { dir };
}

/**
 * Pick/refresh the file name for a node: kebab-case under code/, renaming
 * existing files on node rename (which also migrates pre-code/ layouts).
 * Collision handling is per-pull (`usedNames`), deterministic across nodes
 * that kebab to the same base.
 */
function resolveNodeFile(dir: string, nodeState: Partial<NodeState>, node: WorkflowNode, ext: string, usedNames: Set<string>, log: Log): { file: string; base: string } {
  let base = kebabCase(node.name);
  if (usedNames.has(base)) base = `${base}-${node.id.slice(0, 8)}`;
  usedNames.add(base);
  const wanted = `${CODE_DIR}/${base}${ext}`;
  mkdirSync(path.join(dir, CODE_DIR), { recursive: true });
  const current = nodeState.file;
  if (current && current !== wanted) renameNodeFilePair(dir, current, base, ext, log);
  return { file: wanted, base };
}

export async function pullWorkflow(api: N8nApi, root: string, id: string, { commitOnPull = false }: { commitOnPull?: boolean } = {}, log: Log): Promise<{ dir: string; name: string }> {
  const wf = await api.getWorkflow(id);
  const { dir } = ensureWorkflowDir(root, wf, log);
  const state: DecanterState = readState(dir) ?? { workflowId: wf.id, nodes: {} };
  state.workflowId = wf.id;
  state.name = wf.name; // cached display name (Plan 27) — folder stays a stable slug
  state.nodes ??= {};
  const usedNames = new Set<string>();
  const placeholders = new Map<string, string>(); // node id -> file name

  for (const node of wf.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState: Partial<NodeState> = state.nodes[node.id] ?? {};
    const remote = node.parameters.jsCode;
    const { body: remoteBody, markerHash } = splitMarker(remote);
    const remoteHash = sha256(remoteBody);
    const tsManaged = markerHash !== null;

    const { file, base } = resolveNodeFile(dir, nodeState, node, tsManaged ? ".ts" : ".js", usedNames, log);
    const filePath = path.join(dir, file);
    const remoteRel = `${CODE_DIR}/${base}.remote.js`;
    const remoteJsFile = path.join(dir, remoteRel);

    if (tsManaged) {
      if (!existsSync(filePath)) {
        writeFileSync(remoteJsFile, remoteBody);
        log.warn(`${wf.name} / ${node.name}: TS-managed on remote but no local ${file} — compiled code saved to ${remoteRel}`);
      } else {
        const compiled = await compileTs(filePath, log);
        const localHash = sha256(compiled);
        if (localHash === remoteHash) {
          if (existsSync(remoteJsFile)) {
            rmSync(remoteJsFile);
            log.info(`${node.name}: in sync, removed stale ${remoteRel}`);
          }
        } else if (localHash === nodeState.lastPushedHash) {
          writeFileSync(remoteJsFile, remoteBody);
          log.warn(`${wf.name} / ${node.name}: edited in the n8n UI since last push — remote code saved to ${remoteRel}; port it into ${file} manually`);
        } else if (remoteHash === nodeState.lastPushedHash) {
          log.info(`${node.name}: local ${file} modified, not yet pushed`);
        } else {
          writeFileSync(remoteJsFile, remoteBody);
          log.warn(`${wf.name} / ${node.name}: CONFLICT — both ${file} and the remote code changed since last sync. Remote saved to ${remoteRel}; reconcile manually before pushing`);
        }
      }
    } else if (nodeState.file?.endsWith(".ts") || existsSync(path.join(dir, CODE_DIR, base + ".ts"))) {
      // Local .ts exists but remote carries no marker: never clobber TS source
      // and don't drop a competing .js next to it.
      const tsFile = nodeState.file ?? `${CODE_DIR}/${base}.ts`;
      writeFileSync(remoteJsFile, remoteBody);
      log.warn(`${wf.name} / ${node.name}: local ${tsFile} exists but remote code has no @ts-n8n marker (not pushed from TS yet?) — remote saved to ${remoteRel}`);
      placeholders.set(node.id, tsFile);
      state.nodes[node.id] = { ...nodeState, file: tsFile, lastPushedHash: remoteHash };
      continue;
    } else {
      if (writeIfChanged(filePath, remoteBody)) log.info(`wrote ${path.basename(dir)}/${file}`);
    }

    placeholders.set(node.id, file);
    state.nodes[node.id] = { ...nodeState, file, lastPushedHash: remoteHash };
  }

  // Drop state for nodes that no longer exist remotely (files stay; git is the safety net).
  const liveIds = new Set(wf.nodes.map((n) => n.id));
  for (const nodeId of Object.keys(state.nodes)) {
    if (!liveIds.has(nodeId)) {
      log.warn(`node ${nodeId} ("${state.nodes[nodeId].file}") no longer exists remotely — removing from state, delete the file manually if unwanted`);
      delete state.nodes[nodeId];
    }
  }

  const wfOut = structuredClone(wf);
  // Keep workflow.json to the workflow itself: n8n 2.x GET responses embed a
  // full server-side copy of the *published* version (`activeVersion`, code
  // included), sharing metadata (`shared`), and the published-version pointer
  // (`activeVersionId`) — derived data that would duplicate every node's source
  // in git and/or churn on each publish. None is pushable (sanitizeForPut
  // whitelists) and no local command reads them from workflow.json (the
  // version-aware `status` reads `activeVersionId` straight off the live GET),
  // so dropping them loses nothing. The draft `versionId` is kept — the
  // executions stale-fixture warning compares against it.
  delete wfOut.activeVersion;
  delete wfOut.activeVersionId;
  delete wfOut.shared;
  for (const node of wfOut.nodes) {
    const file = placeholders.get(node.id);
    if (file) node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + file;
  }
  if (writeIfChanged(path.join(dir, "workflow.json"), stableWorkflowJson(wfOut))) {
    log.info(`wrote ${path.basename(dir)}/workflow.json`);
  }

  state.lastPulledWorkflowHash = workflowStructureHash(wf);
  writeState(dir, state);
  if (commitOnPull) {
    await commitWorkflowDir(dir, `decanter: pulled "${wf.name}" (${id})`, log);
  }
  return { dir, name: wf.name };
}
