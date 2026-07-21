import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { findWorkflowDir, listWorkflowDirs } from "./state.mts";
import type { Execution, Log, Workflow } from "./types.mts";

export const EXECUTIONS_DIR = "executions";
/**
 * Committed, hand-editable execution mocks (Plan 7 task 6) — a capture promoted
 * by the `mock` verb, with any gap nodes flagged for filling. Tracked in git
 * (unlike gitignored `executions/`), so mocked replays are reproducible for
 * teammates and CI. `simulate` prefers a mock over the raw capture of the same id.
 */
export const EXECUTION_MOCKS_DIR = "execution-mocks";

/**
 * The newest execution id available to replay in a workflow folder — the highest
 * numeric `<id>.json` across the committed `execution-mocks/` dir and the
 * gitignored `executions/` dir, or null when none exist. n8n execution ids are
 * incrementing integers, so "newest" is the highest numeric filename; non-numeric
 * files are ignored. Lets `simulate`/`mock` (and the picker, which can't supply an
 * id) default to the latest — including a mock on a fresh checkout with no captures.
 */
export function latestCaptureId(dir: string): string | null {
  let best: number | null = null;
  for (const sub of [EXECUTION_MOCKS_DIR, EXECUTIONS_DIR]) {
    const outDir = path.join(dir, sub);
    if (!existsSync(outDir)) continue;
    for (const entry of readdirSync(outDir)) {
      const m = entry.match(/^(\d+)\.json$/);
      if (m && (best === null || Number(m[1]) > best)) best = Number(m[1]);
    }
  }
  return best === null ? null : String(best);
}

/**
 * Warn when fetched executions ran a *published* version that differs from the
 * local draft (`workflow.json`'s `versionId`) — the captured data may not match
 * the code you're now editing (PLAN.md's "convenience data, not ground truth"
 * caveat, enforced). A warning, not an error: the data is still useful. Deduped
 * by version so a page of same-version executions warns once; silent when the
 * draft version or the execution version is unavailable (defensive).
 */
export function warnStaleFixtures(dir: string, executions: Execution[], log: Log): void {
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) return;
  let draft: unknown;
  try {
    draft = (JSON.parse(readFileSync(wfFile, "utf8")) as Workflow).versionId;
  } catch {
    return; // unparsable workflow.json — nothing to compare against
  }
  if (typeof draft !== "string") return;
  const stale = new Set<string>();
  for (const exec of executions) {
    if (typeof exec.workflowVersionId === "string" && exec.workflowVersionId !== draft) stale.add(exec.workflowVersionId);
  }
  for (const ran of stale) {
    log.warn(`captured executions ran published version ${ran}; your draft is ${draft} — the data may not match the code you're editing`);
  }
}

/**
 * Materialize execution JSON under `<workflow>/executions/`. The dir is made
 * self-ignoring via an `executions/.gitignore` containing `*` — execution
 * data can hold credentials/PII and sits inside the commit-on-pull/push
 * pathspec, so it must never reach git regardless of the sync dir's root
 * .gitignore (which init scaffolds, but pre-existing dirs won't have).
 */
function writeExecutionFiles(dir: string, executions: Execution[], log: Log): void {
  const outDir = path.join(dir, EXECUTIONS_DIR);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, ".gitignore"), "*\n");
  for (const exec of executions) {
    const file = path.join(outDir, `${exec.id}.json`);
    writeFileSync(file, JSON.stringify(exec, null, 2) + "\n");
    log.info(`wrote ${path.relative(process.cwd(), file)}${exec.status !== undefined ? ` (${exec.status})` : ""}`);
  }
}

/** Fetch recent executions of one workflow into its `executions/` dir. */
export async function fetchExecutions(
  api: N8nApi,
  root: string,
  workflowId: string,
  { status, limit }: { status?: string; limit?: number },
  log: Log,
): Promise<void> {
  const dir = findWorkflowDir(root, workflowId, log);
  if (!dir) throw new Error(`workflow ${workflowId} not found under ${root} — pull it first`);
  const executions = await api.listExecutions({ workflowId, status, limit });
  if (executions.length === 0) {
    log.info(`no executions on the server for ${workflowId}${status !== undefined ? ` with status "${status}"` : ""}`);
    return;
  }
  writeExecutionFiles(dir, executions, log);
  warnStaleFixtures(dir, executions, log);
  log.ok(`${executions.length} execution${executions.length === 1 ? "" : "s"} -> ${path.relative(process.cwd(), path.join(dir, EXECUTIONS_DIR))} (gitignored — temp data, "executions clean" removes it)`);
}

/**
 * Fetch one execution by its (numeric) id. The execution's own `workflowId`
 * decides the target folder — no workflow ref needed on the CLI.
 */
export async function fetchExecutionById(api: N8nApi, root: string, executionId: string, log: Log): Promise<void> {
  const exec = await api.getExecution(executionId);
  const workflowId = typeof exec.workflowId === "string" ? exec.workflowId : undefined;
  if (workflowId === undefined) throw new Error(`execution ${executionId}: response carries no workflowId — cannot place it`);
  const dir = findWorkflowDir(root, workflowId, log);
  if (!dir) throw new Error(`execution ${executionId} belongs to workflow ${workflowId}, which is not pulled under ${root} — pull it first`);
  writeExecutionFiles(dir, [exec], log);
  warnStaleFixtures(dir, [exec], log);
  log.ok(`execution ${executionId} -> ${path.relative(process.cwd(), path.join(dir, EXECUTIONS_DIR))}`);
}

/**
 * Delete `executions/` dirs — for the given workflow ids, or every pulled
 * workflow when none are given. Offline; missing dirs are fine.
 */
export function cleanExecutions(root: string, workflowIds: string[], log: Log): void {
  const dirs = workflowIds.length > 0
    ? workflowIds.map((id) => {
        const dir = findWorkflowDir(root, id, log);
        if (!dir) throw new Error(`workflow ${id} not found under ${root}`);
        return dir;
      })
    : listWorkflowDirs(root);
  let removed = 0;
  for (const dir of dirs) {
    const outDir = path.join(dir, EXECUTIONS_DIR);
    if (!existsSync(outDir)) continue;
    rmSync(outDir, { recursive: true, force: true });
    log.info(`removed ${path.relative(process.cwd(), outDir)}`);
    removed++;
  }
  if (removed === 0) log.info("no executions/ dirs to clean");
  else log.ok(`cleaned ${removed} executions dir${removed === 1 ? "" : "s"}`);
}
