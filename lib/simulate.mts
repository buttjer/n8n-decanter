// Plan 7 — engine-true simulation, offline half: scenario/capture loader +
// route-B workflow transform. Given a captured execution, produce a *copy* of the
// workflow that the real n8n engine can replay dry: pure (side-effect-free)
// nodes execute for real, every network/side-effectful node is pinned to its
// captured output, credentials are stripped, and no outbound-capable node
// survives. The engine run itself (n8n import:workflow + execute) lives in the
// `simulate` verb (task 3); this module has no I/O beyond reading local files.
//
// Route B recipe validated by the Plan 7 spike (2026-07-20): `n8n execute`
// does NOT honor a workflow's `pinData` in CLI mode, and it needs a real
// trigger node as entry point. So pinning is done by *node replacement* — the
// trigger and each network node become a name-preserving Code node that
// `return`s the captured items — plus a synthetic manual-trigger entry point.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runEngine, startViewer } from "./engine.mts";
import { EXECUTIONS_DIR, SCENARIOS_DIR, warnStaleCaptures } from "./executions.mts";
import type { PinDataScaffold } from "./mcp.mts";
import { buildNodeCode } from "./push.mts";
import { readState } from "./state.mts";
import type { Execution, Log, NodeParameters, Workflow, WorkflowNode } from "./types.mts";
import { canonicalJson, forEachConnectionTarget, isJsCodeNode, kebabCase, placeholderFile } from "./util.mts";

/** Name of the synthetic Manual Trigger the transform prepends as the entry point. */
export const SIM_START_NODE = "__sim_start__";
/** Prefix for the synthetic Limit nodes tier-2 injects to cap a loop to one batch. */
export const SIM_CAP_PREFIX = "__sim_cap__";

/**
 * Side-effect-free node types that execute for real in a simulation. Curated,
 * versioned, and **default-deny**: any type NOT in this set is treated as a
 * network node and pinned — safety never depends on knowing a type. Additions
 * need justification (misclassifying a node as pure runs it for real).
 * Seed list signed off 2026-07-20 (Plan 7 task 2). Deliberately excluded though
 * side-effect-free: `splitInBatches` (a loop driver — see `LOOP_DRIVER_TYPES`),
 * `wait` (time semantics), `executeWorkflow` (crosses the workflow boundary).
 */
export const PURE_NODE_TYPES: ReadonlySet<string> = new Set(
  ["code", "set", "if", "switch", "filter", "merge", "sort", "limit", "aggregate",
    "splitOut", "removeDuplicates", "renameKeys", "dateTime", "noOp"]
    .map((t) => `n8n-nodes-base.${t}`),
);

/** True for a node type that executes for real (on the pure allowlist). */
export function isPureNode(node: WorkflowNode): boolean {
  return PURE_NODE_TYPES.has(node.type);
}

/**
 * Loop-driver node types: side-effect-free control flow, but **stateful across
 * runs** — they emit one run per batch plus a final "done" pass, so pinning them
 * to a single captured run would break the loop. Kept off `PURE_NODE_TYPES` for
 * that reason; instead they **execute for real** so a single-iteration loop
 * replays faithfully (Plan 7 tier 1), and are never diffed (the driver's output
 * isn't a Code-node regression signal). A *multi*-iteration loop stays out of
 * scope — first-run-only pinning can't feed later iterations (see the guard in
 * `buildSimulation`).
 */
export const LOOP_DRIVER_TYPES: ReadonlySet<string> = new Set(["n8n-nodes-base.splitInBatches"]);

/** True for a loop-driver node (runs for real, but is neither pinned nor diffed). */
export function isLoopDriver(node: WorkflowNode): boolean {
  return LOOP_DRIVER_TYPES.has(node.type);
}

/** One item as it appears in captured/replayed run data (`.json` payload + link). */
export interface RunItem {
  json?: unknown;
  pairedItem?: unknown;
  [key: string]: unknown;
}

/**
 * Per-node provenance for a scenario's pinned data (Plan 37): where a node's
 * items came from. `capture` = a real execution (can serve as a diff baseline);
 * `authored` = human/agent-filled by hand; `scaffolded` = schema-guided fill
 * (still authored values, but with an `expectedSchema` to guide them). Consumers
 * only diff `capture`-provenance nodes; any non-`capture` node marks the run's
 * pins as **synthetic** ("proves executability, not output correctness").
 */
export type Provenance = "capture" | "authored" | "scaffolded";

/**
 * Context recorded for one unpinnable network node (a *gap*): its type +
 * parameters and the captured items feeding it — enough for the local agent (or
 * a human) to author plausible output when filling a `scenarios/<slug>.json`
 * file. `expectedSchema` is the node's output JSON Schema when `--scaffold`
 * annotated it (from `prepare_test_pin_data`); absent for a plain gap.
 */
export interface GapContext {
  node: string;
  type: string;
  parameters: NodeParameters;
  /** Captured items this node receives from upstream — context for the fill. */
  input: RunItem[];
  /** Output JSON Schema for the fill, when `--scaffold` annotated this node. */
  expectedSchema?: unknown;
}

/**
 * Thrown by `buildSimulation` when one or more reachable network nodes have no
 * pinned data. Carries the per-node `gaps` so `scenario create` can scaffold a
 * fillable `scenarios/<slug>.json`; the message leads the user to filling a
 * scenario.
 */
export class SimulationGapError extends Error {
  readonly gaps: GapContext[];
  constructor(message: string, gaps: GapContext[]) {
    super(message);
    this.name = "SimulationGapError";
    this.gaps = gaps;
  }
}

