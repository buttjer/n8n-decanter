import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DecanterState, Log } from "./types.mts";
import { CODE_DIR, sha256 } from "./util.mts";

export const STATE_FILE = ".decanter.json";

/**
 * Locate the workflow folder a node file belongs to: the file's own
 * directory, or its parent when the file sits in `code/`. `marker` is the
 * file that proves a workflow folder — `.decanter.json` for sync state,
 * `workflow.json` for structure. Null when neither location qualifies.
 */
export function nodeFileContextDir(filePath: string, marker: string = STATE_FILE): string | null {
  let dir = path.dirname(filePath);
  if (!existsSync(path.join(dir, marker)) && path.basename(dir) === CODE_DIR) {
    dir = path.dirname(dir);
  }
  return existsSync(path.join(dir, marker)) ? dir : null;
}

/**
 * Rename a node's source file *and* its `.remote.js` sibling to a new kebab
 * base. Never renames across extensions (an `ext` differing from the current
 * file's leaves the source in place — compiled JS must not silently become
 * "TS source"), and never clobbers an existing target: skipped renames are
 * silent because both callers handle them (pull rewrites content afterwards,
 * remote being authoritative; rename pre-checks collisions and throws).
 * Returns the wanted relative path (`code/<base><ext>`).
 */
export function renameNodeFilePair(dir: string, current: string, base: string, ext: string, log: Log): string {
  const wanted = `${CODE_DIR}/${base}${ext}`;
  const renames: Array<[string, string]> = [[current.replace(/\.(ts|js)$/, ".remote.js"), `${CODE_DIR}/${base}.remote.js`]];
  if (path.extname(current) === ext) renames.push([current, wanted]);
  for (const [from, to] of renames) {
    const fromPath = path.join(dir, from);
    if (from !== to && existsSync(fromPath) && !existsSync(path.join(dir, to))) {
      renameSync(fromPath, path.join(dir, to));
      log.info(`renamed ${from} -> ${to}`);
    }
  }
  return wanted;
}

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

/**
 * Tracked `.js` node files with unpushed local edits (hash ≠ last-sync
 * hash) — exactly the files an embedded pull would overwrite with the
 * remote body. `.ts` sources are never touched by pull, so they're not
 * listed. Empty when there is no state (nothing tracked, nothing at risk).
 */
export function dirtyJsFiles(dir: string): string[] {
  const state = readState(dir);
  if (!state) return [];
  const dirty: string[] = [];
  for (const ns of Object.values(state.nodes)) {
    if (!ns.file.endsWith(".js") || ns.lastPushedHash === undefined) continue;
    const filePath = path.join(dir, ns.file);
    if (!existsSync(filePath)) continue;
    if (sha256(readFileSync(filePath, "utf8")) !== ns.lastPushedHash) dirty.push(ns.file);
  }
  return dirty;
}

/** All workflow folders under root (dirs containing a .decanter.json). */
export function listWorkflowDirs(root: string): string[] {
  const found: string[] = [];
  if (!existsSync(root)) return found;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
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

/** One pulled workflow as addressable from the CLI (Plan 11 name resolution). */
export interface WorkflowRef {
  id: string;
  dir: string;
  /** Display name: `.decanter.json.name`, then workflow.json's `name`, then the folder name. */
  name: string;
  /** Every name the ref answers to (workflow name + folder basename), deduped. */
  names: string[];
}

/**
 * All pulled workflows with their addressable names. A corrupt or missing
 * state file only skips its own folder (warned via `log`), same as
 * findWorkflowDir.
 */
export function listWorkflowRefs(root: string, log?: Log): WorkflowRef[] {
  const refs: WorkflowRef[] = [];
  for (const dir of listWorkflowDirs(root)) {
    let state: DecanterState | null;
    try {
      state = readState(dir);
    } catch (err) {
      log?.warn(`${dir}: ${(err as Error).message} — skipping this folder`);
      continue;
    }
    if (!state) continue;
    const folderName = path.basename(dir);
    // Prefer the cached display name (Plan 27), then workflow.json, then the
    // folder — so a missing/corrupt workflow.json still resolves by name.
    let wfName = state.name;
    if (wfName === undefined) {
      try {
        wfName = (JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8")) as { name?: string }).name;
      } catch {
        // no or unparsable workflow.json — the folder name still addresses it
      }
    }
    const names = [...new Set([wfName, folderName].filter((n): n is string => typeof n === "string" && n !== ""))];
    refs.push({ id: state.workflowId, dir, name: wfName ?? folderName, names });
  }
  return refs;
}

/**
 * Match a CLI workflow argument against candidates: exact id → exact name
 * (case-insensitive) → unique name prefix. Several matches in a tier throw,
 * listing the candidates; no match returns null (never a prompt — ambiguity
 * must stay script- and LLM-safe).
 */
export function matchWorkflowRef<T extends { id: string; names: string[] }>(candidates: T[], ref: string): T | null {
  const byId = candidates.find((c) => c.id === ref);
  if (byId) return byId;
  const lc = ref.toLowerCase();
  for (const tier of [
    candidates.filter((c) => c.names.some((n) => n.toLowerCase() === lc)),
    candidates.filter((c) => c.names.some((n) => n.toLowerCase().startsWith(lc))),
  ]) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) {
      throw new Error(`ambiguous workflow "${ref}" — matches ${tier.map((c) => `"${c.names[0]}" (${c.id})`).join(", ")}`);
    }
  }
  return null;
}

/** True when a ref could plausibly be a raw workflow id (opaque alphanumeric token). */
export function looksLikeWorkflowId(ref: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(ref);
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
