// Plan 7 — engine-true simulation, offline half: fixture loader + route-B
// workflow transform. Given a captured execution, produce a *copy* of the
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
import { EXECUTIONS_DIR, warnStaleFixtures } from "./executions.mts";
import { buildNodeCode } from "./push.mts";
import { readState } from "./state.mts";
import type { Execution, Log, Workflow, WorkflowNode } from "./types.mts";
import { canonicalJson, forEachConnectionTarget, isJsCodeNode, kebabCase, placeholderFile } from "./util.mts";

export const FIXTURES_DIR = "fixtures";
/** Name of the synthetic Manual Trigger the transform prepends as the entry point. */
export const SIM_START_NODE = "__sim_start__";

/**
 * Side-effect-free node types that execute for real in a simulation. Curated,
 * versioned, and **default-deny**: any type NOT in this set is treated as a
 * network node and pinned — safety never depends on knowing a type. Additions
 * need justification (misclassifying a node as pure runs it for real).
 * Seed list signed off 2026-07-20 (Plan 7 task 2). Deliberately excluded though
 * side-effect-free: `splitInBatches` (loop driver), `wait` (time semantics),
 * `executeWorkflow` (crosses the workflow boundary).
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

/** One item as it appears in captured/replayed run data (`.json` payload + link). */
export interface RunItem {
  json?: unknown;
  pairedItem?: unknown;
  [key: string]: unknown;
}

/**
 * A committed, provenance-stamped fixture — `fixtures/<sanitized>.json`. Keyed
 * to a node by its `node` field (not the filename, which is lossy). Written by
 * `simulate --pin` (and, once shipped, `--guess-gaps`; Plan 7 tasks 3/6); read
 * here like a capture, taking precedence over `executions/` temp data.
 */
export interface Fixture {
  /** Where the items came from — a real capture or an LLM guess (aging, flagged). */
  source: "capture" | "llm-guess";
  /** Exact node name these items pin. */
  node: string;
  execId?: string | number;
  workflowVersionId?: string;
  date?: string;
  /** Set for llm-guess: the node params hash the guess was made against (staleness). */
  nodeParamsHash?: string;
  items: RunItem[];
}

/** The transform's output — the sim workflow plus what the verb needs to diff. */
export interface Simulation {
  /** The transformed copy, ready for `n8n import:workflow` + `execute`. */
  workflow: Workflow;
  /** Node names replaced with pinned captured output (triggers + network nodes). */
  pinned: string[];
  /** Node names that execute for real (pure allowlist). */
  pure: string[];
  /** Per-node captured items, for diffing the engine's output against (task 3). */
  captured: Map<string, RunItem[]>;
}

type NodeRun = { data?: { main?: Array<Array<RunItem> | null> } };
type RunData = Record<string, NodeRun[]>;

/** Pull the `resultData.runData` map out of a capture, validating shape defensively. */
function runDataOf(exec: Execution, execId: string): RunData {
  const rd = (exec as { data?: { resultData?: { runData?: unknown } } }).data?.resultData?.runData;
  if (!rd || typeof rd !== "object" || Array.isArray(rd)) {
    throw new Error(`execution ${execId}: no resultData.runData object — capture is empty or malformed (re-fetch with "executions")`);
  }
  return rd as RunData;
}

/** Items a node emitted on its first run, first output — `[]` if it emitted none. */
function firstRunItems(runs: NodeRun[] | undefined): RunItem[] | undefined {
  if (!runs || runs.length === 0) return undefined;
  const main = runs[0]?.data?.main;
  if (!Array.isArray(main)) return [];
  const first = main[0];
  return Array.isArray(first) ? first : [];
}

