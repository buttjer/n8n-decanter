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

/** Per-node code-sync verdict — the parity/drift ladder, computed as a fact. */
export type NodeSyncState =
  /** local build == draft body. */
  | "in-sync"
  /** local edited, remote still at last sync — a normal pre-push state (NOT drift). */
  | "push-pending"
  /** remote moved off last sync, local still at it — pull needed (drift). */
  | "changed-remotely"
  /** both local and remote moved off last sync — a real conflict (drift). */
  | "conflict"
  /** the tracked local file is gone. */
  | "local-missing"
  /** a remote JS Code node with no local state entry — pull (drift). */
  | "unknown-locally";

export interface NodeSync {
  id: string;
  name: string;
  /** Tracked file path (`code/…`); absent for an `unknown-locally` node. */
  file?: string;
  state: NodeSyncState;
  /** The draft body and local build, kept for `--diff` rendering. */
  remoteBody?: string;
  localBody?: string | null;
}

/** A local state node whose id no longer exists on the remote. */
export interface DeletedNode {
  id: string;
  file: string;
}

/** Structure-snapshot freshness (informational — never drift; Plan 32). */
export type SnapshotState = "current" | "stale" | "unreadable" | "absent";

/** The structured sync facts `status` prints and `preflight` scores. */
export interface SyncFacts {
  /** Per-node code-sync verdicts, in remote node order. */
  nodes: NodeSync[];
  /** Local state nodes deleted on the remote, in state order. */
  deleted: DeletedNode[];
  snapshot: SnapshotState;
  /** See {@link StatusResult.remoteDrift} — the same aggregate the CLI exits 1 on. */
  remoteDrift: boolean;
}

/**
 * Compute — WITHOUT logging — every code-sync fact for a pulled workflow: the
 * per-node parity/drift ladder, the structure-snapshot freshness, and the
 * deleted-remotely set. Both `statusWorkflow` (which renders these to the log)
 * and `preflight` (which scores them) consume this, so the two can't drift.
 * Caller supplies the already-fetched `remote` — no second MCP read.
 */
export async function computeSyncFacts(remote: Workflow, dir: string, log?: Log): Promise<SyncFacts> {
  const state = readState(dir)!;
  const nodes: NodeSync[] = [];
  const deleted: DeletedNode[] = [];
  let remoteDrift = false;

  // Structure is n8n's job (Plan 32): a stale snapshot only means "pull to
  // refresh workflow.json" — informational, never drift.
  let snapshot: SnapshotState = "absent";
  const wfFile = path.join(dir, "workflow.json");
  if (existsSync(wfFile)) {
    try {
      const localStruct = workflowStructureHash(JSON.parse(readFileSync(wfFile, "utf8")) as Workflow);
      snapshot = localStruct !== workflowStructureHash(remote) ? "stale" : "current";
    } catch {
      snapshot = "unreadable";
    }
  }

  for (const node of remote.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id];
    if (!nodeState) {
      nodes.push({ id: node.id, name: node.name, state: "unknown-locally" });
      remoteDrift = true;
      continue;
    }
    const remoteBody = splitMarker(node.parameters.jsCode).body;
    const remoteHash = sha256(remoteBody);
    const body = await localBody(dir, nodeState.file, log);
    const local = body === null ? null : sha256(body);
    const last = nodeState.lastPushedHash;
    let s: NodeSyncState;
    if (local === null) s = "local-missing";
    else if (local === remoteHash) s = "in-sync";
    else if (remoteHash === last) s = "push-pending";
    else if (local === last) {
      s = "changed-remotely";
      remoteDrift = true;
    } else {
      s = "conflict";
      remoteDrift = true;
    }
    nodes.push({ id: node.id, name: node.name, file: nodeState.file, state: s, remoteBody, localBody: body });
  }

  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (!remote.nodes.some((n) => n.id === nodeId)) {
      deleted.push({ id: nodeId, file: nodeState.file });
      remoteDrift = true;
    }
  }

  return { nodes, deleted, snapshot, remoteDrift };
}

export async function statusWorkflow(mcp: McpClient, root: string, id: string, log: Log, { diff = false }: { diff?: boolean } = {}): Promise<StatusResult> {
  const remote = await getWorkflowDetails(mcp, id);
  const dir = findWorkflowDir(root, id, log);
  if (!dir) {
    log.warn(`${remote.name} (${id}): not pulled yet`);
    return { remoteDrift: true };
  }
  const pub = publicationState(remote);
  // Version-aware note: on a published workflow whose live version lags the
  // draft (edits not yet published), say so; otherwise the plain state word,
  // or nothing when the server omits `active` (defensive, mirrors publicationState).
  const pubNote = publishedVersionLagsDraft(remote)
    ? `  published — live version is older than the draft ("publish" to go live)`
    : pub ? `  ${pub}` : "";
  log.info(`${remote.name} (${id})  [${path.relative(process.cwd(), dir)}]${pubNote}`);

  const facts = await computeSyncFacts(remote, dir, log);

  if (facts.snapshot === "stale") {
    log.info("  structure snapshot out of date — pull to refresh workflow.json (structure is managed in n8n)");
  } else if (facts.snapshot === "unreadable") {
    log.warn("  workflow.json unreadable — pull to rewrite the snapshot");
  }

  for (const node of facts.nodes) {
    const label = `  ${node.name}`;
    // --diff: the same bodies the hashes compare — for .ts that is the
    // compiled JS, which is what push would put on the remote
    const printDiff = (): void => {
      if (!diff || node.remoteBody === undefined || node.localBody === undefined || node.localBody === null || node.file === undefined) return;
      log.info(`    ${style.dim("--- remote (n8n)")}`);
      log.info(`    ${style.dim(`+++ local (${node.file})`)}`);
      for (const line of unifiedDiff(node.remoteBody, node.localBody)) {
        const styled = line.startsWith("+") ? style.green(line) : line.startsWith("-") ? style.red(line) : style.dim(line);
        log.info(`    ${styled}`);
      }
    };
    switch (node.state) {
      case "unknown-locally":
        log.warn(`${label}: remote code node unknown locally — pull`);
        break;
      case "local-missing":
        log.warn(`${label}: local file ${node.file} missing`);
        break;
      case "in-sync":
        log.ok(`${label}: in sync (${node.file})`);
        break;
      case "push-pending":
        log.info(`${label}: local changes in ${node.file} — push pending`);
        printDiff();
        break;
      case "changed-remotely":
        log.warn(`${label}: changed remotely — pull`);
        printDiff();
        break;
      case "conflict":
        log.error(`${label}: CONFLICT — changed both locally and remotely`);
        printDiff();
        break;
    }
  }

  for (const node of facts.deleted) {
    log.warn(`  ${node.file}: node ${node.id} deleted remotely`);
  }

  return { remoteDrift: facts.remoteDrift };
}