/** The transform's output — the sim workflow plus what the verb needs to diff. */
export interface Simulation {
  /** The transformed copy, ready for `n8n import:workflow` + `execute`. */
  workflow: Workflow;
  /** Node names replaced with pinned captured output (triggers + network nodes). */
  pinned: string[];
  /** Node names that execute for real (pure allowlist). */
  pure: string[];
  /** Loop-driver nodes (e.g. `splitInBatches`) that run for real but aren't diffed. */
  loops: string[];
  /** Per-node captured items, for diffing the engine's output against (task 3). */
  captured: Map<string, RunItem[]>;
  /**
   * Tier-2 (viewer-only): true when this is a best-effort *single iteration* of a
   * genuine multi-batch loop — the loop driver's input is capped to one batch so
   * it iterates once, bodies pinned to their first run. NOT a pass/fail check
   * (pinning is single-valued); the diff is skipped and the run is display-only.
   */
  bestEffortLoop?: boolean;
  /** Tier-2: number of batches the loop ran in the capture (the "of N" in "iteration 1 of N"). */
  loopIterations?: number;
}

type NodeRun = { data?: { main?: Array<Array<RunItem> | null> } };
export type RunData = Record<string, NodeRun[]>;

/** Pull the `resultData.runData` map out of a capture, validating shape defensively. */
function runDataOf(exec: Execution, execId: string): RunData {
  const rd = (exec as { data?: { resultData?: { runData?: unknown } } }).data?.resultData?.runData;
  if (!rd || typeof rd !== "object" || Array.isArray(rd)) {
    throw new Error(`execution ${execId}: no resultData.runData object — capture is empty or malformed (re-fetch with "executions")`);
  }
  return rd as RunData;
}

/** Items a node emitted on its first run, first output — `[]` if it emitted none. */
export function firstRunItems(runs: NodeRun[] | undefined): RunItem[] | undefined {
  if (!runs || runs.length === 0) return undefined;
  const main = runs[0]?.data?.main;
  if (!Array.isArray(main)) return [];
  const first = main[0];
  return Array.isArray(first) ? first : [];
}

/** Where a replay source lives: a slug-named committed scenario, or a raw temp capture. */
export type SimSource = "capture" | "scenario";

/** Filename (without dir) for a source ref — scenarios are kebab-slugged, captures are ids. */
function sourceName(ref: string, source: SimSource): string {
  return source === "scenario" ? kebabCase(ref) : ref;
}

/**
 * Locate a replay source file: `scenarios/<slug>.json` for a committed scenario
 * (chosen explicitly by `simulate --scenario <slug>`) or `executions/<id>.json`
 * for a gitignored raw capture. `null` when it doesn't exist.
 */
export function sourceFile(dir: string, ref: string, source: SimSource): string | null {
  const sub = source === "scenario" ? SCENARIOS_DIR : EXECUTIONS_DIR;
  const file = path.join(dir, sub, `${sourceName(ref, source)}.json`);
  return existsSync(file) ? file : null;
}

/** Read + validate a replay source (a raw capture, or a committed scenario). */
export function readCapture(dir: string, ref: string, source: SimSource): { exec: Execution; runData: RunData } {
  const file = sourceFile(dir, ref, source);
  if (!file) {
    throw new Error(source === "scenario"
      ? `scenario "${ref}" not found under ${SCENARIOS_DIR}/ — create it first: n8n-decanter <ref> scenario create ${ref}`
      : `execution ${ref} not captured under ${EXECUTIONS_DIR}/ — fetch it first: n8n-decanter <ref> executions`);
  }
  let exec: Execution;
  try {
    exec = JSON.parse(readFileSync(file, "utf8")) as Execution;
  } catch (err) {
    throw new Error(`corrupt ${source} ${file} (${(err as Error).message})`);
  }
  validateScenarioRunData(exec, ref); // no-op for real captures; checks hand-filled scenarios
  return { exec, runData: runDataOf(exec, ref) };
}

/** A scenario's metadata block — reads the Plan 37 `_decanterScenario`, or the legacy `_decanterMock`. */
export function readScenarioMeta(exec: Execution): ScenarioMeta | undefined {
  const e = exec as { _decanterScenario?: ScenarioMeta; _decanterMock?: ScenarioMeta };
  return e._decanterScenario ?? e._decanterMock;
}

/**
 * Per-node provenance for a scenario (Plan 37): every node present in the
 * scenario's runData is `capture` unless it's in the fill list, where it's
 * `scaffolded` (an `expectedSchema` was attached) or `authored` (a plain gap
 * the user filled by hand). Nodes not in the scenario at all are absent.
 */
export function scenarioProvenance(exec: Execution): Map<string, Provenance> {
  const out = new Map<string, Provenance>();
  const runData = (exec as { data?: { resultData?: { runData?: unknown } } }).data?.resultData?.runData;
  if (runData && typeof runData === "object" && !Array.isArray(runData)) {
    for (const node of Object.keys(runData as Record<string, unknown>)) out.set(node, "capture");
  }
  for (const f of readScenarioMeta(exec)?.fill ?? []) {
    if (typeof f.node === "string") out.set(f.node, f.expectedSchema !== undefined ? "scaffolded" : "authored");
  }
  return out;
}

/** True when a scenario carries any non-`capture` (authored/scaffolded) pins — its results prove executability, not output correctness. */
export function scenarioIsSynthetic(exec: Execution): boolean {
  return (readScenarioMeta(exec)?.fill?.length ?? 0) > 0;
}

