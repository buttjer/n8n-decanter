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

/** Recursively find the workflow folder for an id by scanning .decanter.json files. */
export function findWorkflowDir(root, workflowId) {
  if (!existsSync(root)) return null;
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
      const state = readState(dir);
      if (state?.workflowId === workflowId) return dir;
      continue; // workflow folders don't nest
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "node_modules") stack.push(path.join(dir, e.name));
    }
  }
  return null;
}
