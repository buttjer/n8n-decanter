import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DecanterState } from "./types.mts";

export const STATE_FILE = ".decanter.json";

export function readState(dir: string): DecanterState | null {
  const file = path.join(dir, STATE_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as DecanterState;
}

export function writeState(dir: string, state: DecanterState): void {
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

/** All workflow folders under root (dirs containing a .decanter.json). */
export function listWorkflowDirs(root: string): string[] {
  const found: string[] = [];
  if (!existsSync(root)) return found;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
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
export function findWorkflowDir(root: string, workflowId: string): string | null {
  return listWorkflowDirs(root).find((dir) => readState(dir)?.workflowId === workflowId) ?? null;
}