/**
 * Structural validation of a hand-filled scenario. n8n publishes **no JSON
 * Schema** for run data — the format is only the `n8n-workflow` TS types
 * (`IRunExecutionData` → `ITaskData` → `INodeExecutionData`) — so we validate the
 * exact shape `simulate` consumes and give an actionable error naming the node.
 * Runs only on files carrying a `_decanterScenario`/`_decanterMock` marker (real
 * captures come straight from the API and are trusted); their copied-in nodes
 * were valid, so this effectively checks the agent's/human's edits. Also flags
 * scenario nodes still listed to fill but left without data. Exported for testing.
 */
export function validateScenarioRunData(exec: Execution, slug: string): void {
  const meta = readScenarioMeta(exec);
  if (meta === undefined) return; // not a scenario
  const runData = (exec as { data?: { resultData?: { runData?: unknown } } }).data?.resultData?.runData;
  const problems: string[] = [];
  if (runData && typeof runData === "object" && !Array.isArray(runData)) {
    for (const [node, runs] of Object.entries(runData as Record<string, unknown>)) {
      if (!Array.isArray(runs)) { problems.push(`${node}: runData["${node}"] must be an array of runs`); continue; }
      runs.forEach((r, ri) => {
        const main = (r as { data?: { main?: unknown } })?.data?.main;
        if (main === undefined) return; // a run may legitimately produce no main output
        if (!Array.isArray(main)) { problems.push(`${node} run ${ri}: data.main must be an array of outputs`); return; }
        main.forEach((out, oi) => {
          if (out === null) return; // an unconnected output is null
          if (!Array.isArray(out)) { problems.push(`${node} run ${ri} output ${oi}: must be an array of items (or null)`); return; }
          out.forEach((it, ii) => {
            if (!it || typeof it !== "object" || Array.isArray(it)) problems.push(`${node} run ${ri} item ${ii}: each item must be an object`);
            else if (!("json" in it)) problems.push(`${node} run ${ri} item ${ii}: each item needs a "json" field`);
          });
        });
      });
    }
  }
  const unfilled = (meta.fill ?? [])
    .map((f) => f.node)
    .filter((n): n is string => typeof n === "string" && firstRunItems((runData as RunData | undefined)?.[n]) === undefined);
  if (unfilled.length > 0) {
    problems.push(`incomplete: add runData for ${unfilled.join(", ")} (still listed in _decanterScenario.fill)`);
  }
  if (problems.length > 0) {
    throw new Error(`scenario ${SCENARIOS_DIR}/${kebabCase(slug)}.json is invalid:\n  - ${problems.join("\n  - ")}\n  expected per node: runData["<node>"] = [ { "data": { "main": [ [ { "json": { … } } ] ] } } ]`);
  }
}

/** Every node name that is the *target* of at least one connection (has an input edge). */
function connectedTargets(connections: Record<string, unknown>): Set<string> {
  const targets = new Set<string>();
  forEachConnectionTarget(connections, (t) => {
    if (typeof t.node === "string") targets.add(t.node);
  });
  return targets;
}

/**
 * True when a network node with no data was reachable *in the capture*: some
 * upstream node ran and emitted ≥1 item on a connection feeding it. Such a node
 * is a genuine gap (added/reparametrized since the capture) — a hard error.
 * A node no ran-upstream fed is an untaken branch — exempt, neutralized instead.
 */
function reachableInCapture(target: string, connections: Record<string, unknown>, runData: RunData): boolean {
  let reachable = false;
  forEachConnectionTarget(connections, (t, source, type) => {
    if (t.node !== target || type !== "main" || reachable) return;
    const items = firstRunItems(runData[source]);
    if (items && items.length > 0) reachable = true;
  });
  return reachable;
}

/** Captured items feeding a node on its `main` inputs — few-shot context for a gap guess. */
function capturedInputFor(target: string, connections: Record<string, unknown>, runData: RunData): RunItem[] {
  const input: RunItem[] = [];
  forEachConnectionTarget(connections, (t, source, type) => {
    if (t.node !== target || type !== "main") return;
    const items = firstRunItems(runData[source]);
    if (items) input.push(...items);
  });
  return input;
}

/** A loop driver's configured batch size — one batch = one iteration (default 1). */
function readBatchSize(node: WorkflowNode): number {
  const bs = (node.parameters as { batchSize?: unknown }).batchSize;
  return typeof bs === "number" && Number.isInteger(bs) && bs > 0 ? bs : 1;
}

/**
 * Tier-2 (viewer-only): cap every loop driver's input to one batch so a genuine
 * multi-batch loop iterates exactly once, showing "iteration 1". For each driver
 * we splice a synthetic `limit` node (maxItems = batchSize) onto its incoming
 * `main` edges — the driver drains that single batch and then emits "done", so
 * the body (pinned to its first run) runs once and the post-loop path is shown.
 * Mutates `nodes` (adds caps) and `connections` (rewires) in place. Uses `limit`,
 * which is on the pure allowlist, so the dry-run guarantee is unaffected.
 */
