import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findWorkflowDir, readState, writeState } from "./state.mts";
import type { Log, Workflow, WorkflowNode } from "./types.mts";
import { CODE_DIR, CODE_NODE_TYPE, FILE_PLACEHOLDER_PREFIX, kebabCase, stableWorkflowJson } from "./util.mts";
import { validateWorkflowDir } from "./validate.mts";

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
 * Scaffold a `n8n-nodes-base.code` node into a pulled workflow in one atomic,
 * guard-checked step (offline; `push` propagates). Mints a v4 uuid, writes the
 * kebab-case source file under `code/` (sharing pull/rename's `-<id8>` collision
 * suffix), appends the node object (default parameters, `mode:
 * runOnceForAllItems`, a `//@file:` placeholder) to `workflow.json`, and
 * registers it in `.decanter.json`. **No connections are wired** — the node
 * lands disconnected but compliant; wiring stays in the editor. Re-validates
 * afterwards and fails loudly on any violation, exactly like `rename`.
 */
export function addCodeNode(root: string, id: string, nodeName: string, { ts = false }: { ts?: boolean } = {}, log: Log): void {
  nodeName = nodeName.trim();
  if (!nodeName) throw new Error("node name must not be empty");
  const dir = findWorkflowDir(root, id, log);
  if (!dir) throw new Error(`workflow ${id} not found under ${root} — pull it first`);
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`missing workflow.json in ${dir} — pull first`);
  let wf: Workflow;
  try {
    wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  } catch (err) {
    throw new Error(`${wfFile}: invalid JSON (${(err as Error).message})`);
  }
  if (wf.nodes.some((n) => n.name === nodeName)) throw new Error(`a node named "${nodeName}" already exists in "${wf.name}"`);

  const nodeId = randomUUID();
  const ext = ts ? ".ts" : ".js";
  mkdirSync(path.join(dir, CODE_DIR), { recursive: true });
  let base = kebabCase(nodeName);
  if (existsSync(path.join(dir, CODE_DIR, `${base}${ext}`))) {
    base = `${base}-${nodeId.slice(0, 8)}`;
    if (existsSync(path.join(dir, CODE_DIR, `${base}${ext}`))) {
      throw new Error(`cannot add "${nodeName}": both kebab-case targets exist (${CODE_DIR}/${base}${ext})`);
    }
  }
  const file = `${CODE_DIR}/${base}${ext}`;
  writeFileSync(path.join(dir, file), DEFAULT_SOURCE);

  const node: WorkflowNode = {
    id: nodeId,
    name: nodeName,
    type: CODE_NODE_TYPE,
    typeVersion: 2,
    position: nextPosition(wf.nodes),
    parameters: { mode: "runOnceForAllItems", jsCode: FILE_PLACEHOLDER_PREFIX + file },
  };
  wf.nodes.push(node);
  writeFileSync(wfFile, stableWorkflowJson(wf));

  const state = readState(dir);
  if (state) {
    state.nodes[nodeId] = { file };
    writeState(dir, state);
  }

  log.info(`added Code node "${nodeName}" (${nodeId}) -> ${file} — disconnected; wire it in the editor, then push to propagate`);

  const { errors } = validateWorkflowDir(dir);
  if (errors.length > 0) {
    throw new Error(`add left the workflow non-compliant — files were written, inspect (git diff) and fix:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  }
}
