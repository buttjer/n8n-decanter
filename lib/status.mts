import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { N8nApi } from "./api.mts";
import { compileTs } from "./compile.mts";
import { unifiedDiff } from "./diff.mts";
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
   * True when a pull is needed or a push would clobber remote changes
   * (CONFLICT, remote edits, unknown/deleted remote nodes, not pulled yet).
   * Local-only "push pending" changes do NOT count — that's a normal dev
   * state. The CLI exits 1 on it (plans/10 decision, 2026-07-18).
   */
  remoteDrift: boolean;
}

export async function statusWorkflow(api: N8nApi, root: string, id: string, log: Log, { diff = false }: { diff?: boolean } = {}): Promise<StatusResult> {
  const remote = await api.getWorkflow(id);
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
  // draft (a UI edit not yet published), say so; otherwise the plain state word,
  // or nothing when the server omits `active` (defensive, mirrors publicationState).
  const pubNote = publishedVersionLagsDraft(remote)
    ? `  published — live version is older than the draft (push or "publish" to go live)`
    : pub ? `  ${pub}` : "";
  log.info(`${remote.name} (${id})  [${path.relative(process.cwd(), dir)}]${pubNote}`);

  const remoteStruct = workflowStructureHash(remote);
  const wfFile = path.join(dir, "workflow.json");
  const localStruct = existsSync(wfFile)
    ? workflowStructureHash(JSON.parse(readFileSync(wfFile, "utf8")) as Workflow)
    : null;
  const base = state.lastPulledWorkflowHash;
  if (remoteStruct !== base && localStruct !== base) {
    log.warn("  structure: changed both locally and remotely");
    drift();
  } else if (remoteStruct !== base) {
    log.warn("  structure: changed remotely — pull");
    drift();
  } else if (localStruct !== base) log.info("  structure: changed locally — push pending");
  else log.ok("  structure: in sync");

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