/** Read + validate one capture file from `<dir>/executions/<execId>.json`. */
function readCapture(dir: string, execId: string): { exec: Execution; runData: RunData } {
  const file = path.join(dir, EXECUTIONS_DIR, `${execId}.json`);
  if (!existsSync(file)) {
    throw new Error(`execution ${execId} not captured under ${path.join(path.basename(dir), EXECUTIONS_DIR)}/ — fetch it first: n8n-decanter <ref> executions`);
  }
  let exec: Execution;
  try {
    exec = JSON.parse(readFileSync(file, "utf8")) as Execution;
  } catch (err) {
    throw new Error(`corrupt capture ${file} (${(err as Error).message})`);
  }
  return { exec, runData: runDataOf(exec, execId) };
}

/** Load committed fixtures, keyed by their `node` field. Corrupt files throw by name. */
function readFixtures(dir: string): Map<string, Fixture> {
  const out = new Map<string, Fixture>();
  const fixturesDir = path.join(dir, FIXTURES_DIR);
  if (!existsSync(fixturesDir)) return out;
  for (const entry of readdirSync(fixturesDir)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(fixturesDir, entry);
    let fixture: Fixture;
    try {
      fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    } catch (err) {
      throw new Error(`corrupt fixture ${file} (${(err as Error).message})`);
    }
    if (typeof fixture.node !== "string" || !Array.isArray(fixture.items)) {
      throw new Error(`fixture ${file}: must have a string "node" and an "items" array`);
    }
    out.set(fixture.node, fixture);
  }
  return out;
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

/** JS body for a name-preserving replacement node: emit the captured items verbatim. */
function emitCode(items: RunItem[]): string {
  const payload = items.map((it) => (it.pairedItem !== undefined ? { json: it.json, pairedItem: it.pairedItem } : { json: it.json }));
  return `return ${JSON.stringify(payload)};\n`;
}

/** JS body for a neutralized (untaken/disabled) network node: fail loudly if reached. */
function guardCode(name: string): string {
  return `throw new Error(${JSON.stringify(`[decanter simulate] network node "${name}" has no captured or fixture data and was reached unexpectedly — re-capture the execution or pin a fixture`)});\n`;
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
 * Throws on the plan's hard errors: unpinnable gaps, multi-run (loop) captures,
 * or a surviving off-allowlist executable node.
 */
export async function buildSimulation(dir: string, execId: string, log: Log): Promise<Simulation> {
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`no workflow.json in ${dir} — pull the workflow first`);
  const wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  if (readState(dir) === null) throw new Error(`no .decanter.json in ${dir} — pull the workflow first`);

  const { exec, runData } = readCapture(dir, execId);
  warnStaleFixtures(dir, [exec], log);
  const fixtures = readFixtures(dir);

  // Multi-run (loop) capture → out of scope for v1 (Non-goals).
  const multiRun = Object.entries(runData).filter(([, runs]) => Array.isArray(runs) && runs.length > 1).map(([n]) => n);
  if (multiRun.length > 0) {
    throw new Error(`loop workflows are out of scope (v1): node(s) ran more than once in ${execId} — ${multiRun.join(", ")}`);
  }

  // Resolve each node's pinned items: fixture (committed) over capture (temp).
  const itemsFor = (name: string): RunItem[] | undefined => {
    const fixture = fixtures.get(name);
    if (fixture) return fixture.items;
    return firstRunItems(runData[name]);
  };

  const captured = new Map<string, RunItem[]>();
  const pinned: string[] = [];
  const pure: string[] = [];
  const gaps: string[] = [];
  const nodes: WorkflowNode[] = [];

  for (const node of wf.nodes) {
    const disabled = node.disabled === true;
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
      gaps.push(node.name); // reached in capture but no data → real gap
      nodes.push(replacementNode(node, guardCode(node.name)));
    } else {
      // Untaken branch or disabled: neutralize, but don't demand data for it.
      nodes.push(replacementNode(node, guardCode(node.name)));
    }
  }

  if (gaps.length > 0) {
    throw new Error(`no captured output for network node(s): ${gaps.join(", ")} — pin a fixture (fixtures/<node>.json) or re-capture an execution that exercises them`);
  }

  // Prepend a synthetic Manual Trigger wired to every entry node (no input edge),
  // giving `n8n execute` a valid CLI entry point (the spike's route-B recipe).
  const targets = connectedTargets(wf.connections);
  const entries = nodes.filter((n) => n.disabled !== true && !targets.has(n.name)).map((n) => n.name);
  const startNode: WorkflowNode = {
    id: SIM_START_NODE, name: SIM_START_NODE, type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1, position: [-260, 0], parameters: {},
  };
  const connections: Record<string, unknown> = structuredClone(wf.connections) ?? {};
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

  log.info(`simulation: ${pure.length} node(s) execute for real, ${pinned.length} pinned from capture ${execId}`);
  return { workflow: simWorkflow, pinned, pure, captured };
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
    if (!isPureNode(node)) {
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
  /** Per-pure-node diffs of replay vs capture. */
  diffs: NodeDiff[];
  /** Names of nodes whose replayed output diverged from the capture. */
  divergent: string[];
  /** True when the engine reported the run itself as successful. */
  engineOk: boolean;
  engineError?: string;
  /** Overall pass: engine ran clean AND nothing diverged. */
  ok: boolean;
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
  execId: string,
  opts: { version: string; networkNone?: boolean; viewer?: boolean },
  log: Log,
): Promise<SimulationReport> {
  const sim = await buildSimulation(dir, execId, log);
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
    const expected = sim.captured.get(node);
    if (!expected) continue; // node didn't run in the capture — nothing to compare
    const actual = run.runData.get(node) ?? [];
    diffs.push({ node, equal: diffItems(expected, actual), expected: expected.map((i) => i.json), actual: actual.map((i) => i.json) });
  }
  const divergent = diffs.filter((d) => !d.equal).map((d) => d.node);
  return {
    execId, version: opts.version, networkNone: opts.networkNone === true,
    pinned: sim.pinned, pure: sim.pure, diffs, divergent,
    engineOk: run.ok, engineError: run.error, ok: run.ok && divergent.length === 0,
    url: viewer?.url, login: viewer?.login,
  };
}

