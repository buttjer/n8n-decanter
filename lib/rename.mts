import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findWorkflowDir, readState, renameNodeFilePair, writeState } from "./state.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { CODE_DIR, FILE_PLACEHOLDER_PREFIX, forEachConnectionTarget, isJsCodeNode, kebabCase, placeholderFile, renameNodeRefs, stableWorkflowJson } from "./util.mts";
import { validateWorkflowDir } from "./validate.mts";

function loadWorkflow(root: string, id: string, log: Log): { dir: string; wf: Workflow } {
  const dir = findWorkflowDir(root, id, log);
  if (!dir) throw new Error(`workflow ${id} not found under ${root} — pull it first`);
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`missing workflow.json in ${dir} — pull first`);
  try {
    return { dir, wf: JSON.parse(readFileSync(wfFile, "utf8")) as Workflow };
  } catch (err) {
    throw new Error(`${wfFile}: invalid JSON (${(err as Error).message})`);
  }
}

/** Rename `old` -> `new` in connection keys and every `{ node: … }` target. */
function renameInConnections(connections: Record<string, unknown>, oldName: string, newName: string): number {
  let changes = 0;
  forEachConnectionTarget(connections, (target) => {
    if (target.node === oldName) {
      (target as { node: string }).node = newName;
      changes++;
    }
  });
  if (Object.hasOwn(connections, oldName)) {
    connections[newName] = connections[oldName];
    delete connections[oldName];
    changes++;
  }
  return changes;
}

/** Rewrite `$('old')` in every string parameter of every node (skips the jsCode placeholder). */
function renameInParameters(value: unknown, oldName: string, newName: string, skipKey?: string): { value: unknown; changes: number } {
  if (typeof value === "string") {
    const rewritten = renameNodeRefs(value, oldName, newName);
    return { value: rewritten, changes: rewritten === value ? 0 : 1 };
  }
  let changes = 0;
  if (Array.isArray(value)) {
    const out = value.map((v) => {
      const r = renameInParameters(v, oldName, newName);
      changes += r.changes;
      return r.value;
    });
    return { value: out, changes };
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === skipKey) continue;
      const r = renameInParameters(v, oldName, newName);
      changes += r.changes;
      (value as Record<string, unknown>)[k] = r.value;
    }
  }
  return { value, changes };
}

/**
 * Move the renamed node's source file to its new kebab-case name (plus
 * .remote.js sibling). Collision handling is against the disk (unlike pull's
 * per-pull name set): an occupied target falls back to the `-<id8>` suffix,
 * a double collision throws for the user to resolve.
 */
function renameNodeFile(dir: string, node: WorkflowNode, newName: string, log: Log): void {
  if (!isJsCodeNode(node)) return;
  const current = placeholderFile(node);
  if (current === null) return;
  const ext = path.extname(current);
  let base = kebabCase(newName);
  if (`${CODE_DIR}/${base}${ext}` === current) return;
  if (existsSync(path.join(dir, `${CODE_DIR}/${base}${ext}`))) {
    base = `${base}-${node.id.slice(0, 8)}`;
    if (existsSync(path.join(dir, `${CODE_DIR}/${base}${ext}`))) {
      throw new Error(`cannot rename ${current}: both kebab-case targets exist (${CODE_DIR}/${base}${ext})`);
    }
  }
  const wanted = renameNodeFilePair(dir, current, base, ext, log);
  node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + wanted;
  const state = readState(dir);
  if (state?.nodes[node.id]) {
    state.nodes[node.id].file = wanted;
    writeState(dir, state);
  }
}

/**
 * Atomically rename a node everywhere the old name is load-bearing:
 * node.name, connection keys and targets, literal $('…') references in every
 * code file and expression parameter, the source filename, its //@file:
 * placeholder, and the .decanter.json entry. Offline; push propagates.
 */
export function renameNode(root: string, id: string, oldName: string, newName: string, log: Log): void {
  newName = newName.trim();
  if (!newName) throw new Error("new node name must not be empty");
  if (newName === oldName) throw new Error(`node is already named "${oldName}"`);
  const { dir, wf } = loadWorkflow(root, id, log);
  const node = wf.nodes.find((n) => n.name === oldName);
  if (!node) throw new Error(`no node named "${oldName}" in "${wf.name}" (nodes: ${wf.nodes.map((n) => `"${n.name}"`).join(", ")})`);
  if (wf.nodes.some((n) => n.name === newName)) throw new Error(`a node named "${newName}" already exists in "${wf.name}"`);

  node.name = newName;
  const connectionChanges = renameInConnections(wf.connections ?? {}, oldName, newName);

  let paramChanges = 0;
  for (const n of wf.nodes) {
    paramChanges += renameInParameters(n.parameters, oldName, newName, "jsCode").changes;
  }

  // Rewrite $('…') in every node source file (referenced ones; .remote.js
  // snapshots mirror remote code and stay untouched).
  let fileChanges = 0;
  for (const n of wf.nodes) {
    if (!isJsCodeNode(n)) continue;
    const file = placeholderFile(n);
    if (file === null) continue;
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) continue;
    const source = readFileSync(filePath, "utf8");
    const rewritten = renameNodeRefs(source, oldName, newName);
    if (rewritten !== source) {
      writeFileSync(filePath, rewritten);
      fileChanges++;
      log.info(`updated $('${oldName}') references in ${file}`);
    }
  }

  renameNodeFile(dir, node, newName, log);
  writeFileSync(path.join(dir, "workflow.json"), stableWorkflowJson(wf));
  log.info(`renamed node "${oldName}" -> "${newName}" (${connectionChanges} connection ref${connectionChanges === 1 ? "" : "s"}, ${paramChanges} parameter ref${paramChanges === 1 ? "" : "s"}, ${fileChanges} code file${fileChanges === 1 ? "" : "s"}) — push to propagate`);

  const { errors } = validateWorkflowDir(dir);
  if (errors.length > 0) {
    throw new Error(`rename left the workflow non-compliant — files were written, inspect (git diff) and fix:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  }
}

/**
 * Rename the workflow itself. The folder is a stable local pick and is left
 * untouched (Plan 27); the always-current display name is `.decanter.json.name`,
 * updated here alongside workflow.json for immediate local consistency.
 */
export function renameWorkflow(root: string, id: string, newName: string, log: Log): void {
  newName = newName.trim();
  if (!newName) throw new Error("new workflow name must not be empty");
  const { dir, wf } = loadWorkflow(root, id, log);
  if (wf.name === newName) throw new Error(`workflow is already named "${newName}"`);
  const oldName = wf.name;
  wf.name = newName;
  writeFileSync(path.join(dir, "workflow.json"), stableWorkflowJson(wf));
  const state = readState(dir);
  if (state) {
    state.name = newName;
    writeState(dir, state);
  }
  log.info(`renamed workflow "${oldName}" -> "${newName}" — push to propagate`);
}
