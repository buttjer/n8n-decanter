import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type McpClient, updateWorkflow } from "./mcp.mts";
import { pullWorkflow } from "./pull.mts";
import { dirtyJsFiles, findWorkflowDir, readState, writeState } from "./state.mts";
import type { DecanterConfig, Log, Workflow, WorkflowNode } from "./types.mts";
import { CODE_NODE_TYPE, FILE_PLACEHOLDER_PREFIX, stableWorkflowJson } from "./util.mts";

/**
 * Starter source for a freshly scaffolded Code node: valid, self-contained
 * (no `$('…')` references, so it lands compliant), and it typechecks under the
 * n8n ambient globals — the same body for `.js` and `.ts`.
 */
const DEFAULT_SOURCE = `// New Code node — runs once for all items. Edit me, then push.
// See https://docs.n8n.io/code/ for the Code node API.
for (const item of $input.all()) {
  item.json.myNewField = 1;
}

return $input.all();
`;

/** Rightmost node's x + a step, so a scaffolded node doesn't stack on another. */
function nextPosition(nodes: WorkflowNode[]): [number, number] {
  let maxX = 0;
  for (const node of nodes) {
    const pos = (node as { position?: unknown }).position;
    if (Array.isArray(pos) && typeof pos[0] === "number") maxX = Math.max(maxX, pos[0]);
  }
  return [maxX + 220, 0];
}

/**
 * Scaffold a `n8n-nodes-base.code` node — born in n8n over MCP (`addNode`
 * with the starter source, Plan 32: creating the vessel for code is a
 * Code-node-layer act, forwarded like every structure touch), then pulled so
 * the kebab-case file under `code/` and the `.decanter.json` entry land.
 * **No connections are wired** — the node lands disconnected; wiring stays
 * in the editor. `--ts` converts the pulled `.js` to `.ts` in place (the
 * starter body is valid TS); the `@ts-n8n` marker appears on first push.
 */
export async function addCodeNode(mcp: McpClient, config: DecanterConfig, id: string, nodeName: string, { ts = false }: { ts?: boolean } = {}, log: Log): Promise<void> {
  nodeName = nodeName.trim();
  if (!nodeName) throw new Error("node name must not be empty");
  const dir = findWorkflowDir(config.root, id, log);
  if (!dir) throw new Error(`workflow ${id} not found under ${config.root} — pull it first`);
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`missing workflow.json in ${dir} — pull first`);
  let wf: Workflow;
  try {
    wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  } catch (err) {
    throw new Error(`${wfFile}: invalid JSON (${(err as Error).message})`);
  }
  if (wf.nodes.some((n) => n.name === nodeName)) throw new Error(`a node named "${nodeName}" already exists in "${wf.name}"`);
  // Pre-flight BEFORE the remote add: the embedded pull below overwrites .js
  // files with the remote body, dropping unpushed edits (Plan 33 guard).
  const dirty = dirtyJsFiles(dir);
  if (dirty.length > 0) {
    throw new Error(`unpushed local edits in ${dirty.join(", ")} — node create pulls the workflow afterwards, overwriting them; push first (or commit so git can recover them)`);
  }

  const nodeId = randomUUID();
  await updateWorkflow(mcp, id, [{
    type: "addNode",
    node: {
      id: nodeId,
      name: nodeName,
      type: CODE_NODE_TYPE,
      typeVersion: 2,
      position: nextPosition(wf.nodes),
      parameters: { mode: "runOnceForAllItems", jsCode: DEFAULT_SOURCE },
    },
  }]);

  const pulled = await pullWorkflow(mcp, config.root, id, { commitOnPull: config.commitOnPull }, log);
  const state = readState(pulled.dir);
  // the server may re-mint the node id — resolve the new node by NAME once
  const entry = state === null ? undefined : Object.entries(state.nodes).find(([, ns]) => ns.name === nodeName);
  if (!entry || state === null) {
    throw new Error(`node "${nodeName}" was created in n8n but did not land locally — pull and inspect`);
  }
  const [landedId, ns] = entry;
  let file = ns.file;

  if (ts && file.endsWith(".js")) {
    // convert in place: the starter body is valid TS; push compiles + markers it
    const tsFile = file.replace(/\.js$/, ".ts");
    renameSync(path.join(pulled.dir, file), path.join(pulled.dir, tsFile));
    ns.file = tsFile;
    writeState(pulled.dir, state);
    const snapshot = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
    const node = snapshot.nodes.find((n) => n.id === landedId);
    if (node) {
      node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + tsFile;
      writeFileSync(wfFile, stableWorkflowJson(snapshot));
    }
    file = tsFile;
  }

  log.info(`added Code node "${nodeName}" (${landedId}) -> ${file} — disconnected; wire it in the n8n editor`);
}
