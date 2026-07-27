// The `diff` verb (Plan 59) and the minimal unified line diff behind it
// (plans/3 B). Zero deps by design (Plan 11's rule); classic LCS backtracking
// is plenty at Code-node scale, with a size cutoff instead of a fancier
// algorithm.
//
// `diff` is the `git diff` half of the old `status` verb: it shows the actual
// changed LINES for every node that differs from the draft, and nothing else.
// The summary half (`git status`) is `preflight`. Like `git diff` it is an
// inspection view, not a gate — it always exits 0.
import path from "node:path";
import { getWorkflowDetails, type McpClient } from "./mcp.mts";
import { findWorkflowDir } from "./state.mts";
import { computeSyncFacts, type NodeSync } from "./status.mts";
import { style } from "./style.mts";
import type { Log } from "./types.mts";

interface Op {
  tag: " " | "-" | "+";
  line: string;
  /** 1-based position in a/b at the time this op is emitted. */
  aLine: number;
  bLine: number;
}

function toLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline is not a line
  return lines;
}

/**
 * Unified-style diff of `a` (rendered as `-`) vs `b` (`+`), with `@@` hunk
 * headers and `context` unchanged lines around each change. Returns [] when
 * the inputs are line-identical. The hunk numbers are informational — this
 * diff is for reading, not for `patch`.
 */
export function unifiedDiff(a: string, b: string, context = 2): string[] {
  const al = toLines(a);
  const bl = toLines(b);
  const n = al.length;
  const m = bl.length;
  if (n * m > 4_000_000) return ["(diff too large to render — contents differ)"];

  // dp[i][j] = LCS length of al[i..] vs bl[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) ops.push({ tag: " ", line: al[i], aLine: ++i, bLine: ++j });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ tag: "-", line: al[i], aLine: ++i, bLine: j + 1 });
    else ops.push({ tag: "+", line: bl[j], aLine: i + 1, bLine: ++j });
  }
  while (i < n) ops.push({ tag: "-", line: al[i], aLine: ++i, bLine: j + 1 });
  while (j < m) ops.push({ tag: "+", line: bl[j], aLine: i + 1, bLine: ++j });

  const changed = ops.flatMap((op, idx) => (op.tag === " " ? [] : [idx]));
  if (changed.length === 0) return [];

  // group changes whose context windows touch into hunks
  const hunks: Array<[number, number]> = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (const c of changed.slice(1)) {
    if (c - context <= end + 1) end = Math.min(ops.length - 1, c + context);
    else {
      hunks.push([start, end]);
      start = Math.max(0, c - context);
      end = Math.min(ops.length - 1, c + context);
    }
  }
  hunks.push([start, end]);

  const out: string[] = [];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const aCount = slice.filter((o) => o.tag !== "+").length;
    const bCount = slice.filter((o) => o.tag !== "-").length;
    out.push(`@@ -${slice[0].aLine},${aCount} +${slice[0].bLine},${bCount} @@`);
    for (const o of slice) out.push(o.tag + o.line);
  }
  return out;
}

/** A node whose local build differs from the draft — the only thing `diff` prints. */
function isDifferent(node: NodeSync): boolean {
  return node.state !== "in-sync";
}

/** One node's state headline; the line diff (when there is one) follows it. */
function headline(node: NodeSync): { level: "info" | "warn" | "error"; text: string } {
  switch (node.state) {
    case "unknown-locally":
      return { level: "warn", text: "remote code node unknown locally — pull" };
    case "local-missing":
      return { level: "warn", text: `local file ${node.file} missing` };
    case "changed-remotely":
      return { level: "warn", text: "changed remotely — pull" };
    case "conflict":
      return { level: "error", text: "CONFLICT — changed both locally and remotely" };
    default:
      return { level: "info", text: `local changes in ${node.file} — push pending` };
  }
}

/**
 * Print the per-node line diffs between local code and the n8n draft. For `.ts`
 * nodes the local side is the **compiled** JS — the exact bytes `push` would
 * send, and the same bodies the sync hashes compare.
 *
 * Always exits 0 (the caller sets no exit code): this is `git diff`, not a
 * gate. `preflight` is the gate.
 */
export async function diffWorkflow(mcp: McpClient, root: string, id: string, log: Log): Promise<void> {
  const remote = await getWorkflowDetails(mcp, id);
  const dir = findWorkflowDir(root, id, log);
  if (!dir) {
    log.warn(`${remote.name} (${id}): not pulled yet — n8n-decanter pull ${id}`);
    return;
  }
  log.info(`${remote.name} (${id})  [${path.relative(process.cwd(), dir)}]`);

  const facts = await computeSyncFacts(remote, dir);
  const changed = facts.nodes.filter(isDifferent);
  if (changed.length === 0 && facts.deleted.length === 0) {
    log.info(style.dim("  no differences — every tracked node matches the draft"));
    return;
  }

  for (const node of changed) {
    // Replay this node's captured compileTs warnings before its line — they are
    // about the very build being diffed.
    for (const w of node.warnings ?? []) log.warn(w);
    const { level, text } = headline(node);
    log[level](`  ${node.name}: ${text}`);
    if (node.remoteBody === undefined || node.localBody === undefined || node.localBody === null || node.file === undefined) continue;
    log.info(`    ${style.dim("--- remote (n8n)")}`);
    log.info(`    ${style.dim(`+++ local (${node.file})`)}`);
    for (const line of unifiedDiff(node.remoteBody, node.localBody)) {
      const styled = line.startsWith("+") ? style.green(line) : line.startsWith("-") ? style.red(line) : style.dim(line);
      log.info(`    ${styled}`);
    }
  }

  for (const node of facts.deleted) {
    log.warn(`  ${node.file}: node ${node.id} deleted remotely`);
  }
}
