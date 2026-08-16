import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileTs } from "./compile.mts";
import { type CommitResult, commitWorkflowDir } from "./git.mts";
import { getWorkflowDetails, type McpClient } from "./mcp.mts";
import { findWorkflowDir, readState, reconcileFileMapFromSnapshot, renameNodeFilePair, writeState } from "./state.mts";
import type { DecanterState, Log, NodeState, Workflow, WorkflowNode } from "./types.mts";
import {
  CODE_DIR,
  FILE_PLACEHOLDER_PREFIX,
  isJsCodeNode,
  kebabCase,
  sha256,
  splitMarker,
  stableWorkflowJson,
} from "./util.mts";

function writeIfChanged(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  writeFileSync(file, content);
  return true;
}

/**
 * Locate/create the workflow folder (Plan 27). Folders are a stable local pick:
 * an **existing** folder for this id is kept as-is (never renamed to follow a
 * remote workflow rename — the display name lives in `.decanter.json.name`). A
 * **new** folder gets a kebab-case slug; if that slug is already taken by a
 * different workflow, fall back to `<slug>-<id8>` (the node-file collision
 * strategy) and warn.
 */
function ensureWorkflowDir(root: string, wf: Workflow, log: Log): { dir: string } {
  const existing = findWorkflowDir(root, wf.id, log);
  if (existing) return { dir: existing };
  const wanted = kebabCase(wf.name);
  let slug = wanted;
  if (existsSync(path.join(root, slug))) {
    slug = `${wanted}-${wf.id.slice(0, 8)}`;
    log.warn(`folder "${wanted}/" already taken — using "${slug}/" for "${wf.name}" (${wf.id})`);
  }
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  return { dir };
}

/**
 * Pick/refresh the file name for a node: kebab-case under code/, renaming
 * existing files on node rename. This is the node-identity layer (Plan 32
 * Task 3): the map is keyed on the node *id*, which survives MCP/UI renames,
 * so a structure-side rename only moves the local file — content and history
 * stay attached. Collision handling is per-pull (`usedNames`), deterministic
 * across nodes that kebab to the same base.
 */
function resolveNodeFile(dir: string, nodeState: Partial<NodeState>, node: WorkflowNode, ext: string, usedNames: Set<string>, log: Log): { file: string; base: string } {
  let base = kebabCase(node.name);
  if (usedNames.has(base)) base = `${base}-${node.id.slice(0, 8)}`;
  usedNames.add(base);
  const wanted = `${CODE_DIR}/${base}${ext}`;
  mkdirSync(path.join(dir, CODE_DIR), { recursive: true });
  const current = nodeState.file;
  if (current && current !== wanted) renameNodeFilePair(dir, current, base, ext, log);
  return { file: wanted, base };
}

/**
 * Pull one workflow over MCP (Plan 32): read the tip via `get_workflow_details`
 * (the editor view — the draft when one exists, else the published content),
 * extract each Code node's `jsCode` into `code/`, and refresh the read-only
 * `workflow.json` structure snapshot. Code files in git are the source of
 * truth for Code-node source: `.js` files are overwritten with the remote body
 * (git is the safety net — a warning flags overwritten unpushed edits), `.ts`
 * sources are never touched (divergence is warned, inspect with
 * the `diff` verb; no `.remote.js` artifacts since Plan 32).
 */
