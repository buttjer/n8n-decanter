import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type McpClient, updateWorkflow } from "./mcp.mts";
import { pullWorkflow } from "./pull.mts";
import { findWorkflowDir, readState, writeState } from "./state.mts";
import type { DecanterConfig, Log, Workflow } from "./types.mts";
import { isJsCodeNode, placeholderFile, renameNodeRefs, stableWorkflowJson } from "./util.mts";

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

/**
 * Rename a node — a structure edit, so it is FORWARDED to n8n over MCP
 * (Plan 32: decanter never owns structure; ref verbs relay deliberate acts).
 * n8n's `renameNode` op rewrites connections and expression references
 * server-side (node ids survive, spike-verified), then a pull brings the
 * result down: the id-keyed `.decanter.json` map moves the local source file
 * to the new kebab name and `.js` bodies arrive with rewritten `$('…')` refs.
 * The one thing pull cannot update is local `.ts` SOURCE (one-way compile) —
 * its `$('…')` references are rewritten here before the pull so the next
 * push compiles against the new name.
 */
export async function renameNode(mcp: McpClient, config: DecanterConfig, id: string, oldName: string, newName: string, log: Log): Promise<void> {
  newName = newName.trim();
  if (!newName) throw new Error("new node name must not be empty");
  if (newName === oldName) throw new Error(`node is already named "${oldName}"`);
  const { dir, wf } = loadWorkflow(config.root, id, log);
  const node = wf.nodes.find((n) => n.name === oldName);
  if (!node) throw new Error(`no node named "${oldName}" in "${wf.name}" (nodes: ${wf.nodes.map((n) => `"${n.name}"`).join(", ")})`);
  if (wf.nodes.some((n) => n.name === newName)) throw new Error(`a node named "${newName}" already exists in "${wf.name}"`);

  await updateWorkflow(mcp, id, [{ type: "renameNode", oldName, newName }]);
  log.ok(`renamed node "${oldName}" -> "${newName}" in n8n`);

  // Rewrite $('…') in local .ts sources — the only files pull won't refresh.
  for (const n of wf.nodes) {
    if (!isJsCodeNode(n)) continue;
    const file = placeholderFile(n);
    if (file === null || !file.endsWith(".ts")) continue;
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) continue;
    const source = readFileSync(filePath, "utf8");
    const rewritten = renameNodeRefs(source, oldName, newName);
    if (rewritten !== source) {
      writeFileSync(filePath, rewritten);
      log.info(`updated $('${oldName}') references in ${file}`);
    }
  }

  await pullWorkflow(mcp, config.root, id, { commitOnPull: config.commitOnPull }, log);
}

/**
 * Rename the workflow itself — forwarded to n8n over MCP
 * (`setWorkflowMetadata`), then reflected locally. The folder is a stable
 * local pick and is left untouched (Plan 27); the always-current display
 * name is `.decanter.json.name`, updated here alongside the workflow.json
 * snapshot for immediate local consistency.
 */
export async function renameWorkflow(mcp: McpClient, root: string, id: string, newName: string, log: Log): Promise<void> {
  newName = newName.trim();
  if (!newName) throw new Error("new workflow name must not be empty");
  const { dir, wf } = loadWorkflow(root, id, log);
  if (wf.name === newName) throw new Error(`workflow is already named "${newName}"`);
  const oldName = wf.name;
  await updateWorkflow(mcp, id, [{ type: "setWorkflowMetadata", name: newName }]);
  wf.name = newName;
  writeFileSync(path.join(dir, "workflow.json"), stableWorkflowJson(wf));
  const state = readState(dir);
  if (state) {
    state.name = newName;
    writeState(dir, state);
  }
  log.ok(`renamed workflow "${oldName}" -> "${newName}" in n8n`);
}