function capLoopDrivers(nodes: WorkflowNode[], connections: Record<string, unknown>, drivers: string[]): void {
  for (const driver of drivers) {
    const driverNode = nodes.find((n) => n.name === driver);
    if (!driverNode) continue;
    const capName = `${SIM_CAP_PREFIX}${driver}`;
    const pos = (driverNode as { position?: [number, number] }).position ?? [0, 0];
    // Rewire every edge targeting the driver's main input to hit the cap instead.
    forEachConnectionTarget(connections, (t, _source, type) => {
      if (type === "main" && t.node === driver) t.node = capName;
    });
    connections[capName] = { main: [[{ node: driver, type: "main", index: 0 }]] };
    nodes.push({
      id: `${SIM_CAP_PREFIX}${driverNode.id}`, name: capName,
      type: "n8n-nodes-base.limit", typeVersion: 1,
      position: [pos[0] - 120, pos[1] - 80], parameters: { maxItems: readBatchSize(driverNode) },
    });
  }
}

/** JS body for a name-preserving replacement node: emit the captured items verbatim. */
function emitCode(items: RunItem[]): string {
  const payload = items.map((it) => (it.pairedItem !== undefined ? { json: it.json, pairedItem: it.pairedItem } : { json: it.json }));
  return `return ${JSON.stringify(payload)};\n`;
}

/** JS body for a neutralized (untaken/disabled) network node: fail loudly if reached. */
function guardCode(name: string): string {
  return `throw new Error(${JSON.stringify(`[decanter simulate] network node "${name}" has no pinned data and was reached unexpectedly — re-capture the execution or add it to the scenario`)});\n`;
}

/** A name-preserving Code node standing in for a replaced trigger/network node. */
function replacementNode(original: WorkflowNode, jsCode: string): WorkflowNode {
  return {
    id: original.id,
    name: original.name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: (original as { position?: unknown }).position ?? [0, 0],
    parameters: { jsCode },
    ...(original.disabled ? { disabled: true } : {}),
  };
}

/**
 * Build the simulation copy of a pulled workflow from a captured execution.
 * Pure nodes are kept (Code-node sources materialized from their files), every
 * network node and the trigger are replaced with captured-output Code nodes,
 * a synthetic Manual Trigger is prepended, and all credentials are stripped.
 * Loop drivers (`splitInBatches`) run for real so a **single-iteration** loop
 * replays faithfully. Throws on the plan's hard errors: unpinnable gaps
 * (`SimulationGapError`), *multi*-iteration loops, or a surviving off-allowlist
 * executable node.
 *
 * `opts.allowMultiBatch` opts into tier-2 (viewer-only): instead of hard-erroring
 * on a genuine multi-batch loop, cap the driver to one batch and return a
 * best-effort "iteration 1 of N" simulation (never diffed — see `bestEffortLoop`).
 */
