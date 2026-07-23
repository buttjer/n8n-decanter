import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { commitWorkflowDir } from "./git.mts";
import { getWorkflowDetails, type McpClient, publishWorkflowMcp, updateWorkflow, type McpOperation } from "./mcp.mts";
import { findWorkflowDir, readState, reconcileFileMapFromSnapshot, writeState } from "./state.mts";
import type { DecanterState, Log, Workflow } from "./types.mts";
import { isJsCodeNode, publicationState, sha256, splitMarker, withMarker } from "./util.mts";
import { validateNodeFile, validateWorkflowDir, type ValidationResult } from "./validate.mts";

/** Layout-compliance gate: warnings pass through, errors abort the push. */
export function assertCompliant({ errors, warnings }: ValidationResult, log: Log, what: string): void {
  for (const w of warnings) log.warn(w);
  if (errors.length === 0) return;
  for (const e of errors) log.error(e);
  throw new Error(`${what} does not comply with the decanter layout (${errors.length} problem${errors.length === 1 ? "" : "s"}) — fix the issues above, see also: n8n-decanter check`);
}

/** Turn a node source file into the jsCode payload (+ hash of the marker-less body). */
export async function buildNodeCode(dir: string, file: string, log?: Log): Promise<{ jsCode: string; hash: string }> {
  const filePath = path.join(dir, file);
  if (!existsSync(filePath)) throw new Error(`referenced node file missing: ${filePath}`);
  if (file.endsWith(".ts")) {
    return withMarker(await compileTs(filePath, log));
  }
  const jsCode = readFileSync(filePath, "utf8");
  return { jsCode, hash: sha256(jsCode) };
}

/**
 * Per-node code drift (Plan 32: the only drift guard left — structure is
 * n8n's job now). A node drifts when the remote body moved off the last-sync
 * hash AND differs from what we are about to write. Two deliberate
 * relaxations (Plan 33 decision — documented, not restored): an *undefined*
 * `lastPushedHash` never drifts (no baseline exists — a first sync for that
 * node has nothing to protect), and a remote edit that happens to match the
 * local code just re-baselines silently (blocking a byte-identical write
 * would only manufacture a conflict).
 */
function codeDrift(remoteHash: string, localHash: string, lastPushedHash: string | undefined): boolean {
  return lastPushedHash !== undefined && remoteHash !== lastPushedHash && remoteHash !== localHash;
}

function assertNoDrift(problems: string[], force: boolean, log: Log): void {
  if (problems.length === 0) return;
  for (const p of problems) log[force ? "warn" : "error"](p);
  if (!force) {
    throw new Error("remote code changed since last sync — pull first (or repeat with --force to overwrite the draft)");
  }
  log.warn("--force: overwriting remote code changes");
}

/**
 * Publication suffix for push result lines. MCP writes land on the DRAFT
 * only — the API-era "pushes to a published workflow auto-publish" behavior
 * is gone; `publish` is always the deliberate go-live step.
 */
function draftNote(wf: Workflow | undefined): string {
  const state = publicationState(wf);
  if (!state) return " — draft updated";
  return state === "published"
    ? ' — draft updated; the live version is unchanged (run "publish" to go live)'
    : " — unpublished draft";
}

/** Update per-node hashes + cached names from a post-write confirming read. */
function recordSync(state: DecanterState, confirmed: Workflow): void {
  state.name = confirmed.name;
  for (const node of confirmed.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState = state.nodes[node.id];
    if (nodeState) {
      nodeState.lastPushedHash = sha256(splitMarker(node.parameters.jsCode).body);
      nodeState.name = node.name;
    }
  }
}

/**
 * Build the `updateNodeParameters` ops for every tracked node whose local code
 * differs from the remote body. Nodes are matched by ID against the fresh
 * remote read and addressed by their CURRENT remote name (Plan 32 Task 3) —
 * a structure-side rename between syncs changes nothing.
 */
