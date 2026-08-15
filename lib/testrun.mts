// The `test` verb (Plan 33 Task 5): an instance-side pinned-data run over
// MCP `test_workflow` — the recommended runtime check. The instance's real
// engine (instance-exact version, community nodes included) executes the
// DRAFT: trigger/credentialed/HTTP nodes are pinned from a local capture or
// committed mock (the same classification the local-engine replay uses), logic nodes run
// for real, and each pure node's output is diffed client-side against the
// capture (exit 1 on divergence). `preflight --simulate` remains the offline/pre-push/
// CI sibling — see docs/concepts for the taxonomy.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXECUTIONS_DIR } from "./executions.mts";
import { getWorkflowDetails, type McpClient, updateWorkflow } from "./mcp.mts";
import { createPrompt } from "./prompt.mts";
import { buildNodeCode, pushWorkflow } from "./push.mts";
import { readState, writeState } from "./state.mts";
import { diffItems, firstRunItems, isLoopDriver, isPureNode, type NodeDiff, populatedOutputs, type Provenance, type RunData, type RunItem, readCapture, scenarioIsSynthetic, scenarioProvenance, type SimSource } from "./simulate.mts";
import type { DecanterConfig, Log, Workflow } from "./types.mts";
import { isJsCodeNode, publicationState, sha256, splitMarker } from "./util.mts";
import { type DanglingRef, danglingNodeRefs, describeDanglingRefs } from "./validate.mts";

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

/**
 * Item-level coverage of one instance run (Plan 66): of the nodes that were NOT
 * pinned — the ones the run actually executed — how many emitted at least one
 * item, and which emitted none. A pinned node is excluded because its items are
 * the input we handed n8n, not evidence the workflow produced anything.
 */
export interface NodeCoverage {
  /** Enabled, unpinned nodes — the denominator. */
  total: number;
  /** How many of them emitted ≥1 item on their first run. */
  emitted: number;
  /** Names of the rest — emitted nothing, or never ran at all. */
  empty: string[];
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
  /**
   * What the run actually MOVED, over the nodes that ran for real (Plan 66):
   * every enabled, unpinned node, split by whether it emitted an item. n8n
   * reports `success` for a run in which each of them emitted nothing — a
   * report that says only "success" is then describing a workflow that did no
   * work. Absent when the run never produced an execution to read.
   */
  coverage?: NodeCoverage;
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
 * split the local-engine replay uses — triggers/network/credentialed nodes must not run
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
    // The old hint said "scenario create", which REFUSED an existing scenario —
    // a dead end for exactly the case that reaches here (Plan 65). `--extend`
    // adds these nodes to the scenario that was rejected; a raw capture still
    // needs promoting first.
    const fix = source === "scenario"
      ? `n8n-decanter scenario create <workflow> "${ref}" --extend`
      : `n8n-decanter scenario create <workflow> --execution ${ref}`;
    throw new Error(
      `cannot pin ${gaps.map((g) => `"${g}"`).join(", ")} — no captured output in ${source} ${ref}, and an unpinned ` +
        `trigger/network node would run for REAL on the instance. \`test\` pins EVERY non-pure node, which is stricter than ` +
        `\`preflight --simulate\` (it only demands the ones the capture reached). Add them with: ${fix}`,
    );
  }
  return { pinData, pinned: Object.keys(pinData) };
}

/**
 * Item-level coverage of an instance run (Plan 66). Counts only nodes the run
 * actually **executed** — enabled and unpinned — because a pinned node's items
 * are the input we supplied, so counting them would let a run where nothing
 * downstream fired still look busy. Emission is judged across **every** output
 * (`populatedOutputs`), not `main[0]`: a node that routed everything down its
 * second branch did emit, and reporting otherwise would repeat the very
 * truncation this plan is about. Exported for tests.
 */
export function coverageOf(wf: Workflow, pinned: Set<string>, ranData: RunData): NodeCoverage {
  const empty: string[] = [];
  let total = 0;
  let emitted = 0;
  for (const node of wf.nodes) {
    if (node.disabled === true || pinned.has(node.name)) continue;
    total++;
    if (populatedOutputs(ranData[node.name]).length > 0) emitted++;
    else empty.push(node.name); // emitted nothing, or never ran at all
  }
  return { total, emitted, empty };
}

/**
 * True when the run executed nodes and **none** of them emitted an item — the
 * case n8n still calls `success` and the report used to repeat verbatim. A
 * workflow whose every unpinned node is empty moved no data at all, so nothing
 * about it was demonstrated. `total === 0` (everything was pinned) is not this:
 * there was nothing to emit.
 */