export async function buildSimulation(
  dir: string,
  ref: string,
  log: Log,
  opts: { source?: SimSource; allowMultiBatch?: boolean } = {},
): Promise<Simulation> {
  const source = opts.source ?? "capture";
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`no workflow.json in ${dir} — pull the workflow first`);
  const wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  if (readState(dir) === null) throw new Error(`no .decanter.json in ${dir} — pull the workflow first`);

  const { exec, runData } = readCapture(dir, ref, source);
  warnStaleCaptures(dir, [exec], log);

  // Loop captures (Plan 7 "Loop workflows"). A single-iteration loop replays
  // faithfully — only the loop driver ran more than once (twice: one batch pass
  // + the final "done" pass) while every other node ran exactly once, so its
  // first-run pins are exact and the driver runs for real. A *multi*-iteration
  // loop is out of scope for a gated run: first-run-only pinning would misfeed
  // iterations 2..N. The multi-iteration signal is any non-driver node with >1
  // run, or a driver with >2 runs (≥2 batches).
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const multiIteration = Object.entries(runData)
    .filter(([name, runs]) => {
      if (!Array.isArray(runs) || runs.length <= 1) return false;
      const node = byName.get(name);
      return !(node && isLoopDriver(node)) || runs.length > 2;
    })
    .map(([n]) => n);
  // Tier-2 (viewer-only) turns that hard error into a best-effort single iteration.
  const bestEffortLoop = multiIteration.length > 0 && opts.allowMultiBatch === true;
  if (multiIteration.length > 0 && !bestEffortLoop) {
    throw new Error(`loop workflows are out of scope (v1): only single-iteration loops replay — node(s) ran across multiple iterations in ${ref}: ${multiIteration.join(", ")}`);
  }
  // "of N": batches the loop ran — max body-run count, or driver runs minus the "done" pass.
  const loopIterations = bestEffortLoop
    ? Math.max(...Object.entries(runData).map(([name, runs]) => {
        if (!Array.isArray(runs)) return 0;
        const node = byName.get(name);
        return node && isLoopDriver(node) ? Math.max(0, runs.length - 1) : runs.length;
      }))
    : undefined;

  // A scenario is self-contained (Plan 37): each node's pins come from exactly
  // one source — the scenario's own runData (or the raw capture's).
  const itemsFor = (name: string): RunItem[] | undefined => firstRunItems(runData[name]);

  const captured = new Map<string, RunItem[]>();
  const pinned: string[] = [];
  const pure: string[] = [];
  const loopDrivers: string[] = [];
  const gaps: GapContext[] = [];
  const nodes: WorkflowNode[] = [];

  for (const node of wf.nodes) {
    const disabled = node.disabled === true;
    if (isLoopDriver(node)) {
      // Runs for real to reproduce the (single-iteration) loop; never pinned,
      // never diffed. Guaranteed side-effect-free by LOOP_DRIVER_TYPES.
      loopDrivers.push(node.name);
      nodes.push(stripCredentials(structuredClone(node)));
      continue;
    }
    if (isPureNode(node)) {
      pure.push(node.name);
      const clone = stripCredentials(structuredClone(node));
      // Materialize `//@file:` Code-node placeholders into real source.
      if (isJsCodeNode(clone)) {
        const file = placeholderFile(clone);
        if (file !== null) clone.parameters.jsCode = (await buildNodeCode(dir, file, log)).jsCode;
      }
      nodes.push(clone);
      const items = firstRunItems(runData[node.name]);
      if (items) captured.set(node.name, items);
      continue;
    }
    // Network node (default-deny): must be neutralized so nothing outbound survives.
    const items = itemsFor(node.name);
    if (items) {
      pinned.push(node.name);
      captured.set(node.name, items);
      nodes.push(replacementNode(node, emitCode(items)));
    } else if (!disabled && reachableInCapture(node.name, wf.connections, runData)) {
      // Reached in capture but no data → real gap. Collect context so
      // `scenario create` can scaffold a fillable scenarios/ file for it.
      gaps.push({ node: node.name, type: node.type, parameters: node.parameters, input: capturedInputFor(node.name, wf.connections, runData) });
      nodes.push(replacementNode(node, guardCode(node.name)));
    } else {
      // Untaken branch or disabled: neutralize, but don't demand data for it.
      nodes.push(replacementNode(node, guardCode(node.name)));
    }
  }

  if (gaps.length > 0) {
    const names = gaps.map((g) => g.node).join(", ");
    throw new SimulationGapError(
      source === "scenario"
        ? `scenario "${ref}" still has network node(s) with no data: ${names} — add their runData under data.resultData.runData in ${SCENARIOS_DIR}/${sourceName(ref, "scenario")}.json (see the _decanterScenario block), then re-run. Validate offline with: n8n-decanter <workflow> scenario check ${ref}.`
        : `network node(s) reached with no captured data: ${names} — create a committed, fillable scenario with \`n8n-decanter <workflow> scenario create --execution ${ref}\`, add their runData, and replay with \`simulate --scenario\`. The scenario is edited locally — the CLI never calls a model.`,
      gaps,
    );
  }

  // Prepend a synthetic Manual Trigger wired to every entry node (no input edge),
  // giving `n8n execute` a valid CLI entry point (the spike's route-B recipe).
  const connections: Record<string, unknown> = structuredClone(wf.connections) ?? {};
  // Tier-2: splice in the loop caps before computing entries, so the driver's new
  // upstream (the cap) is seen as its input edge and the cap isn't a stray entry.
  if (bestEffortLoop) capLoopDrivers(nodes, connections, loopDrivers);
  const targets = connectedTargets(connections);
  const entries = nodes.filter((n) => n.disabled !== true && !targets.has(n.name)).map((n) => n.name);
  const startNode: WorkflowNode = {
    id: SIM_START_NODE, name: SIM_START_NODE, type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1, position: [-260, 0], parameters: {},
  };
  connections[SIM_START_NODE] = { main: [entries.map((node) => ({ node, type: "main", index: 0 }))] };

  const simWorkflow: Workflow = {
    ...wf,
    nodes: [startNode, ...nodes],
    connections,
    active: false,
  };

  // Structural half of the dry-run guarantee: no off-allowlist executable node
  // and no credentials may survive. Replacements are Code (pure), so this only
  // fires on a classification bug — belt-and-braces, asserted by tests too.
  assertDryRunSafe(simWorkflow);

  const loopNote = loopDrivers.length > 0
    ? `, ${loopDrivers.length} loop driver(s) run for real (${bestEffortLoop ? `capped to iteration 1 of ${loopIterations}` : "single-iteration"})`
    : "";
  log.info(`simulation: ${pure.length} node(s) execute for real, ${pinned.length} pinned from ${source} ${ref}${loopNote}`);
  return { workflow: simWorkflow, pinned, pure, loops: loopDrivers, captured, bestEffortLoop, loopIterations };
}

/**
 * Run the offline transform purely to discover unpinnable gaps — returns the
 * per-node `GapContext[]` if `buildSimulation` raises `SimulationGapError`, else
 * `[]`. Any other failure (e.g. a multi-batch loop) propagates. Used by
 * `scenario create` to learn which nodes to flag for filling.
 */
export async function detectGaps(dir: string, ref: string, log: Log, source: SimSource = "capture"): Promise<GapContext[]> {
  try {
    await buildSimulation(dir, ref, log, { source });
    return [];
  } catch (err) {
    if (err instanceof SimulationGapError) return err.gaps;
    throw err;
  }
}

/** Guidance + per-node context `scenario create` records for gaps to be authored. */
export interface ScenarioMeta {
  /** How the scenario was seeded overall: from a real capture, scaffolded from schemas, or both. */
  source: "capture" | "scaffold" | "capture+scaffold";
  /** The capture id a capture-seeded scenario was built from (absent for a pure scaffold). */
  sourceExecution?: string;
  createdAt: string;
  /** Draft version at create time — scenario staleness warns when the draft has moved past it. */
  workflowVersionId?: string;
  guidance: string;
  /**
   * Nodes still needing `runData` authored — the fill list. `expectedSchema`
   * present ⇒ **scaffolded** (schema-guided, from `prepare_test_pin_data`);
   * absent ⇒ a plain gap to **author** by hand. Kept as-is: it records which
   * nodes are synthetic (the provenance signal) and is what `scenario check`
   * validates.
   */
  fill: Array<{ node: string; type: string; parameters: NodeParameters; inputSample: unknown[]; expectedSchema?: unknown }>;
}

