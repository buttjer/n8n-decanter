import path from "node:path";
import type { N8nApi } from "./api.mts";
import { createPrompt } from "./prompt.mts";
import { pullWorkflow } from "./pull.mts";
import { findWorkflowDir } from "./state.mts";
import type { DecanterConfig, Log } from "./types.mts";
import { publicationState } from "./util.mts";

/**
 * `publish` — take an unpublished draft live (n8n 2.x activate). A workflow
 * that is already published is a no-op-with-a-note, not an error: a push to a
 * published workflow auto-publishes anyway. Needs credentials (not offline).
 */
export async function publishWorkflow(api: N8nApi, id: string, log: Log): Promise<void> {
  const before = await api.getWorkflow(id);
  if (publicationState(before) === "published") {
    log.info(`"${before.name}" (${id}) is already published — code is live (pushes auto-publish)`);
    return;
  }
  await api.activateWorkflow(id);
  log.ok(`published "${before.name}" (${id}) — code is live now`);
}

/**
 * `unpublish` — return a published workflow to draft-only (n8n 2.x deactivate).
 * Already-unpublished is a no-op-with-a-note. Needs credentials (not offline).
 */
export async function unpublishWorkflow(api: N8nApi, id: string, log: Log): Promise<void> {
  const before = await api.getWorkflow(id);
  if (publicationState(before) === "unpublished") {
    log.info(`"${before.name}" (${id}) is already unpublished — draft only`);
    return;
  }
  await api.deactivateWorkflow(id);
  log.ok(`unpublished "${before.name}" (${id}) — draft only`);
}

/**
 * `create "<name>"` — a blank draft born on the server, then pulled so the
 * folder + `.decanter.json` land and the id is printed. Born **unpublished**
 * (`publish` takes it live), so create → edit → push → publish is a full CLI
 * loop. The server still assigns the id and owns the birth (PLAN.md's "born in
 * n8n" rule holds); the CLI only triggers it. Shares `api.createWorkflow` with
 * Plan 21's `duplicate`.
 */
export async function createWorkflow(api: N8nApi, config: DecanterConfig, name: string, log: Log): Promise<{ dir: string; id: string }> {
  const created = await api.createWorkflow(name);
  const id = created.id;
  log.ok(`created "${name}" (${id}) on the server — unpublished draft`);
  const { dir } = await pullWorkflow(api, config.root, id, { commitOnPull: config.commitOnPull }, log);
  log.info(`edit code/, push, then "publish" to go live`);
  return { dir, id };
}

/**
 * `<ref> delete` — hard-delete a workflow from the server, deliberately.
 * Destructive and outward-facing, so consent is explicit: on a TTY a `y/N`
 * prompt naming the workflow; non-interactive runs require `--force` and abort
 * without it. The **local folder is never touched** — it stays as the
 * git-tracked record — and a stale `decanter.config.json` `workflows` entry is
 * flagged. One workflow per call (the dispatcher enforces exactly one ref).
 */
export async function deleteWorkflow(api: N8nApi, config: DecanterConfig, id: string, { force = false }: { force?: boolean } = {}, log: Log): Promise<void> {
  const remote = await api.getWorkflow(id); // authoritative name + proof it exists
  const name = remote.name;
  if (!force) {
    if (!process.stdin.isTTY) {
      throw new Error(`refusing to delete "${name}" (${id}) without confirmation — re-run with --force to delete in a non-interactive session`);
    }
    const rl = createPrompt();
    let answer: string;
    try {
      answer = (await rl.question(`Delete workflow "${name}" (${id}) from the n8n server? This cannot be undone. [y/N] `)).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== "y" && answer !== "yes") {
      log.info("aborted — nothing deleted");
      return;
    }
  }
  await api.deleteWorkflow(id);
  log.ok(`deleted "${name}" (${id}) from the server`);
  const dir = findWorkflowDir(config.root, id, log);
  if (dir) {
    log.info(`local folder ${path.relative(process.cwd(), dir) || "."} left untouched — it's your git-tracked record`);
  }
  if (config.workflows.includes(id)) {
    log.warn(`${id} is still listed in decanter.config.json "workflows" — remove it so pull/push/status stop targeting it`);
  }
}
