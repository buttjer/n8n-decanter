import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { commitWorkflowDir } from "./git.mts";
import { getWorkflowDetails, type McpClient } from "./mcp.mts";
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
 * existing files on node rename. This is the node-identity layer (Plan 32
 * Task 3): the map is keyed on the node *id*, which survives MCP/UI renames,
 * so a structure-side rename only moves the local file — content and history
 * stay attached. Collision handling is per-pull (`usedNames`), deterministic
 * across nodes that kebab to the same base.
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

/**
 * Pull one workflow over MCP (Plan 32): read the tip via `get_workflow_details`
 * (the editor view — the draft when one exists, else the published content),
 * extract each Code node's `jsCode` into `code/`, and refresh the read-only
 * `workflow.json` structure snapshot. Code files in git are the source of
 * truth for Code-node source: `.js` files are overwritten with the remote body
 * (git is the safety net — a warning flags overwritten unpushed edits), `.ts`
 * sources are never touched (divergence is warned, inspect with
 * `status --diff`; no `.remote.js` artifacts since Plan 32).
 */
export async function pullWorkflow(mcp: McpClient, root: string, id: string, { commitOnPull = false }: { commitOnPull?: boolean } = {}, log: Log): Promise<{ dir: string; name: string }> {
  const wf = await getWorkflowDetails(mcp, id);
  const { dir } = ensureWorkflowDir(root, wf, log);
  const state: DecanterState = readState(dir) ?? { workflowId: wf.id, nodes: {} };
  state.workflowId = wf.id;
  state.name = wf.name; // cached display name (Plan 27) — folder stays a stable slug
  state.nodes ??= {};
  // structural hashing died with Plan 32 — scrub the legacy field on rewrite
  delete (state as unknown as Record<string, unknown>).lastPulledWorkflowHash;
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

    if (tsManaged) {
      if (!existsSync(filePath)) {
        log.warn(`${wf.name} / ${node.name}: TS-managed on remote but no local ${file} — pull cannot reconstruct .ts source; add the file (its compiled code stays on the n8n draft, see status --diff) before pushing`);
      } else {
        const compiled = await compileTs(filePath, log);
        const localHash = sha256(compiled);
        if (localHash === remoteHash) {
          // in sync — nothing to do
        } else if (localHash === nodeState.lastPushedHash) {
          log.warn(`${wf.name} / ${node.name}: edited in the n8n UI since last push — remote edits are not merged into ${file} (inspect with status --diff, port manually); the next push overwrites them`);
        } else if (remoteHash === nodeState.lastPushedHash) {
          log.info(`${node.name}: local ${file} modified, not yet pushed`);
        } else {
          log.warn(`${wf.name} / ${node.name}: CONFLICT — both ${file} and the remote code changed since last sync; inspect with status --diff and reconcile before pushing`);
        }
      }
    } else if (nodeState.file?.endsWith(".ts") || existsSync(path.join(dir, CODE_DIR, base + ".ts"))) {
      // Local .ts exists but remote carries no marker: never clobber TS source
      // and don't drop a competing .js next to it.
      const tsFile = nodeState.file ?? `${CODE_DIR}/${base}.ts`;
      log.warn(`${wf.name} / ${node.name}: local ${tsFile} exists but remote code has no @ts-n8n marker (not pushed from TS yet?) — keeping your .ts; the next push overwrites the remote code`);
      placeholders.set(node.id, tsFile);
      state.nodes[node.id] = { ...nodeState, file: tsFile, lastPushedHash: remoteHash, name: node.name };
      continue;
    } else {
      if (existsSync(filePath)) {
        const localHash = sha256(readFileSync(filePath, "utf8"));
        if (localHash !== remoteHash && nodeState.lastPushedHash !== undefined && localHash !== nodeState.lastPushedHash) {
          log.warn(`${wf.name} / ${node.name}: overwriting unpushed local changes in ${file} with the remote code (recover via git)`);
        }
      }
      if (writeIfChanged(filePath, remoteBody)) log.info(`wrote ${path.basename(dir)}/${file}`);
    }

    placeholders.set(node.id, file);
    state.nodes[node.id] = { ...nodeState, file, lastPushedHash: remoteHash, name: node.name };
  }

  // Drop state for nodes that no longer exist remotely (files stay; git is the safety net).
  const liveIds = new Set(wf.nodes.map((n) => n.id));
  for (const nodeId of Object.keys(state.nodes)) {
    if (!liveIds.has(nodeId)) {
      log.warn(`node ${nodeId} ("${state.nodes[nodeId].file}") no longer exists remotely — removing from state, delete the file manually if unwanted`);
      delete state.nodes[nodeId];
    }
  }

  // workflow.json is a READ-ONLY structure snapshot (Plan 32): written for
  // review diffs and the offline tooling (simulate, node run, refs, guards),
  // never pushed — structure is n8n's job now. Derived/permission fields are
  // dropped: `activeVersion` would duplicate every node's source in git,
  // `activeVersionId` churns on each publish, `shared`/`scopes`/`canExecute`
  // are viewer-relative MCP noise. The draft `versionId` is kept — the
  // executions stale-fixture warning compares against it.
  const wfOut = structuredClone(wf);
  delete wfOut.activeVersion;
  delete wfOut.activeVersionId;
  delete wfOut.shared;
  delete wfOut.scopes;
  delete wfOut.canExecute;
  for (const node of wfOut.nodes) {
    const file = placeholders.get(node.id);
    if (file) node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + file;
  }
  if (writeIfChanged(path.join(dir, "workflow.json"), stableWorkflowJson(wfOut))) {
    log.info(`wrote ${path.basename(dir)}/workflow.json`);
  }

  writeState(dir, state);
  if (commitOnPull) {
    await commitWorkflowDir(dir, `decanter: pulled "${wf.name}" (${id})`, log);
  }
  return { dir, name: wf.name };
}
