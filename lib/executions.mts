import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { findWorkflowDir, listWorkflowDirs } from "./state.mts";
import type { Execution, Log } from "./types.mts";

export const EXECUTIONS_DIR = "executions";

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
