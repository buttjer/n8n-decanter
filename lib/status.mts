// Code-sync facts: the per-node parity/drift ladder, the structure-snapshot
// freshness, and the deleted-remotely set — computed once, rendered by whoever
// asked. Plan 59 retired the `status` verb; its two halves now live apart, and
// both read this module: `preflight` scores these facts (the summary half) and
// `diff` (lib/diff.mts) renders the changed lines. Nothing here logs or exits.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { readState } from "./state.mts";
import type { Log, Workflow } from "./types.mts";
import { isJsCodeNode, sha256, splitMarker, workflowStructureHash } from "./util.mts";

/** The comparable local body: file content for .js, the compiled JS for .ts. */
async function localBody(dir: string, file: string, log?: Log): Promise<string | null> {
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) return null;
  if (file.endsWith(".ts")) return compileTs(filePath, log);
  return readFileSync(filePath, "utf8");
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
  /**
   * `compileTs` warnings raised while building this node's local body (`.ts`
   * lazy-wrapped modules / oversized bundles). Captured, not printed, so the
   * fact computation is silent; `diffWorkflow` replays them per node, right
   * before the node they were raised for.
   */
  warnings?: string[];
}

/** A local state node whose id no longer exists on the remote. */
export interface DeletedNode {
  id: string;
  file: string;
}

/** Structure-snapshot freshness (informational — never drift; Plan 32). */
export type SnapshotState = "current" | "stale" | "unreadable" | "absent";

/** The structured sync facts `diff` renders and `preflight` scores. */
export interface SyncFacts {
  /** Per-node code-sync verdicts, in remote node order. */
  nodes: NodeSync[];
  /** Local state nodes deleted on the remote, in state order. */
  deleted: DeletedNode[];
  snapshot: SnapshotState;
}

/**
 * Compute — WITHOUT logging — every code-sync fact for a pulled workflow: the
 * per-node parity/drift ladder, the structure-snapshot freshness, and the
 * deleted-remotely set. Both `diffWorkflow` (which renders the changed lines)
 * and `preflight` (which scores them) consume this, so the two can't drift.
 * Caller supplies the already-fetched `remote` — no second MCP read. Silent by
 * construction: per-node `compileTs` warnings are captured onto
 * {@link NodeSync.warnings}, not printed, so the caller decides whether to
 * surface them (`diffWorkflow` replays them; `preflight` ignores them).
 *
 * Plan 59 dropped the old `remoteDrift` aggregate: it existed only to give the
 * `status` verb its exit code, and `preflight` derives its `drift` verdict from
 * the per-node states directly.
 */
export async function computeSyncFacts(remote: Workflow, dir: string): Promise<SyncFacts> {
  const state = readState(dir)!;
  const nodes: NodeSync[] = [];
  const deleted: DeletedNode[] = [];

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
      continue;
    }
    const remoteBody = splitMarker(node.parameters.jsCode).body;
    const remoteHash = sha256(remoteBody);
    // Capture compileTs warnings instead of printing them, so the fact
    // computation is silent; diffWorkflow replays them per node (preserving
    // the pre-extraction order), preflight drops them.
    const warnings: string[] = [];
    const capture: Log = { info() {}, ok() {}, warn: (m) => warnings.push(m), error() {} };
    const body = await localBody(dir, nodeState.file, capture);
    const local = body === null ? null : sha256(body);
    const last = nodeState.lastPushedHash;
    let s: NodeSyncState;
    if (local === null) s = "local-missing";
    else if (local === remoteHash) s = "in-sync";
    else if (remoteHash === last) s = "push-pending";
    else if (local === last) s = "changed-remotely";
    else s = "conflict";
    nodes.push({ id: node.id, name: node.name, file: nodeState.file, state: s, remoteBody, localBody: body, warnings: warnings.length > 0 ? warnings : undefined });
  }

  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (!remote.nodes.some((n) => n.id === nodeId)) {
      deleted.push({ id: nodeId, file: nodeState.file });
    }
  }

  return { nodes, deleted, snapshot };
}