/**
 * `simulate --pin`: copy the capture's network-node outputs into committed,
 * provenance-stamped `fixtures/<node>.json` files, so a gitignored capture
 * becomes a reproducible, reviewable fixture. Warns about PII — execution data
 * can hold credentials/personal data (why `executions/` is gitignored).
 */
export function pinFixtures(dir: string, execId: string, log: Log): void {
  const wfFile = path.join(dir, "workflow.json");
  if (!existsSync(wfFile)) throw new Error(`no workflow.json in ${dir} — pull the workflow first`);
  const wf = JSON.parse(readFileSync(wfFile, "utf8")) as Workflow;
  const { exec, runData } = readCapture(dir, execId);
  const fixturesDir = path.join(dir, FIXTURES_DIR);
  mkdirSync(fixturesDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  let pinned = 0;
  for (const node of wf.nodes) {
    if (isPureNode(node)) continue; // only network nodes get pinned
    const items = firstRunItems(runData[node.name]);
    if (!items) continue;
    const fixture: Fixture = {
      source: "capture", node: node.name, execId,
      workflowVersionId: typeof exec.workflowVersionId === "string" ? exec.workflowVersionId : undefined,
      date, items,
    };
    const file = path.join(fixturesDir, `${kebabCase(node.name)}.json`);
    writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
    log.info(`pinned ${node.name} -> ${path.relative(process.cwd(), file)}`);
    pinned++;
  }
  if (pinned === 0) {
    log.warn(`no network nodes with captured output in execution ${execId} — nothing to pin`);
    return;
  }
  log.warn("review pinned fixtures before committing — execution data can contain credentials/PII");
  log.ok(`pinned ${pinned} node${pinned === 1 ? "" : "s"} from execution ${execId} into ${FIXTURES_DIR}/`);
}
