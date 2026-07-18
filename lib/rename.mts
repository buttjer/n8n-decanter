import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findWorkflowDir, readState, writeState } from "./state.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { CODE_DIR, FILE_PLACEHOLDER_PREFIX, isJsCodeNode, kebabCase, renameNodeRefs, stableWorkflowJson } from "./util.mts";
import { validateWorkflowDir } from "./validate.mts";

function loadWorkflow(root: string, id: string): { dir: string; wf: Workflow } {
  const dir = findWorkflowDir(root, id);
  if (!dir) throw new Error(`workflow ${id} not found under ${root} — pull it first`);
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`missing workflow.json in ${dir} — pull first`);
  return { dir, wf: JSON.parse(readFileSync(wfFile, "utf8")) as Workflow };
}

/** Rename `old` -> `new` in connection keys and every `{ node: … }` target. */
function renameInConnections(connections: Record<string, unknown>, oldName: string, newName: string): number {
  let changes = 0;
  for (const [source, byType] of Object.entries(connections)) {
    if (byType && typeof byType === "object") {
      for (const groups of Object.values(byType as Record<string, unknown>)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (!Array.isArray(group)) continue;
          for (const target of group) {
            if (target && typeof target === "object" && (target as { node?: unknown }).node === oldName) {
              (target as { node: string }).node = newName;
              changes++;
            }
          }
        }
      }
    }
    if (source === oldName) {
      connections[newName] = connections[oldName];
      delete connections[oldName];
      changes++;
    }
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

/** Move the renamed node's source file to its new kebab-case name (plus .remote.js sibling). */
function renameNodeFile(dir: string, node: WorkflowNode, newName: string, log: Log): void {
  if (!isJsCodeNode(node) || !node.parameters.jsCode.startsWith(FILE_PLACEHOLDER_PREFIX)) return;
  const current = node.parameters.jsCode.slice(FILE_PLACEHOLDER_PREFIX.length).trim();
  const ext = path.extname(current);
  let base = kebabCase(newName);
  let wanted = `${CODE_DIR}/${base}${ext}`;
  if (wanted === current) return;
  if (existsSync(path.join(dir, wanted))) {
    base = `${base}-${node.id.slice(0, 8)}`;
    wanted = `${CODE_DIR}/${base}${ext}`;
    if (existsSync(path.join(dir, wanted))) throw new Error(`cannot rename ${current}: both kebab-case targets exist (${wanted})`);
  }
  const renames: Array<[string, string]> = [[current, wanted], [current.replace(/\.(ts|js)$/, ".remote.js"), `${CODE_DIR}/${base}.remote.js`]];
  for (const [from, to] of renames) {
    const fromPath = path.join(dir, from);
    if (from !== to && existsSync(fromPath) && !existsSync(path.join(dir, to))) {
      renameSync(fromPath, path.join(dir, to));
      log.info(`renamed ${from} -> ${to}`);
    }
  }
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
  const { dir, wf } = loadWorkflow(root, id);
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
    if (!isJsCodeNode(n) || !n.parameters.jsCode.startsWith(FILE_PLACEHOLDER_PREFIX)) continue;
    const file = n.parameters.jsCode.slice(FILE_PLACEHOLDER_PREFIX.length).trim();
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

/** Rename the workflow itself. The folder is cosmetic and follows on the next pull. */
export function renameWorkflow(root: string, id: string, newName: string, log: Log): void {
  newName = newName.trim();
  if (!newName) throw new Error("new workflow name must not be empty");
  const { dir, wf } = loadWorkflow(root, id);
  if (wf.name === newName) throw new Error(`workflow is already named "${newName}"`);
  const oldName = wf.name;
  wf.name = newName;
  writeFileSync(path.join(dir, "workflow.json"), stableWorkflowJson(wf));
  log.info(`renamed workflow "${oldName}" -> "${newName}" — push to propagate; the folder follows on the next pull`);
}
