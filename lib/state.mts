import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DecanterState, Log } from "./types.mts";

export const STATE_FILE = ".decanter.json";

/** Missing state is null; corrupt state throws a clear, file-naming error. */
export function readState(dir: string): DecanterState | null {
  const file = path.join(dir, STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DecanterState;
  } catch (err) {
    throw new Error(`corrupt ${STATE_FILE} (${(err as Error).message})`);
  }
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

/**
 * Find the workflow folder for an id by scanning .decanter.json files.
 * A corrupt state file only skips its own folder (warned via `log`) — it must
 * not take down commands for every other workflow.
 */
export function findWorkflowDir(root: string, workflowId: string, log?: Log): string | null {
  for (const dir of listWorkflowDirs(root)) {
    try {
      if (readState(dir)?.workflowId === workflowId) return dir;
    } catch (err) {
      log?.warn(`${dir}: ${(err as Error).message} — skipping this folder`);
    }
  }
  return null;
}
