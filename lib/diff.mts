// Minimal unified line diff for `status --diff` (plans/3 B). Zero deps by
// design (Plan 11's rule); classic LCS backtracking is plenty at Code-node
// scale, with a size cutoff instead of a fancier algorithm.

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
