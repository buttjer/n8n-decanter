import { readFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import {
  createWorkflowFromCode,
  ENABLE_MCP_HINT,
  getWorkflowDetails,
  isUnavailableInMcp,
  type McpClient,
  publishWorkflowMcp,
  unpublishWorkflowMcp,
} from "./mcp.mts";
import { createPrompt } from "./prompt.mts";
import { pullWorkflow } from "./pull.mts";
import { assertCompliant, buildNodeCode } from "./push.mts";
import { findWorkflowDir } from "./state.mts";
import type { DecanterConfig, Log, Workflow } from "./types.mts";
import { isJsCodeNode, kebabCase, placeholderFile, publicationState, sanitizeForPut } from "./util.mts";
import { validateWorkflowDir } from "./validate.mts";

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
 * `<ref> duplicate ["<new name>"]` — clone an already-pulled workflow into a
 * brand-new remote one. This verb stays on the public REST API (Plan 32
 * decision): MCP's only creation path is Workflow-SDK *code*, and
 * re-expressing an arbitrary pulled JSON graph as SDK code is exactly the
 * lossy transformation the decanter refuses to own — `POST /workflows` with
 * the assembled body is lossless. The body comes from the **local** folder
 * exactly as the old API push did (placeholders reconstituted from `code/`,
 * `.ts` nodes compiled), so the clone carries the repo's current content.
 * The copy is API-born and therefore NOT `availableInMCP` — the follow-up
 * pull is attempted and, when refused, turns into guidance instead of an
 * error. Default name `"<name> (copy)"` (matching the n8n UI); born
 * unpublished; source folder and remote stay untouched.
 */
export async function duplicateWorkflow(api: N8nApi, mcp: McpClient, config: DecanterConfig, id: string, newName: string | undefined, log: Log): Promise<{ dir: string | null; id: string }> {
  const dir = findWorkflowDir(config.root, id, log);
  if (!dir) throw new Error(`workflow ${id} not found under ${config.root} — pull it first`);
  assertCompliant(validateWorkflowDir(dir), log, `"${path.basename(dir)}"`);
  const wf = JSON.parse(readFileSync(path.join(dir, "workflow.json"), "utf8")) as Workflow;
  const sourceName = wf.name;
  for (const node of wf.nodes) {
    if (!isJsCodeNode(node)) continue;
    const file = placeholderFile(node);
    if (file === null) continue;
    node.parameters.jsCode = (await buildNodeCode(dir, file, log)).jsCode;
  }
  const body = sanitizeForPut(wf);
  body.name = newName?.trim() || `${sourceName} (copy)`;
  const created = await api.createWorkflow(body);
  log.ok(`duplicated "${sourceName}" -> "${body.name}" (${created.id}) on the server — unpublished draft`);
  try {
    const { dir: newDir } = await pullWorkflow(mcp, config.root, created.id, { commitOnPull: config.commitOnPull }, log);
    log.info(`edit code/, push, then "publish" to go live`);
    return { dir: newDir, id: created.id };
  } catch (err) {
    if (!isUnavailableInMcp(err)) throw err;
    // API-born workflows aren't opted into MCP — the copy exists, only the pull is gated
    log.warn(`the copy is not yet available in MCP — ${ENABLE_MCP_HINT}, then: n8n-decanter pull ${created.id}`);
    return { dir: null, id: created.id };
  }
}

/**
 * `<ref> delete` — hard-delete a workflow from the server, deliberately.
 * Stays on the public REST API (Plan 32 decision): MCP offers only
 * `archive_workflow`, and this verb's contract is the real
 * `DELETE /workflows/:id` (which removes even a published workflow
 * outright). Destructive and outward-facing, so consent is explicit: on a
 * TTY a `y/N` prompt naming the workflow; non-interactive runs require
 * `--force` and abort without it. The **local folder is never touched** —
 * it stays as the git-tracked record — and a stale `decanter.config.json`
 * `workflows` entry is flagged. One workflow per call.
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