async function collectOps(
  dir: string,
  state: DecanterState,
  remote: Workflow,
  onlyNodeIds: Set<string> | null,
  log: Log,
): Promise<{ ops: McpOperation[]; problems: string[] }> {
  const byId = new Map(remote.nodes.map((n) => [n.id, n]));
  const ops: McpOperation[] = [];
  const problems: string[] = [];
  for (const [nodeId, ns] of Object.entries(state.nodes)) {
    if (onlyNodeIds && !onlyNodeIds.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node) {
      log.warn(`node "${ns.name ?? nodeId}" (${ns.file}) no longer exists remotely — skipped; pull to clean up state`);
      continue;
    }
    if (!isJsCodeNode(node)) {
      log.warn(`node "${node.name}" (${ns.file}) is no longer a JS Code node remotely — skipped; pull to clean up state`);
      continue;
    }
    const { jsCode, hash } = await buildNodeCode(dir, ns.file, log);
    const remoteSplit = splitMarker(node.parameters.jsCode);
    const remoteHash = sha256(remoteSplit.body);
    if (codeDrift(remoteHash, hash, ns.lastPushedHash)) {
      problems.push(`node "${node.name}": remote code changed since last sync`);
    }
    // A body-equal write is still needed when the marker state disagrees with
    // the file kind (Plan 33): a freshly converted .ts node whose marker
    // hasn't landed yet pushes to REGISTER TS management, and a node
    // re-pointed back to .js whose remote still carries a marker pushes to
    // CLEAR it (otherwise the next pull would resurrect the node as .ts).
    const missingMarker = ns.file.endsWith(".ts") && remoteSplit.markerHash === null;
    const strayMarker = ns.file.endsWith(".js") && remoteSplit.markerHash !== null;
    if (hash === remoteHash && !missingMarker && !strayMarker) continue; // already in sync — no write needed
    ops.push({ type: "updateNodeParameters", nodeName: node.name, parameters: { jsCode } });
  }
  if (!onlyNodeIds) {
    for (const node of remote.nodes) {
      if (isJsCodeNode(node) && state.nodes[node.id] === undefined) {
        log.info(`remote Code node "${node.name}" isn't tracked locally — pull to extract it`);
      }
    }
  }
  return { ops, problems };
}

/**
 * Push a workflow's Code-node sources over MCP (Plan 32): one atomic
 * `update_workflow` batch of `{jsCode}`-only `updateNodeParameters` ops
 * (merge semantics — sibling params like `mode`/`language` survive). The
 * write lands on the DRAFT; `publish: true` (--publish) takes it live
 * afterwards. Sync hashes are recorded from a post-write confirming read
 * (`update_workflow` returns a summary, never the workflow).
 */
export async function pushWorkflow(
  mcp: McpClient,
  root: string,
  id: string,
  { force = false, commitOnPush = false, publish = false }: { force?: boolean; commitOnPush?: boolean; publish?: boolean } = {},
  log: Log,
): Promise<{ dir: string; name: string }> {
  const dir = findWorkflowDir(root, id, log);
  if (!dir) throw new Error(`workflow ${id} not found under ${root} — pull it first`);
  assertCompliant(validateWorkflowDir(dir), log, `"${path.basename(dir)}"`);
  const state = readState(dir)!;

  // The snapshot's //@file: placeholders stay the human-visible file map:
  // re-pointing one (e.g. .js → .ts conversion) updates the id-keyed state
  // here, exactly as the API-era push did. Pull runs the same reconcile so a
  // background live-mirror pull can't revert the conversion (Plan 35 finding).
  reconcileFileMapFromSnapshot(dir, state);

  const remote = await getWorkflowDetails(mcp, id);
  const { ops, problems } = await collectOps(dir, state, remote, null, log);
  assertNoDrift(problems, force, log);

  let confirmed = remote;
  if (ops.length > 0) {
    await updateWorkflow(mcp, id, ops);
    confirmed = await getWorkflowDetails(mcp, id);
    verifyRoundTrip(dir, state, confirmed, log);
  }
  recordSync(state, confirmed);
  writeState(dir, state);
  if (ops.length === 0) {
    log.ok(`"${remote.name}" (${id}): code already in sync — nothing to push`);
  } else {
    log.ok(`pushed "${confirmed.name}" (${id}) — ${ops.length} node${ops.length === 1 ? "" : "s"}${draftNote(confirmed)}`);
  }
  if (publish) {
    await publishWorkflowMcp(mcp, id);
    log.ok(`published "${confirmed.name}" (${id}) — code is live now`);
  }
  if (commitOnPush) await commitWorkflowDir(dir, `decanter: pushed "${confirmed.name}" (${id})`, log);
  return { dir, name: confirmed.name };
}

