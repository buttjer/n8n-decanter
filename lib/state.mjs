import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STATE_FILE = ".decanter.json";

export function readState(dir) {
  const file = path.join(dir, STATE_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeState(dir, state) {
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

/** All workflow folders under root (dirs containing a .decanter.json). */
export function listWorkflowDirs(root) {
  const found = [];
  if (!existsSync(root)) return found;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === STATE_FILE)) {
      found.push(dir); // workflow folders don't nest
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "node_modules") stack.push(path.join(dir, e.name));
    }
  }
  return found.sort();
}

/** Find the workflow folder for an id by scanning .decanter.json files. */
export function findWorkflowDir(root, workflowId) {
  return listWorkflowDirs(root).find((dir) => readState(dir)?.workflowId === workflowId) ?? null;
}
