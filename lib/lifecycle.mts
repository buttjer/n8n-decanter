import path from "node:path";
import {
  archiveWorkflowMcp,
  createWorkflowFromCode,
  getWorkflowDetails,
  type McpClient,
  publishWorkflowMcp,
  unpublishWorkflowMcp,
} from "./mcp.mts";
import { createPrompt } from "./prompt.mts";
import { pullWorkflow } from "./pull.mts";
import { findWorkflowDir } from "./state.mts";
import type { DecanterConfig, Log } from "./types.mts";
import { kebabCase, publicationState } from "./util.mts";

/**
 * `publish` — take the draft live (MCP `publish_workflow`, Plan 32). Since
 * pushes are draft-only now, this is THE go-live step: on a published
 * workflow whose draft diverged it publishes the newer draft; only a
 * workflow whose live version already equals the draft is a no-op note.
 */
export async function publishWorkflow(mcp: McpClient, id: string, log: Log): Promise<void> {
  const before = await getWorkflowDetails(mcp, id);
  if (publicationState(before) === "published" && before.activeVersionId === before.versionId) {
    log.info(`"${before.name}" (${id}) is already published — the draft is live`);
    return;
  }
  await publishWorkflowMcp(mcp, id);
  log.ok(`published "${before.name}" (${id}) — code is live now`);
}

/**
 * `unpublish` — return a published workflow to draft-only (MCP
 * `unpublish_workflow`). Already-unpublished is a no-op-with-a-note.
 */
export async function unpublishWorkflow(mcp: McpClient, id: string, log: Log): Promise<void> {
  const before = await getWorkflowDetails(mcp, id);
  if (publicationState(before) === "unpublished") {
    log.info(`"${before.name}" (${id}) is already unpublished — draft only`);
    return;
  }
  await unpublishWorkflowMcp(mcp, id);
  log.ok(`unpublished "${before.name}" (${id}) — draft only`);
}

/**
 * `create "<name>"` — a blank draft born on the server via MCP
 * (`create_workflow_from_code` with the minimal SDK expression), then pulled
 * so the folder + `.decanter.json` land and the id is printed. MCP-created
 * workflows are born `availableInMCP` (spike-verified), so the follow-up pull
 * just works. Born **unpublished**; create → edit → push → publish is the
 * full CLI loop. The server still assigns the id and owns the birth
 * (PLAN.md's "born in n8n" rule holds); the CLI only triggers it.
 */
export async function createWorkflow(mcp: McpClient, config: DecanterConfig, name: string, log: Log): Promise<{ dir: string; id: string }> {
  const created = await createWorkflowFromCode(mcp, name, kebabCase(name));
  const id = created.workflowId;
  log.ok(`created "${name}" (${id}) on the server — unpublished draft`);
  const { dir } = await pullWorkflow(mcp, config.root, id, { commitOnPull: config.commitOnPull }, log);
  log.info(`edit code/, push, then "publish" to go live`);
  return { dir, id };
}

/**
 * `archive <ref>` — archive a workflow on the server (MCP `archive_workflow`,
 * Plan 33). Replaces the API-era hard `delete` (maintainer decision
 * 2026-07-22): archiving hides the workflow under the n8n workflows list's
 * "Archived" filter and is reversible there; restoring and **permanent
 * deletion are deliberately out of decanter's surface** — both live in the
 * n8n UI. Archiving a published workflow unpublishes it first (server-side),
 * so consent stays explicit: on a TTY a `y/N` prompt naming the workflow
 * (and warning when it is live); non-interactive runs require `--force` and
 * abort without it. The **local folder is never touched** — it stays as the
 * git-tracked record — and a stale `decanter.config.json` `workflows` entry
 * is flagged. One workflow per call.
 */
export async function archiveWorkflow(mcp: McpClient, config: DecanterConfig, id: string, { force = false }: { force?: boolean } = {}, log: Log): Promise<void> {
  const before = await getWorkflowDetails(mcp, id); // authoritative name + proof it exists (and isn't already archived)
  const name = before.name;
  const live = publicationState(before) === "published";
  if (!force) {
    if (!process.stdin.isTTY) {
      throw new Error(`refusing to archive "${name}" (${id}) without confirmation — re-run with --force to archive in a non-interactive session`);
    }
    const rl = createPrompt();
    let answer: string;
    try {
      const liveNote = live ? " It is currently published — archiving takes it offline." : "";
      answer = (await rl.question(`Archive workflow "${name}" (${id}) on the n8n server?${liveNote} It moves to the workflows list's Archived filter (restore it there). [y/N] `)).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== "y" && answer !== "yes") {
      log.info("aborted — nothing archived");
      return;
    }
  }
  await archiveWorkflowMcp(mcp, id);
  log.ok(`archived "${name}" (${id})${live ? " — it was published and is now offline" : ""} — restore or permanently delete it from the n8n UI`);
  const dir = findWorkflowDir(config.root, id, log);
  if (dir) {
    log.info(`local folder ${path.relative(process.cwd(), dir) || "."} left untouched — it's your git-tracked record`);
  }
  if (config.workflows.includes(id)) {
    log.warn(`${id} is still listed in decanter.config.json "workflows" — remove it so pull/push/status stop targeting it`);
  }
}