export async function pullWorkflow(mcp: McpClient, root: string, id: string, { commitOnPull = false }: { commitOnPull?: boolean } = {}, log: Log): Promise<{ dir: string; name: string; clobbered: string[] }> {
  /** Node files whose unpushed local edits this pull overwrote (Plan 68). */
  const clobbered: string[] = [];
  const wf = await getWorkflowDetails(mcp, id);
  const { dir } = ensureWorkflowDir(root, wf, log);
  const state: DecanterState = readState(dir) ?? { workflowId: wf.id, nodes: {} };
  state.workflowId = wf.id;
  state.name = wf.name; // cached display name (Plan 27) — folder stays a stable slug
  state.nodes ??= {};
  // structural hashing died with Plan 32 — scrub the legacy field on rewrite
  delete (state as unknown as Record<string, unknown>).lastPulledWorkflowHash;
  // Honor a re-pointed //@file: placeholder (e.g. an `.js`→`.ts` conversion the
  // agent just made) before deriving files from node names — otherwise this
  // pull would treat the stale `.js` map entry as authoritative and rewrite the
  // placeholder back to `.js` (Plan 35 field-test finding). Same reconcile push
  // runs, so the two stay symmetric.
  reconcileFileMapFromSnapshot(dir, state);

  // Snapshot BEFORE the write loop (Plan 63 task 1). Pull overwrites plain `.js`
  // files and `workflow.json` with the remote unconditionally, and its own
  // commit used to run *after* that — so an uncommitted local edit was destroyed
  // and never entered git, while the warning printed on that very path told the
  // user to "recover via git". `watch` and the live mirror already commit first
  // and say why; this verb was the odd one out, and it is the one users run.
  //
  // A failed snapshot does NOT abort the pull (a folder outside git must still
  // be pullable) — it downgrades the recovery claim below to the truth.
  const snapshot: CommitResult | "skipped" = commitOnPull
    ? await commitWorkflowDir(dir, `decanter: snapshot before pull (${id})`, log)
    : "skipped";
  const recoverable = snapshot === "committed" || snapshot === "clean";

  const usedNames = new Set<string>();
  const placeholders = new Map<string, string>(); // node id -> file name

  for (const node of wf.nodes) {
    if (!isJsCodeNode(node)) continue;
    const nodeState: Partial<NodeState> = state.nodes[node.id] ?? {};
    const remote = node.parameters.jsCode;
    const { body: remoteBody, markerHash } = splitMarker(remote);
    const remoteHash = sha256(remoteBody);
    const tsManaged = markerHash !== null;

    const { file, base } = resolveNodeFile(dir, nodeState, node, tsManaged ? ".ts" : ".js", usedNames, log);
    const filePath = path.join(dir, file);

    if (tsManaged) {
      if (!existsSync(filePath)) {
        log.warn(`${wf.name} / ${node.name}: TS-managed on remote but no local ${file} — pull cannot reconstruct .ts source; add the file (its compiled code stays on the n8n draft, see \`n8n-decanter diff\`) before pushing`);
      } else {
        const compiled = await compileTs(filePath, log);
        const localHash = sha256(compiled);
        if (localHash === remoteHash) {
          // in sync — nothing to do
        } else if (localHash === nodeState.lastPushedHash) {
          log.warn(`${wf.name} / ${node.name}: edited in the n8n UI since last push — remote edits are not merged into ${file} (inspect with \`n8n-decanter diff\`, port manually); the next push overwrites them`);
          // Same relaxation as push's `codeDrift` and the read-side ladder in
          // lib/status.mts: with no baseline, nothing is KNOWN to have moved
          // remotely, so calling it a conflict invents a remote edit.
        } else if (nodeState.lastPushedHash === undefined || remoteHash === nodeState.lastPushedHash) {
          log.info(`${node.name}: local ${file} modified, not yet pushed`);
        } else {
          log.warn(`${wf.name} / ${node.name}: CONFLICT — both ${file} and the remote code changed since last sync; inspect with \`n8n-decanter diff\` and reconcile before pushing`);
        }
      }
    } else if (nodeState.file?.endsWith(".ts") || existsSync(path.join(dir, CODE_DIR, base + ".ts"))) {
      // Local .ts exists but remote carries no marker: never clobber TS source
      // and don't drop a competing .js next to it. Pick the actual `.ts` path —
      // a `nodeState.file` still ending in `.js` is a not-yet-reconciled
      // pre-conversion entry, so fall to the detected `<base>.ts` instead of
      // parroting the deleted `.js` (Plan 35 field-test finding).
      const tsFile = nodeState.file?.endsWith(".ts") ? nodeState.file : `${CODE_DIR}/${base}.ts`;
      log.warn(`${wf.name} / ${node.name}: local ${tsFile} exists but remote code has no @ts-n8n marker (not pushed from TS yet?) — keeping your .ts; the next push overwrites the remote code`);
      placeholders.set(node.id, tsFile);
      state.nodes[node.id] = { ...nodeState, file: tsFile, lastPushedHash: remoteHash, name: node.name };
      continue;
    } else {
      if (existsSync(filePath)) {
        const localHash = sha256(readFileSync(filePath, "utf8"));
        // No `lastPushedHash` gate (Plan 63 task 2). That conjunct was borrowed
        // from push's "an undefined baseline never drifts" relaxation, and on
        // the READ side it is backwards: no baseline means the node is not in
        // `.decanter.json` yet, so the local file is precisely the one with no
        // protection. Concrete loss path, and it matches the scaffolded agent
        // workflow: an agent adds a Code node over the guard (the guard blocks
        // `jsCode`, so the remote body is empty), writes the source into
        // `code/<node>.js`, and a debounced mirror pull fires before the first
        // push — no state entry, no warning, empty remote body wins.
        if (localHash !== remoteHash && localHash !== nodeState.lastPushedHash) {
          // Also RETURNED, not only logged (Plan 68): when the caller is the
          // background live mirror, this warning goes to a stderr-only logger
          // the agent structurally cannot read, so the overwrite it describes
          // was invisible to the one party able to react to it.
          clobbered.push(file);
          log.warn(
            `${wf.name} / ${node.name}: overwriting unpushed local changes in ${file} with the remote code` +
              (recoverable ? " (recover via git — snapshotted just now)" : " — NOT recoverable: no pre-pull snapshot was committed"),
          );
        }
      }
      if (writeIfChanged(filePath, remoteBody)) log.info(`wrote ${path.basename(dir)}/${file}`);
    }

    placeholders.set(node.id, file);
    state.nodes[node.id] = { ...nodeState, file, lastPushedHash: remoteHash, name: node.name };
  }

  // Drop state for nodes that no longer exist remotely (files stay; git is the safety net).
  const liveIds = new Set(wf.nodes.map((n) => n.id));
  for (const nodeId of Object.keys(state.nodes)) {
    if (!liveIds.has(nodeId)) {
      log.warn(`node ${nodeId} ("${state.nodes[nodeId].file}") no longer exists remotely — removing from state, delete the file manually if unwanted`);
      delete state.nodes[nodeId];
    }
  }

  // workflow.json is a READ-ONLY structure snapshot (Plan 32): written for
  // review diffs and the offline tooling (simulate, node run, refs, guards),
  // never pushed — structure is n8n's job now. Derived/permission fields are
  // dropped: `activeVersion` would duplicate every node's source in git,
  // `activeVersionId` churns on each publish, `shared`/`scopes`/`canExecute`
  // are viewer-relative MCP noise. The draft `versionId` is kept — the
  // executions stale-capture warning compares against it.
  const wfOut = structuredClone(wf);
  delete wfOut.activeVersion;
  delete wfOut.activeVersionId;
  delete wfOut.shared;
  delete wfOut.scopes;
  delete wfOut.canExecute;
  for (const node of wfOut.nodes) {
    const file = placeholders.get(node.id);
    if (file) node.parameters.jsCode = FILE_PLACEHOLDER_PREFIX + file;
  }
  if (writeIfChanged(path.join(dir, "workflow.json"), stableWorkflowJson(wfOut))) {
    log.info(`wrote ${path.basename(dir)}/workflow.json`);
  }

  writeState(dir, state);
  if (commitOnPull) {
    await commitWorkflowDir(dir, `decanter: pulled "${wf.name}" (${id})`, log);
  }
  return { dir, name: wf.name, clobbered };
}
