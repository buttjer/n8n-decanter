// The `test` verb (Plan 33 Task 5): an instance-side pinned-data run over
// MCP `test_workflow` — the recommended runtime check. The instance's real
// engine (instance-exact version, community nodes included) executes the
// DRAFT: trigger/credentialed/HTTP nodes are pinned from a local capture or
// committed mock (the same classification `simulate` uses), logic nodes run
// for real, and each pure node's output is diffed client-side against the
// capture (exit 1 on divergence). `simulate` remains the offline/pre-push/
// CI sibling — see docs/concepts for the taxonomy.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXECUTIONS_DIR } from "./executions.mts";
import { getWorkflowDetails, type McpClient, updateWorkflow } from "./mcp.mts";
import { createPrompt } from "./prompt.mts";
import { buildNodeCode, pushWorkflow } from "./push.mts";
import { readState, writeState } from "./state.mts";
import { diffItems, firstRunItems, isLoopDriver, isPureNode, type NodeDiff, type Provenance, type RunData, type RunItem, readCapture, scenarioIsSynthetic, scenarioProvenance, type SimSource } from "./simulate.mts";
import type { DecanterConfig, Log, Workflow } from "./types.mts";
import { isJsCodeNode, publicationState, sha256, splitMarker } from "./util.mts";

/**
 * Crash-safe pre-test draft snapshot, written before a test-triggered push
 * and kept until the user decides keep/restore. Lives inside the
 * self-gitignored `executions/` dir, so it never lands in git.
 */
const SNAPSHOT_FILE = `${EXECUTIONS_DIR}/.test-snapshot.json`;

interface DraftSnapshot {
  versionId?: string;
  /** node name → byte-exact jsCode at snapshot time. */
  jsCode: Record<string, string>;
}

/** What `test` reports (also emitted verbatim with --json). */
export interface TestReport {
  /** The capture/mock ref the pins came from. */
  source: string;
  /** Instance-side execution id of the test run (null when the run never started). */
  executionId: string | null;
  /** `test_workflow`'s status (success/error/…). */
  status: string;
  error?: string;
  /** Nodes pinned from the capture (trigger + network + credentialed). */
  pinned: string[];
  /**
   * True when the source scenario carries any non-`capture` (authored/scaffolded)
   * pins (Plan 37): the run proves **executability, not output correctness** — no
   * per-node diff is asserted and `ok` reflects only that the instance run succeeded.
   */
  syntheticPins: boolean;
  /** Per-node provenance of the source's pins (`capture`/`authored`/`scaffolded`). */
  provenance: Record<string, Provenance>;
  /** Per-pure-node diffs of the instance run vs the capture (only `capture`-provenance nodes are asserted). */
  diffs: NodeDiff[];
  divergent: string[];
  /** What was tested: the local code (pushed to the draft first) or the draft as-is. */
  tested: "local (pushed to the draft)" | "draft as-is";
  /** True when local code differs from the draft that was tested (non-TTY note). */
  localDiffersFromTested: boolean;
  restored?: boolean;
  /** True when a loop driver ran — the diff covers only each node's first iteration. */
  firstIterationOnly?: boolean;
  ok: boolean;
}

/**
 * Build the pinData map for `test_workflow` from a capture: every non-pure,
 * non-loop-driver, enabled node with captured output gets pinned (the same
 * split `simulate` uses — triggers/network/credentialed nodes must not run
 * for real). Nodes without captured data are GAPS and abort — an unpinned
 * network node would execute against the real world. Exported for tests.
 */
export function buildTestPins(wf: Workflow, runData: RunData, ref: string, source: SimSource): { pinData: Record<string, RunItem[]>; pinned: string[] } {
  const pinData: Record<string, RunItem[]> = {};
  const gaps: string[] = [];
  for (const node of wf.nodes) {
    if (node.disabled === true || isPureNode(node) || isLoopDriver(node)) continue;
    const items = firstRunItems(runData[node.name]);
    if (items === undefined) {
      gaps.push(node.name);
      continue;
    }
    pinData[node.name] = items;
  }
  if (gaps.length > 0) {
    throw new Error(
      `cannot pin ${gaps.map((g) => `"${g}"`).join(", ")} — no captured output in ${source} ${ref}, and an unpinned ` +
        `trigger/network node would run for REAL on the instance. Fill a scenario first: n8n-decanter scenario create <workflow>`,
    );
  }
  return { pinData, pinned: Object.keys(pinData) };
}

