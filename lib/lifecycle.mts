import { getWorkflowDetails, type McpClient, publishWorkflowMcp, unpublishWorkflowMcp } from "./mcp.mts";
import type { Log } from "./types.mts";
import { publicationState } from "./util.mts";
import { danglingNodeRefs, describeDanglingRefs } from "./validate.mts";

/**
 * What a successful publish may honestly claim. From n8n 2.40 on
 * (`N8N_USE_WORKFLOW_PUBLICATION_SERVICE`, default on) `publish_workflow`
 * marks the new version published and returns; n8n activates that version
 * (the whole workflow, triggers included) from a background outbox. Measured
 * on 2.44.5 over 50 publishes (25 single-main, 25 queue mode with a worker,
 * 2026-10-23): the webhook call made right after it returned ran the PREVIOUS
 * version every time; the new one answered after a median 0.4 s, 48 of 50
 * under 0.6 s, the slowest 2.3 s. Queue mode was no slower, and n8n's 15 s
 * fallback poll never fired. Multi-main is unmeasured (it needs an enterprise
 * licence). The only signal that activation finished is n8n's
 * cookie-authed
 * `/rest/workflows/:id/publication-status`, which neither MCP nor the public
 * API exposes, so there is nothing for decanter to wait on — the message says
 * so instead of claiming "live now". It says so on every n8n, with no version
 * check: decanter is optimised for the latest n8n (AGENTS.md), and 2.40+ can
 * turn the background activation off, so the version wouldn't tell anyway.
 */
export const publishedNote = (name: string, id: string): string =>
  `published "${name}" (${id}) — n8n activates it in the background; the previous version may still run for a second or two`;

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
  // Go-live gate (Plan 64 task 3b). Scans the draft we just read — the thing
  // about to become live — NOT the repo folder: `workflow.json` is a snapshot,
  // so grading it here would false-green on a stale mirror and false-red on a
  // fresh clone. The scan is shared with `test`'s static tier, and re-running it
  // is the point rather than waste: the instance can change between the two, so
  // only the check inside `publish` is authoritative for this publish. It costs
  // no extra call — the read above already happened.
  const dangling = danglingNodeRefs(before.nodes);
  if (dangling.length > 0) {
    throw new Error(
      [
        `refusing to publish "${before.name}" — ${dangling.length} dangling $('…') reference(s) on the draft would go live:`,
        ...describeDanglingRefs(dangling),
        `then re-check with: n8n-decanter test ${id}`,
      ].join("\n"),
    );
  }
  await publishWorkflowMcp(mcp, id);
  log.ok(publishedNote(before.name, id));
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
