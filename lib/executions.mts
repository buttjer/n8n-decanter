import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { findWorkflowDir, listWorkflowDirs } from "./state.mts";
import type { Execution, Log, Workflow } from "./types.mts";

export const EXECUTIONS_DIR = "executions";
/**
 * Committed, hand-editable **scenarios** (Plan 7 task 6, renamed Plan 37) —
 * named, full-workflow pin-data sets created by `scenario create` from a
 * captured execution (or scaffolded from the workflow's schemas), with any gap
 * nodes flagged for filling. Tracked in git (unlike gitignored `executions/`),
 * so replays are reproducible for teammates and CI. Selected explicitly by slug
 * (`simulate --scenario <slug>`), not auto-preferred.
 */
export const SCENARIOS_DIR = "scenarios";
/** Pre-Plan-37 dir name for scenarios; auto-migrated to `scenarios/` on any verb that touches it. */
export const LEGACY_MOCKS_DIR = "mocks";
/** Retired per-node pin dir (`simulate --pin`); a leftover one is now a hard error naming the replacement. */
export const LEGACY_FIXTURES_DIR = "fixtures";

/**
 * Auto-migrate a workflow folder's pre-Plan-37 `mocks/` dir to `scenarios/`
 * (Plan 37 fold decision: the dir rename is automatic, separate from the
 * verb/flag spelling change). Plain `renameSync` — the pull/push/watch
 * auto-commit records it as a git rename, preserving history. Refuses when both
 * dirs exist (a manual merge is needed). No-op when there's no legacy dir.
 */
export function migrateScenariosDir(dir: string, log: Log): void {
  const legacy = path.join(dir, LEGACY_MOCKS_DIR);
  if (!existsSync(legacy)) return;
  const target = path.join(dir, SCENARIOS_DIR);
  if (existsSync(target)) {
    throw new Error(
      `both ${LEGACY_MOCKS_DIR}/ (legacy) and ${SCENARIOS_DIR}/ exist in ${path.relative(process.cwd(), dir)} — ` +
        `move the ${LEGACY_MOCKS_DIR}/*.json files into ${SCENARIOS_DIR}/ and delete ${LEGACY_MOCKS_DIR}/`,
    );
  }
  renameSync(legacy, target);
  log.info(`migrated ${LEGACY_MOCKS_DIR}/ -> ${SCENARIOS_DIR}/ (mock -> scenario)`);
}

/**
 * Hard-error on a leftover `fixtures/` dir (Plan 37 fold decision 1: no
 * deprecation read-path). `simulate --pin` and per-node `fixtures/` are removed;
 * their role is absorbed by self-contained scenarios. Names the replacement.
 * No-op when there's no `fixtures/` dir with `.json` files in it.
 */
export function assertNoLegacyFixtures(dir: string): void {
  const fx = path.join(dir, LEGACY_FIXTURES_DIR);
  if (!existsSync(fx)) return;
  if (!readdirSync(fx).some((e) => e.endsWith(".json"))) return;
  throw new Error(
    `legacy ${LEGACY_FIXTURES_DIR}/ dir found in ${path.relative(process.cwd(), dir)} — per-node fixtures and \`simulate --pin\` were removed (Plan 37). ` +
      `Recreate the data as a committed scenario (\`n8n-decanter <workflow> scenario create --execution <id>\`), then delete ${LEGACY_FIXTURES_DIR}/.`,
  );
}

/**
 * The newest captured execution id in a workflow folder's `executions/` dir, or
 * null when none are captured. n8n execution ids are incrementing integers, so
 * "newest" is the highest numeric filename; non-numeric files are ignored. Lets
 * `simulate`/`scenario create` (and the picker, which can't supply an id) default
 * to the latest capture. Scenarios are slug-named, not "latest"-ordered, so
 * they're chosen explicitly and don't participate here.
 */
export function latestCaptureId(dir: string): string | null {
  const outDir = path.join(dir, EXECUTIONS_DIR);
  if (!existsSync(outDir)) return null;
  let best: number | null = null;
  for (const entry of readdirSync(outDir)) {
    const m = entry.match(/^(\d+)\.json$/);
    if (m && (best === null || Number(m[1]) > best)) best = Number(m[1]);
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
export function warnStaleCaptures(dir: string, executions: Execution[], log: Log): void {
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
  warnStaleCaptures(dir, executions, log);
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
  warnStaleCaptures(dir, [exec], log);
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