/** True when any tracked node's local build differs from the remote draft body. */
async function localDiffersFromDraft(dir: string, remote: Workflow, log: Log): Promise<boolean> {
  const state = readState(dir);
  if (!state) return false;
  const byId = new Map(remote.nodes.map((n) => [n.id, n]));
  for (const [nodeId, ns] of Object.entries(state.nodes)) {
    const node = byId.get(nodeId);
    if (!node || !isJsCodeNode(node)) continue;
    if (!existsSync(path.join(dir, ns.file))) continue;
    const { hash } = await buildNodeCode(dir, ns.file, log);
    if (hash !== sha256(splitMarker(node.parameters.jsCode).body)) return true;
  }
  return false;
}

/** The draft-tip wording for the "test what's on n8n now" choice. */
function draftWording(wf: Workflow): string {
  if (publicationState(wf) === "published" && wf.versionId === wf.activeVersionId) return "the live workflow";
  return "the current n8n draft";
}

function snapshotOf(remote: Workflow): DraftSnapshot {
  const jsCode: Record<string, string> = {};
  for (const node of remote.nodes) {
    if (isJsCodeNode(node)) jsCode[node.name] = node.parameters.jsCode;
  }
  return { versionId: typeof remote.versionId === "string" ? remote.versionId : undefined, jsCode };
}

/**
 * Restore the pre-test draft: `restore_workflow_version` when the instance
 * has it (n8n ≥ 2.29 — re-applies the version as the draft, live untouched),
 * else fall back to writing the snapshot's jsCode back — but only onto a
 * draft that still matches what OUR push produced (re-checked here; a
 * concurrent edit wins and aborts the fallback). Either way the local state
 * re-baselines to the restored remote, so `status` reads "local changes
 * pending push", not a conflict.
 */
async function restoreDraft(mcp: McpClient, dir: string, id: string, snapshot: DraftSnapshot, pushedHashes: Map<string, string>, log: Log): Promise<boolean> {
  let restored = false;
  if (snapshot.versionId !== undefined) {
    try {
      await mcp.callTool("restore_workflow_version", { workflowId: id, versionId: snapshot.versionId });
      log.ok(`restored the pre-test draft (version ${snapshot.versionId}) — the test push is undone (kept in n8n's version history)`);
      restored = true;
    } catch (err) {
      log.warn(`restore_workflow_version unavailable or failed (${(err as Error).message.split("\n")[0]}) — falling back to writing the snapshot back`);
    }
  }
  if (!restored) {
    const current = await getWorkflowDetails(mcp, id);
    const ops: Array<{ type: "updateNodeParameters"; nodeName: string; parameters: Record<string, unknown> }> = [];
    for (const node of current.nodes) {
      if (!isJsCodeNode(node)) continue;
      const wanted = snapshot.jsCode[node.name];
      if (wanted === undefined || node.parameters.jsCode === wanted) continue;
      const pushedHash = pushedHashes.get(node.name);
      if (pushedHash !== undefined && sha256(splitMarker(node.parameters.jsCode).body) !== pushedHash) {
        log.warn(`node "${node.name}": the draft changed again after the test push (a concurrent edit?) — NOT reverting it`);
        continue;
      }
      ops.push({ type: "updateNodeParameters", nodeName: node.name, parameters: { jsCode: wanted } });
    }
    if (ops.length > 0) await updateWorkflow(mcp, id, ops);
    log.ok(`wrote the pre-test code back to the draft (${ops.length} node${ops.length === 1 ? "" : "s"})`);
    restored = true;
  }
  // re-baseline: lastPushedHash = the restored remote, so local edits read
  // as "pending push" instead of a manufactured conflict
  const confirmed = await getWorkflowDetails(mcp, id);
  const state = readState(dir);
  if (state) {
    for (const node of confirmed.nodes) {
      if (!isJsCodeNode(node)) continue;
      const ns = state.nodes[node.id];
      if (ns) ns.lastPushedHash = sha256(splitMarker(node.parameters.jsCode).body);
    }
    writeState(dir, state);
  }
  return restored;
}