/** Placeholder schema recorded for a scaffolded node n8n couldn't schema (still provenance `scaffolded`). */
const NO_SCHEMA_HINT = { $comment: "no schema available from n8n — author a single empty item: [ { \"json\": {} } ]" };

/** Nodes that must be pinned in a scenario/test run: enabled, not on the pure allowlist, not a loop driver. */
function pinnableNodes(wf: Workflow): WorkflowNode[] {
  return (wf.nodes ?? []).filter((n) => n.disabled !== true && !isPureNode(n) && !isLoopDriver(n));
}

/**
 * `scenario create`: write a committed, hand-editable **scenario**
 * `scenarios/<slug>.json` (execution-shaped, so `simulate/test --scenario <slug>`
 * read it verbatim). Two seeds, composable:
 *  - `--execution <id>`: promote the gitignored capture into the scenario; nodes
 *    with captured output are provenance `capture`, each remaining *gap* (a
 *    network node reached with no data) is listed under `_decanterScenario.fill`.
 *  - `--scaffold` (a `prepare_test_pin_data` result): annotate every gap with its
 *    output `expectedSchema` (provenance `scaffolded`); with no `--execution`,
 *    *every* pinnable node becomes a scaffolded fill entry (a from-scratch set).
 * **No LLM is ever called** and **no values are invented** — the CLI only
 * scaffolds fill entries; a person/agent authors the values and reviews them in
 * the diff. Refuses to clobber an existing scenario. Returns the gap node names.
 */
export async function writeScenario(
  dir: string,
  opts: { execId?: string; slug: string; scaffold?: PinDataScaffold },
  log: Log,
): Promise<{ slug: string; file: string; gaps: string[]; coverage?: PinDataScaffold["coverage"] }> {
  const name = kebabCase(opts.slug);
  const scenarioFile = path.join(dir, SCENARIOS_DIR, `${name}.json`);
  if (existsSync(scenarioFile)) {
    throw new Error(`scenario "${name}" already exists: ${path.relative(process.cwd(), scenarioFile)} — edit it directly, or delete it to regenerate`);
  }
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`no workflow.json in ${dir} — pull the workflow first`);
  const wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;

  // Schema oracle (--scaffold): node name → output JSON Schema (or the no-schema hint).
  const schemaByNode = new Map<string, unknown>();
  if (opts.scaffold) {
    for (const [node, schema] of Object.entries(opts.scaffold.nodeSchemasToGenerate)) schemaByNode.set(node, schema);
    for (const node of opts.scaffold.nodesWithoutSchema) if (!schemaByNode.has(node)) schemaByNode.set(node, NO_SCHEMA_HINT);
  }

  let baseExec: Execution & { workflowData?: unknown };
  let gaps: GapContext[];
  let overallSource: ScenarioMeta["source"];
  if (opts.execId !== undefined) {
    const rawFile = path.join(dir, EXECUTIONS_DIR, `${opts.execId}.json`);
    if (!existsSync(rawFile)) {
      throw new Error(`execution ${opts.execId} not captured under ${EXECUTIONS_DIR}/ — fetch it first: n8n-decanter <ref> executions`);
    }
    try {
      baseExec = JSON.parse(readFileSync(rawFile, "utf8")) as Execution;
    } catch (err) {
      throw new Error(`corrupt capture ${rawFile} (${(err as Error).message})`);
    }
    // Discover gaps from the raw capture (source=capture; the scenario doesn't exist yet).
    gaps = await detectGaps(dir, opts.execId, log, "capture");
    overallSource = opts.scaffold ? "capture+scaffold" : "capture";
  } else {
    // Pure scaffold: no capture — every pinnable node is a gap to author.
    if (!opts.scaffold) {
      throw new Error("scenario create with no --execution needs --scaffold — or fetch a capture first with `n8n-decanter <ref> executions`");
    }
    baseExec = { id: name, mode: "manual", workflowVersionId: typeof wf.versionId === "string" ? wf.versionId : undefined, data: { resultData: { runData: {} } } } as unknown as Execution;
    gaps = pinnableNodes(wf).map((n) => ({ node: n.name, type: n.type, parameters: n.parameters, input: [] }));
    overallSource = "scaffold";
  }

  const fill = gaps.map((g) => {
    const schema = schemaByNode.get(g.node);
    return { node: g.node, type: g.type, parameters: g.parameters, inputSample: g.input.map((i) => i.json), ...(schema !== undefined ? { expectedSchema: schema } : {}) };
  });
  const wfVersion = typeof (baseExec as { workflowVersionId?: unknown }).workflowVersionId === "string"
    ? (baseExec as { workflowVersionId: string }).workflowVersionId
    : (typeof wf.versionId === "string" ? wf.versionId : undefined);
  const meta: ScenarioMeta = {
    source: overallSource,
    ...(opts.execId !== undefined ? { sourceExecution: opts.execId } : {}),
    createdAt: new Date().toISOString().slice(0, 10),
    ...(wfVersion !== undefined ? { workflowVersionId: wfVersion } : {}),
    guidance: gaps.length > 0
      ? `Scenario pin data — synthetic, not a full real capture. For each node in "fill", add data.resultData.runData["<node>"] = [ { "data": { "main": [ [ { "json": { …the output it should emit… } } ] ] } } ], using its type/parameters/inputSample${opts.scaffold ? "/expectedSchema" : ""} as context. Keep the "fill" list as-is — it records which nodes are synthetic (provenance) and is what "scenario check" validates. Validate offline: n8n-decanter <workflow> scenario check ${name}. Then replay: n8n-decanter <workflow> simulate --scenario ${name}.`
      : `Committed, reproducible copy of capture ${opts.execId} — no gaps to fill.`,
    fill,
  };
  mkdirSync(path.dirname(scenarioFile), { recursive: true });
  // Strip the capture's embedded workflowData: nothing reads it, and it
  // carries every Code node's inline jsCode — committing it would duplicate
  // node source in git, violating the snapshot invariant (Plan 33; the
  // compliance guard warns about legacy scenarios that still embed it).
  const { workflowData: _dropped, ...cleanExec } = baseExec;
  writeFileSync(scenarioFile, JSON.stringify({ ...cleanExec, _decanterScenario: meta }, null, 2) + "\n");

  const rel = path.relative(process.cwd(), scenarioFile);
  const seededFrom = opts.execId !== undefined ? `capture ${opts.execId}` : "workflow schemas";
  if (gaps.length > 0) {
    log.info(`scenario "${name}" written from ${seededFrom} -> ${rel}`);
    if (opts.scaffold) log.info(`scaffold coverage: ${opts.scaffold.coverage.withSchemaFromExecution + opts.scaffold.coverage.withSchemaFromDefinition} with schema, ${opts.scaffold.coverage.withoutSchema} without, ${opts.scaffold.coverage.skipped} run for real (of ${opts.scaffold.coverage.total})`);
    log.warn(`author runData for ${gaps.length} node${gaps.length === 1 ? "" : "s"}: ${gaps.map((g) => g.node).join(", ")} — see "_decanterScenario", validate with \`scenario check ${name}\`, then \`simulate --scenario ${name}\``);
  } else {
    log.ok(`scenario "${name}" written from ${seededFrom} -> ${rel} — no gaps; replay with \`simulate --scenario ${name}\``);
  }
  if (opts.execId !== undefined) log.warn("scenario copies real captured data — review for credentials/PII before committing");
  return { slug: name, file: scenarioFile, gaps: gaps.map((g) => g.node), coverage: opts.scaffold?.coverage };
}

