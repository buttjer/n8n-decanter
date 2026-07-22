import { getWorkflowDetails, type McpClient, publishWorkflowMcp, unpublishWorkflowMcp } from "./mcp.mts";
import type { Log } from "./types.mts";
import { publicationState } from "./util.mts";

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