/**
 * `test <workflow>` — the full flow: pre-check (drift + publication state +
 * byte-exact draft snapshot), the TTY what-to-test choice (local code =
 * draft push first, drift-guarded, never activates; or the draft as-is),
 * the pinned `test_workflow` run, the client-side diff, and — when a push
 * happened — the keep/restore choice. Non-TTY runs NEVER mutate: they test
 * the draft tip as-is and say so when local differs (choices are verb
 * composition: `push` first). The live version is never affected either
 * way — `test_workflow` runs the draft.
 */
export async function runTest(
  mcp: McpClient,
  config: DecanterConfig,
  dir: string,
  id: string,
  { ref, source, trigger }: { ref: string; source: SimSource; trigger?: string },
  log: Log,
): Promise<TestReport> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const { exec, runData } = readCapture(dir, ref, source);
  // Provenance (Plan 37): a scenario with any authored/scaffolded node proves
  // executability only — the diff below asserts capture-provenance nodes
  // exclusively and divergence never fails a synthetic run.
  const provenance = scenarioProvenance(exec);
  const syntheticPins = source === "scenario" && scenarioIsSynthetic(exec);

  // 1) pre-check read: publication state + the byte-exact draft snapshot
  let remote = await getWorkflowDetails(mcp, id);
  const snapshot = snapshotOf(remote);
  const differs = await localDiffersFromDraft(dir, remote, log);

  // 1b) build the pins NOW, before any push — a pin gap must abort BEFORE we
  // mutate the draft (a jsCode push changes no node's name/type/disabled, so
  // the pin set is identical after a push; computing it here is authoritative
  // and keeps the "abort before anything runs" guarantee on the TTY path too).
  const { pinData, pinned } = buildTestPins(remote, runData, ref, source);
  // a multi-batch loop runs fully on the real engine, but the client-side
  // diff below only compares each node's FIRST run — flag that honestly
  const hasLoop = remote.nodes.some((n) => n.disabled !== true && isLoopDriver(n));

  // 2) what to test — a TTY choice, a non-TTY statement
  let pushed = false;
  const pushedHashes = new Map<string, string>();
  if (differs && interactive) {
    let pushLocal = true;
    if (publicationState(remote) === "published") {
      const rl = createPrompt();
      try {
        const answer = (await rl.question(`local code differs from the draft. Test your LOCAL code (pushes it to the draft first), or ${draftWording(remote)} as-is? [local/draft] `)).trim().toLowerCase();
        pushLocal = answer === "" || answer.startsWith("l");
      } finally {
        rl.close();
      }
    } // unpublished → no prompt: pushing a draft nobody runs is the obvious intent
    if (pushLocal) {
      const snapFile = path.join(dir, SNAPSHOT_FILE);
      mkdirSync(path.dirname(snapFile), { recursive: true });
      // the executions/ dir may not exist yet (e.g. a --mock run never fetched
      // one) — self-ignore it so the snapshot's inline jsCode can't be
      // git-committed by the push auto-commit below (same `*` the fetch writes)
      writeFileSync(path.join(dir, EXECUTIONS_DIR, ".gitignore"), "*\n");
      writeFileSync(snapFile, JSON.stringify(snapshot, null, 2) + "\n"); // crash-safe: survives until the keep/restore decision
      await pushWorkflow(mcp, config.root, id, { commitOnPush: config.commitOnPush }, log);
      pushed = true;
      remote = await getWorkflowDetails(mcp, id);
      for (const node of remote.nodes) {
        if (isJsCodeNode(node)) pushedHashes.set(node.name, sha256(splitMarker(node.parameters.jsCode).body));
      }
    }
  }

  // 3) run + diff — the draft tip, whatever it now is (pins fixed in 1b)
  log.info(`testing ${pushed ? "your local code (pushed to the draft)" : draftWording(remote)} on the instance — ${pinned.length} node(s) pinned from ${source} ${ref}`);
  const result = await mcp.callTool<{ executionId: string | null; status: string; error?: string }>("test_workflow", {
    workflowId: id,
    pinData,
    ...(trigger !== undefined && { triggerNodeName: trigger }),
  });

  const diffs: NodeDiff[] = [];
  if (result.executionId !== null && result.status === "success") {
    const execution = await mcp.callTool<{ execution: unknown; data?: { resultData?: { runData?: RunData } }; error?: string }>("get_execution", {
      workflowId: id,
      executionId: result.executionId,
      includeData: true,
    });
    const ranData = execution.data?.resultData?.runData ?? {};
    for (const node of remote.nodes) {
      if (node.disabled === true || !isPureNode(node)) continue;
      if ((provenance.get(node.name) ?? "capture") !== "capture") continue; // only assert capture-provenance nodes
      const expected = firstRunItems(runData[node.name]);
      if (expected === undefined) continue; // didn't run in the capture — nothing to compare
      const actual = firstRunItems(ranData[node.name]) ?? [];
      diffs.push({ node: node.name, equal: diffItems(expected, actual), expected: expected.map((i) => i.json), actual: actual.map((i) => i.json) });
    }
  }
  const divergent = diffs.filter((d) => !d.equal).map((d) => d.node);

  // 4) pushed? offer restore (TTY only — non-TTY never pushed)
  let restored: boolean | undefined;
  if (pushed) {
    const rl = createPrompt();
    let keep = true;
    try {
      keep = !(await rl.question("keep the pushed draft, or restore the pre-test draft? [keep/restore] ")).trim().toLowerCase().startsWith("r");
    } finally {
      rl.close();
    }
    if (!keep) restored = await restoreDraft(mcp, dir, id, snapshot, pushedHashes, log);
    else log.info(`kept — the draft now carries your local code (run "publish" to take it live)`);
    rmSync(path.join(dir, SNAPSHOT_FILE), { force: true });
  }

  return {
    source: `${source} ${ref}`,
    executionId: result.executionId,
    status: result.status,
    error: result.error,
    pinned,
    syntheticPins,
    provenance: Object.fromEntries(provenance),
    diffs,
    divergent,
    tested: pushed ? "local (pushed to the draft)" : "draft as-is",
    localDiffersFromTested: differs && !pushed,
    restored,
    firstIterationOnly: hasLoop,
    // synthetic pins prove executability only — divergence is informational, not a fail
    ok: result.status === "success" && (syntheticPins || divergent.length === 0),
  };
}