function provedNothing(coverage: NodeCoverage | undefined): boolean {
  return coverage !== undefined && coverage.total > 0 && coverage.emitted === 0;
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
    // quiet: this compile only COMPARES hashes. If the answer leads to a
    // push, pushWorkflow's guard tier prints the advisory findings once —
    // emitting here too would double them (Plan 79 task 7 de-dup).
    const { hash } = await buildNodeCode(dir, ns.file, log, { quietImportWarnings: true });
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
 * re-baselines to the restored remote, so `diff` (and preflight's `parity`
 * check) read "local changes
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
/** What `test` reports when it runs nothing (Plan 64 task 3b). */
export interface StaticReport {
  id: string;
  name: string;
  /** Dangling `$('…')` refs on the instance's DRAFT — the thing publish would go live with. */
  dangling: DanglingRef[];
  ok: boolean;
}

/**
 * `test <workflow>` with no `--scenario`/`--execution`: grade the instance's
 * draft **statically** and execute nothing (Plan 64 task 3b).
 *
 * This is the cheap tier of what `test` already is. Plan 60 assigned the
 * subjects — `preflight` grades local files, `test` grades the instance's draft
 * — so the static check of a remote draft belongs here rather than in preflight.
 * It is also what `publish` gates on, via the same `danglingNodeRefs` scan, so
 * the two can never disagree.
 *
 * Deliberately NOT a fallback to "the latest capture": that made a bare `test`
 * execute for real against the instance, steered by the contents of a gitignored
 * directory. Executing now requires saying so.
 */
export async function runStaticTest(mcp: McpClient, id: string, log: Log): Promise<StaticReport> {
  const remote = await getWorkflowDetails(mcp, id);
  const dangling = danglingNodeRefs(remote.nodes);
  const report: StaticReport = { id, name: remote.name, dangling, ok: dangling.length === 0 };
  if (report.ok) {
    log.ok(`"${remote.name}" (${id}) — draft is statically clean; nothing was executed`);
    log.info(`pass --scenario <slug> or --execution <id> to actually run it on the instance`);
  } else {
    log.error(`"${remote.name}" (${id}) — ${dangling.length} dangling $('…') reference(s) on the DRAFT:`);
    for (const line of describeDanglingRefs(dangling)) log.error(line);
  }
  return report;
}

export async function runTest(
  mcp: McpClient,
  config: DecanterConfig,
  dir: string,
  id: string,
  { ref, source, trigger }: { ref: string; source: SimSource; trigger?: string },
  log: Log,
): Promise<TestReport> {
  // Plan 60 removed `neverMutate`: preflight was its only caller, and preflight
  // no longer runs `test` at all. `test` is now unambiguously a verb you run
  // yourself, after `push` — a TTY gets the choice, a pipe/CI never mutates.
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const { exec, runData } = readCapture(dir, ref, source);
  // Provenance (Plan 37): a scenario with any authored/scaffolded node proves
  // executability only — the diff below asserts capture-provenance nodes
  // exclusively and divergence never fails a synthetic run.
  const provenance = scenarioProvenance(exec);
  const syntheticPins = source === "scenario" && scenarioIsSynthetic(exec);

  // 1) pre-check read: publication state + the byte-exact draft snapshot
  let remote = await getWorkflowDetails(mcp, id);
  // Never fire a real run at a draft we already know is broken (Plan 64): a
  // dangling $('…') fails at run time anyway, and the run has real side effects.
  const dangling = danglingNodeRefs(remote.nodes);
  if (dangling.length > 0) {
    throw new Error(
      [`"${remote.name}" has ${dangling.length} dangling $('…') reference(s) on the draft — refusing to run it on the instance:`, ...describeDanglingRefs(dangling)].join("\n"),
    );
  }
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
  let coverage: NodeCoverage | undefined;
  if (result.executionId !== null && result.status === "success") {
    const execution = await mcp.callTool<{ execution: unknown; data?: { resultData?: { runData?: RunData } }; error?: string }>("get_execution", {
      workflowId: id,
      executionId: result.executionId,
      includeData: true,
    });
    const ranData = execution.data?.resultData?.runData ?? {};
    coverage = coverageOf(remote, new Set(pinned), ranData);
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
    coverage,
    tested: pushed ? "local (pushed to the draft)" : "draft as-is",
    localDiffersFromTested: differs && !pushed,
    restored,
    firstIterationOnly: hasLoop,
    // synthetic pins prove executability only — divergence is informational, not
    // a fail. But "executable" has to mean something: a run in which not one
    // unpinned node emitted an item demonstrated nothing at all, so it is NOT ok
    // (Plan 66). Partial emptiness only warns — a filter that legitimately drops
    // every item is a passing workflow, not a broken one.
    ok: result.status === "success" && (syntheticPins || divergent.length === 0) && !provedNothing(coverage),
  };
}

/**
 * The coverage line (Plan 66): what the run moved, not just that it finished.
 * Silent when everything was pinned — there was nothing left to execute, so
 * "0/0 emitted" would read as a problem where there is none.
 */
function printCoverage(coverage: NodeCoverage | undefined, log: Log): void {
  if (coverage === undefined || coverage.total === 0) return;
  const line = `coverage: ${coverage.emitted}/${coverage.total} unpinned node(s) emitted items`;
  if (coverage.empty.length === 0) log.ok(line);
  else log.warn(`${line} — ${coverage.empty.length} emitted none: ${coverage.empty.join(", ")}`);
}

/** Human-readable report — mirrors the local-engine replay's output style. */
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
    printCoverage(r.coverage, log);
    if (provedNothing(r.coverage)) {
      log.error(
        `the run executed ${r.coverage?.total} unpinned node(s) and NOT ONE emitted an item — n8n reports that as "success", but no data moved, so nothing about this workflow was demonstrated. ` +
          `The usual cause is a pin that feeds a branch nothing reads: replays only ever replay each pinned node's FIRST output (main[0]), so a node fed by an IF's false branch or an error output gets nothing.`,
      );
    } else if (r.syntheticPins) log.ok(`instance run succeeded — synthetic pins (authored/scaffolded), so this proves executability, not output correctness (no per-node diff asserted)`);
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