/** The slugs of the committed scenarios in a workflow folder (sorted). */
export function listScenarioSlugs(dir: string): string[] {
  const scenariosDir = path.join(dir, SCENARIOS_DIR);
  if (!existsSync(scenariosDir)) return [];
  return readdirSync(scenariosDir).filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -5)).sort();
}

/**
 * `scenario check`: structurally validate one scenario (or every scenario in the
 * folder, when `slug` is undefined) offline — the fast agent-loop check that
 * doesn't need Docker. Parses the file and runs `validateScenarioRunData`; logs
 * OK / the node-named error per scenario. Returns the number of invalid ones.
 */
export function checkScenarios(dir: string, slug: string | undefined, log: Log): number {
  const slugs = slug !== undefined ? [kebabCase(slug)] : listScenarioSlugs(dir);
  if (slugs.length === 0) {
    log.info(slug !== undefined ? `no scenario "${slug}" under ${SCENARIOS_DIR}/` : `no scenarios under ${SCENARIOS_DIR}/ — create one with: n8n-decanter <workflow> scenario create`);
    return 0;
  }
  let invalid = 0;
  for (const s of slugs) {
    const file = path.join(dir, SCENARIOS_DIR, `${s}.json`);
    if (!existsSync(file)) { log.error(`scenario "${s}": not found under ${SCENARIOS_DIR}/`); invalid++; continue; }
    try {
      const exec = JSON.parse(readFileSync(file, "utf8")) as Execution;
      validateScenarioRunData(exec, s);
      log.ok(`scenario "${s}": valid`);
    } catch (err) {
      log.error((err as Error).message);
      invalid++;
    }
  }
  return invalid;
}

/** Remove a node's `credentials` block (mutates + returns it). */
function stripCredentials<T extends WorkflowNode>(node: T): T {
  delete (node as { credentials?: unknown }).credentials;
  return node;
}

/** Throw if any node carries credentials or is an off-allowlist executable node. */
export function assertDryRunSafe(wf: Workflow): void {
  for (const node of wf.nodes) {
    if ((node as { credentials?: unknown }).credentials !== undefined) {
      throw new Error(`simulation refused: node "${node.name}" still carries credentials`);
    }
    if (node.name === SIM_START_NODE || node.disabled === true) continue;
    if (!isPureNode(node) && !isLoopDriver(node)) {
      throw new Error(`simulation refused: node "${node.name}" (${node.type}) is not on the pure allowlist and was not pinned`);
    }
  }
}

/** One pure node's replayed output vs the capture — the regression signal. */
export interface NodeDiff {
  node: string;
  equal: boolean;
  /** Captured item `.json` payloads (what the diff expects). */
  expected: unknown[];
  /** Engine-replayed item `.json` payloads. */
  actual: unknown[];
}