/** The invariant check: after a push, the remote body must equal the local build byte-exactly. */
function verifyRoundTrip(dir: string, state: DecanterState, confirmed: Workflow, log: Log): void {
  for (const node of confirmed.nodes) {
    if (!isJsCodeNode(node)) continue;
    const ns = state.nodes[node.id];
    if (!ns) continue;
    // compare hashes only — the local build was just computed in collectOps,
    // but cheap re-hash keeps this function self-contained and read-only
    const localFile = path.join(dir, ns.file);
    if (!existsSync(localFile)) continue;
    const { body: remoteBody, markerHash } = splitMarker(node.parameters.jsCode);
    if (ns.file.endsWith(".ts")) {
      // .ts: the pushed marker carries the compiled body's hash — a mismatch
      // means the server normalized the code after the write (recompiling
      // here would be the expensive way to say the same thing)
      if (markerHash !== null && sha256(remoteBody) !== markerHash) {
        log.warn(`node "${node.name}": remote code does not match its @ts-n8n marker hash after push — the server normalized it? inspect with status --diff`);
      }
      continue;
    }
    if (sha256(readFileSync(localFile, "utf8")) !== sha256(remoteBody)) {
      log.warn(`node "${node.name}": remote code does not match ${ns.file} byte-exactly after push — the server normalized it? inspect with status --diff`);
    }
  }
}

/** Push a single node's code over MCP (watch mode): one-op atomic batch. */
export async function pushSingleNode(
  mcp: McpClient,
  dir: string,
  nodeId: string,
  { force = false, commitOnPush = false }: { force?: boolean; commitOnPush?: boolean } = {},
  log: Log,
): Promise<void> {
  const state = readState(dir);
  if (!state) throw new Error(`missing .decanter.json in ${dir} — pull first`);
  const nodeState = state.nodes[nodeId];
  if (!nodeState) throw new Error(`node ${nodeId} has no entry in ${dir}/.decanter.json — pull first`);
  assertCompliant(validateNodeFile(dir, nodeState.file), log, nodeState.file);

  const remote = await getWorkflowDetails(mcp, state.workflowId);
  const node = remote.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`node ${nodeId} no longer exists in remote workflow ${state.workflowId}`);
  const { ops, problems } = await collectOps(dir, state, remote, new Set([nodeId]), log);
  assertNoDrift(problems, force, log);

  let confirmed = remote;
  if (ops.length > 0) {
    await updateWorkflow(mcp, state.workflowId, ops);
    confirmed = await getWorkflowDetails(mcp, state.workflowId);
    // same invariant as a full push — watch saves must not skip it (it also
    // backstops a rename between the read and the name-addressed write)
    verifyRoundTrip(dir, state, confirmed, log);
  }
  recordSync(state, confirmed);
  writeState(dir, state);
  if (ops.length === 0) {
    log.info(`node "${node.name}": already in sync — nothing to push`);
  } else {
    log.ok(`pushed node "${node.name}" -> workflow "${confirmed.name}"${draftNote(confirmed)}`);
  }
  if (commitOnPush) {
    await commitWorkflowDir(dir, `decanter: pushed "${confirmed.name}" / node "${node.name}" (${state.workflowId})`, log);
  }
}
