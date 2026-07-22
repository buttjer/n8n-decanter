import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { unifiedDiff } from "./diff.mts";
import { getWorkflowDetails, type McpClient } from "./mcp.mts";
import { findWorkflowDir, readState } from "./state.mts";
import { style } from "./style.mts";
import type { Log, Workflow } from "./types.mts";
import { isJsCodeNode, publicationState, publishedVersionLagsDraft, sha256, splitMarker, workflowStructureHash } from "./util.mts";

/** The comparable local body: file content for .js, the compiled JS for .ts. */
async function localBody(dir: string, file: string, log?: Log): Promise<string | null> {
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) return null;
  if (file.endsWith(".ts")) return compileTs(filePath, log);
  return readFileSync(filePath, "utf8");
}

export interface StatusResult {
  /**
   * True when a pull is needed or a push would clobber remote CODE changes
   * (CONFLICT, remote code edits, deleted/unknown code nodes, not pulled
   * yet). Local-only "push pending" changes do NOT count — that's a normal
   * dev state. Structure changes do NOT count either (Plan 32: structure is
   * n8n's job; a stale snapshot is an info line, not drift). The CLI exits 1
   * on it (plans/10 decision, 2026-07-18; narrowed to code by plans/32).
   */
  remoteDrift: boolean;
}

export async function statusWorkflow(mcp: McpClient, root: string, id: string, log: Log, { diff = false }: { diff?: boolean } = {}): Promise<StatusResult> {
  const remote = await getWorkflowDetails(mcp, id);
  const dir = findWorkflowDir(root, id, log);
  if (!dir) {
    log.warn(`${remote.name} (${id}): not pulled yet`);
    return { remoteDrift: true };
  }
  let remoteDrift = false;
  const drift = (): void => {
    remoteDrift = true;
  };
  const state = readState(dir)!;
  const pub = publicationState(remote);
  // Version-aware note: on a published workflow whose live version lags the
  // draft (edits not yet published), say so; otherwise the plain state word,
  // or nothing when the server omits `active` (defensive, mirrors publicationState).
  const pubNote = publishedVersionLagsDraft(remote)
    ? `  published — live version is older than the draft ("publish" to go live)`
    : pub ? `  ${pub}` : "";
  log.info(`${remote.name} (${id})  [${path.relative(process.cwd(), dir)}]${pubNote}`);

  // Structure is n8n's job (Plan 32) — the snapshot comparison is purely
  // informational: a stale workflow.json only means "pull to refresh the file".
  const wfFile = path.join(dir, "workflow.json");
  if (existsSync(wfFile)) {
    try {
      const localStruct = workflowStructureHash(JSON.parse(readFileSync(wfFile, "utf8")) as Workflow);
      if (localStruct !== workflowStructureHash(remote)) {
        log.info("  structure snapshot out of date — pull to refresh workflow.json (structure is managed in n8n)");
      }
    } catch {
      log.warn("  workflow.json unreadable — pull to rewrite the snapshot");
    }
  }

  for (const node of remote.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id];
    const label = `  ${node.name}`;
    if (!nodeState) {
      log.warn(`${label}: remote code node unknown locally — pull`);
      drift();
      continue;
    }
    const remoteBody = splitMarker(node.parameters.jsCode).body;
    const remoteHash = sha256(remoteBody);
    const body = await localBody(dir, nodeState.file, log);
    const local = body === null ? null : sha256(body);
    // --diff: the same bodies the hashes compare — for .ts that is the
    // compiled JS, which is what push would put on the remote
    const printDiff = (): void => {
      if (!diff || body === null) return;
      log.info(`    ${style.dim("--- remote (n8n)")}`);
      log.info(`    ${style.dim(`+++ local (${nodeState.file})`)}`);
      for (const line of unifiedDiff(remoteBody, body)) {
        const styled = line.startsWith("+") ? style.green(line) : line.startsWith("-") ? style.red(line) : style.dim(line);
        log.info(`    ${styled}`);
      }
    };
    const last = nodeState.lastPushedHash;
    if (local === null) log.warn(`${label}: local file ${nodeState.file} missing`);
    else if (local === remoteHash) log.ok(`${label}: in sync (${nodeState.file})`);
    else if (remoteHash === last) {
      log.info(`${label}: local changes in ${nodeState.file} — push pending`);
      printDiff();
    } else if (local === last) {
      log.warn(`${label}: changed remotely — pull`);
      drift();
      printDiff();
    } else {
      log.error(`${label}: CONFLICT — changed both locally and remotely`);
      drift();
      printDiff();
    }
  }
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (!remote.nodes.some((n) => n.id === nodeId)) {
      log.warn(`  ${nodeState.file}: node ${nodeId} deleted remotely`);
      drift();
    }
  }
  return { remoteDrift };
}