/** Full result of a `simulate` run — the report the verb prints / emits as JSON. */
export interface SimulationReport {
  execId: string;
  version: string;
  networkNone: boolean;
  /** Trigger + network nodes pinned to captured output. */
  pinned: string[];
  /** Pure nodes that executed for real. */
  pure: string[];
  /** Loop-driver nodes that ran for real (single-iteration loops); not diffed. */
  loops: string[];
  /**
   * True when the scenario carries any non-`capture` (authored/scaffolded) pins
   * (Plan 37): the run proves **executability, not output correctness** — no
   * per-node diff is asserted and `ok` reflects only that the engine ran clean.
   */
  syntheticPins: boolean;
  /** Per-node provenance of the pinned/pure nodes (`capture`/`authored`/`scaffolded`). */
  provenance: Record<string, Provenance>;
  /** Per-pure-node diffs of replay vs capture (only `capture`-provenance nodes are asserted). */
  diffs: NodeDiff[];
  /** Names of nodes whose replayed output diverged from the capture. */
  divergent: string[];
  /** True when the engine reported the run itself as successful. */
  engineOk: boolean;
  engineError?: string;
  /** Overall pass: engine ran clean AND (for capture scenarios) nothing diverged. Meaningless when `bestEffortLoop`. */
  ok: boolean;
  /**
   * Tier-2 (viewer-only): this run is a best-effort *iteration 1 of `loopIterations`*
   * of a multi-batch loop — display-only, **never a pass/fail check**. There is no
   * diff (`diffs`/`divergent` are empty) and `ok` must not be read as "verified".
   */
  bestEffortLoop?: boolean;
  /** Tier-2: total batches the loop ran in the capture (the "of N"). */
  loopIterations?: number;
  /** Viewer mode: URL of the saved run in the kept-alive local n8n UI. */
  url?: string;
  /** Viewer mode: local login for that throwaway instance (n8n requires auth). */
  login?: { email: string; password: string };
}

/**
 * Diff policy (v1): exact compare of item `json` payloads, key-order-insensitive
 * (stable stringify, like the structure hash); `pairedItem`/metadata excluded.
 * Nondeterministic node output ($now, Math.random, new Date()) legitimately
 * diverges — a documented failure mode, not masked.
 */
export function diffItems(expected: RunItem[], actual: RunItem[]): boolean {
  const json = (items: RunItem[]) => items.map((i) => i.json);
  return canonicalJson(json(expected)) === canonicalJson(json(actual));
}

/**
 * Build the simulation, run it through the real engine, and diff each pure
 * node's replayed output against the capture. The engine run needs Docker (the
 * caller should have checked `dockerAvailable`); everything else is offline.
 */
export async function runSimulation(
  dir: string,
  ref: string,
  opts: { version: string; source?: SimSource; networkNone?: boolean; viewer?: boolean },
  log: Log,
): Promise<SimulationReport> {
  // Viewer mode opts into tier-2: a multi-batch loop becomes a best-effort
  // "iteration 1 of N" instead of a hard error (headless/CI still hard-errors).
  const src: SimSource = opts.source ?? "capture";
  const sim = await buildSimulation(dir, ref, log, { source: src, allowMultiBatch: opts.viewer === true });
  // Provenance (Plan 37): a scenario with any authored/scaffolded node proves
  // executability only — the per-node diff below asserts capture-provenance
  // nodes exclusively, and divergence never fails a synthetic run.
  const { exec } = readCapture(dir, ref, src);
  const provenanceMap = scenarioProvenance(exec);
  const syntheticPins = src === "scenario" && scenarioIsSynthetic(exec);
  const base = {
    execId: ref, version: opts.version, networkNone: opts.networkNone === true,
    pinned: sim.pinned, pure: sim.pure, loops: sim.loops,
    syntheticPins, provenance: Object.fromEntries(provenanceMap),
  };

  // Tier-2 is display-only: there's no faithful diff for N>1 (pinning is
  // single-valued), so skip the headless diff run entirely and only launch the
  // browsable viewer. Never a pass/fail check — `ok` here is not "verified".
  if (sim.bestEffortLoop) {
    const viewer = opts.viewer ? await startViewer(sim.workflow, { version: opts.version }, log).catch((err: Error) => {
      log.warn(`could not start the browsable viewer (${err.message})`);
      return undefined;
    }) : undefined;
    return {
      ...base, diffs: [], divergent: [], engineOk: true, ok: true,
      bestEffortLoop: true, loopIterations: sim.loopIterations,
      url: viewer?.url, login: viewer?.login,
    };
  }

  // The diff always comes from a fast, throwaway headless run. Viewer mode
  // additionally launches a kept-alive local n8n so the run is browsable in the
  // webapp (interactive only; not with --network-none, which has no port).
  const run = await runEngine(sim.workflow, { version: opts.version, networkNone: opts.networkNone }, log);
  const viewer = opts.viewer ? await startViewer(sim.workflow, { version: opts.version }, log).catch((err: Error) => {
    log.warn(`could not start the browsable viewer (${err.message}); the simulation result above still stands`);
    return undefined;
  }) : undefined;
  const diffs: NodeDiff[] = [];
  for (const node of sim.pure) {
    if ((provenanceMap.get(node) ?? "capture") !== "capture") continue; // only assert capture-provenance nodes
    const expected = sim.captured.get(node);
    if (!expected) continue; // node didn't run in the capture — nothing to compare
    const actual = run.runData.get(node) ?? [];
    diffs.push({ node, equal: diffItems(expected, actual), expected: expected.map((i) => i.json), actual: actual.map((i) => i.json) });
  }
  const divergent = diffs.filter((d) => !d.equal).map((d) => d.node);
  return {
    ...base, diffs, divergent,
    engineOk: run.ok, engineError: run.error,
    // synthetic pins prove executability only — divergence is informational, not a fail
    ok: run.ok && (syntheticPins || divergent.length === 0),
    url: viewer?.url, login: viewer?.login,
  };
}