/** Human-readable report — mirrors `simulate`'s output style. */
export function printTestReport(r: TestReport, log: Log): void {
  if (r.status !== "success") {
    log.error(`instance test run failed: ${r.error ?? r.status}${r.executionId !== null ? ` (execution ${r.executionId})` : ""}`);
  } else {
    log.info(`instance run ${r.executionId} — ${r.diffs.length} node(s) diffed, ${r.pinned.length} pinned`);
    for (const d of r.diffs) {
      if (d.equal) log.ok(`${d.node}: matches capture`);
      else {
        log.error(`${d.node}: diverged from capture`);
        log.info(`    expected ${JSON.stringify(d.expected)}`);
        log.info(`    actual   ${JSON.stringify(d.actual)}`);
      }
    }
    if (r.syntheticPins) log.ok(`instance run succeeded — synthetic pins (authored/scaffolded), so this proves executability, not output correctness (no per-node diff asserted)`);
    else if (r.ok) log.ok(`instance test matches the capture (${r.diffs.length} node${r.diffs.length === 1 ? "" : "s"} checked)`);
    else log.error(`instance test diverged: ${r.divergent.join(", ")}`);
  }
  if (r.firstIterationOnly) {
    log.warn(`this workflow has a loop (splitInBatches) — the run executed all iterations on the instance, but the diff above compares only each node's FIRST run; later iterations are not checked`);
  }
  if (r.localDiffersFromTested) {
    log.warn(`local code differs from the draft — this tested the draft, NOT your local code; run \`n8n-decanter push\` first to test local changes`);
  }
  log.info(`the live (published) version was never affected — test_workflow runs the draft`);
}
