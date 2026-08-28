import { createHash } from "node:crypto";
import type { JsCodeNode, Workflow, WorkflowNode, WorkflowPut } from "./types.mts";

export const CODE_NODE_TYPE = "n8n-nodes-base.code";
export const FILE_PLACEHOLDER_PREFIX = "//@file:";
/** Subdir inside a workflow folder that holds the node source files. */
export const CODE_DIR = "code";
/**
 * Line 1 of a compiled TS push (Plan 84). The literal prefix is the anchor:
 * `splitMarker` matches it at offset 0, so a node body that merely *starts*
 * with a `//` comment of the user's own is never mistaken for a marker.
 */
const MARKER_LINE_PREFIX = "// n8n-decanter · ";
/** Field separator on the marker line — a middot, so no field can contain it. */
const MARKER_SEP = " · ";
/** The words that make line 1 worth reading for whoever found it in the n8n UI. */
const DO_NOT_EDIT = "do not edit here";

/** True for Code nodes whose source is JavaScript (the only kind we extract). */
export function isJsCodeNode(node: WorkflowNode | null | undefined): node is JsCodeNode {
  return (
    node?.type === CODE_NODE_TYPE &&
    typeof node.parameters?.jsCode === "string" &&
    (node.parameters.language === undefined || node.parameters.language === "javaScript")
  );
}

export function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/** Where the `@ts-n8n` marker sat in a jsCode payload. */
export type MarkerPosition = "leading" | "trailing";

/** What a marker line says about the artifact below it. */
export interface Provenance {
  /** Node source path, relative to the SYNC DIR (never hashed — it follows renames). */
  sourcePath: string;
  /** CLI version that built it, without the leading `v`. */
  cliVersion?: string | null;
  /** Short HEAD sha, `+dirty` when the tree carried uncommitted changes. */
  commit?: string | null;
  /** Build time, UTC, minute precision (`2026-08-20T09:14Z`). */
  at?: string | null;
}

export interface SplitMarker {
  /** Everything except the marker line, byte-exactly — what the hash covers. */
  body: string;
  /** The marker line itself, or null when there is none. */
  marker: string | null;
  /** `sha256:<hex>` carried by the marker, or null. */
  markerHash: string | null;
  /** Which position it was found in — null when there is no marker. */
  where: MarkerPosition | null;
  /** Source path off a leading marker; null for the legacy trailing form. */
  sourcePath: string | null;
}

/**
 * Split the `@ts-n8n sha256:<hex>` marker off a jsCode string, from EITHER
 * position (Plan 84).
 *
 * **Leading** is the only form push writes: line 1, `// n8n-decanter · <path>
 * · do not edit here · @ts-n8n sha256:… · v… <commit> <time>`. **Trailing** is
 * the pre-Plan-84 form, matched unchanged — and that branch is permanent, not
 * a transition: a node not pushed for a year still has it, and reading it as
 * in-sync is what makes the relocation a non-event (no migration, no mass
 * re-push).
 *
 * `body` keeps everything except the marker line byte-exactly, so
 * `sha256(body)` matches the hash computed at push time in both forms. The
 * marker line is outside its own hash either way — which is why a rename, a
 * new commit or a CLI bump can never make a node look changed.
 */
export function splitMarker(code: string): SplitMarker {
  if (code.startsWith(MARKER_LINE_PREFIX)) {
    const nl = code.indexOf("\n");
    const line = nl === -1 ? code : code.slice(0, nl);
    const hash = line.match(/(?:^|\s)@ts-n8n (sha256:[0-9a-f]{64})(?:\s|$)/);
    if (hash) {
      // fields[0] is the path — the tool name is the prefix already stripped.
      const fields = line.slice(MARKER_LINE_PREFIX.length).split(MARKER_SEP);
      return {
        body: nl === -1 ? "" : code.slice(nl + 1),
        marker: line,
        markerHash: hash[1],
        where: "leading",
        sourcePath: fields.length > 1 ? fields[0] : null,
      };
    }
    // A line-1 comment that only LOOKS like ours (no valid sha) is body, not a
    // marker — fall through, so a trailing marker below it is still found.
  }
  const m = code.match(/(?:^|\n)(\/\/ @ts-n8n (sha256:[0-9a-f]{64}))[ \t]*\n?[ \t\n]*$/);
  if (!m) return { body: code, marker: null, markerHash: null, where: null, sourcePath: null };
  const start = m.index! + (m[0].startsWith("\n") ? 1 : 0);
  return { body: code.slice(0, start), marker: m[1], markerHash: m[2], where: "trailing", sourcePath: null };
}

/**
 * Render line 1 for a compiled artifact.
 *
 * Human facts first, machine facts last — reading left to right you stop
 * caring at exactly the point the data stops being for you. `@ts-n8n` stays
 * the token (mid-line now) so a single `grep -r @ts-n8n` keeps finding both
 * forms. The build stamp degrades field by field, and vanishes entirely when
 * nothing about the build is knowable (no git repo, unreadable package.json).
 */
export function renderMarkerLine(prov: Provenance, hash: string): string {
  const stamp = [prov.cliVersion ? "v" + prov.cliVersion : null, prov.commit, prov.at].filter((f) => f).join(" ");
  const fields = [prov.sourcePath, DO_NOT_EDIT, `@ts-n8n ${hash}`];
  if (stamp !== "") fields.push(stamp);
  // The prefix already ends in the separator — it is the anchor `splitMarker`
  // matches at offset 0, so it has to be one fixed literal, not a joined field.
  return MARKER_LINE_PREFIX + fields.join(MARKER_SEP);
}

/** Build the jsCode payload for a TS-managed node from compiled JS. */
export function withMarker(compiledJs: string, prov: Provenance): { jsCode: string; hash: string } {
  const body = compiledJs.endsWith("\n") ? compiledJs : compiledJs + "\n";
  const hash = sha256(body);
  return { jsCode: renderMarkerLine(prov, hash) + "\n" + body, hash };
}

/** File a `//@file:` placeholder points at, or null for inline code. */
export function placeholderFile(node: JsCodeNode): string | null {
  const jsCode = node.parameters.jsCode;
  if (!jsCode.startsWith(FILE_PLACEHOLDER_PREFIX)) return null;
  return jsCode.slice(FILE_PLACEHOLDER_PREFIX.length).trim();
}

/**
 * Walk every `{ node: … }` target in a connections object (the four-level
 * source → type → group → target nesting), calling `cb` for each target
 * object. Non-object levels are skipped defensively.
 */
export function forEachConnectionTarget(
  connections: Record<string, unknown>,
  cb: (target: { node?: unknown }, source: string, type: string, outputIndex: number) => void,
): void {
  for (const [source, byType] of Object.entries(connections)) {
    if (!byType || typeof byType !== "object") continue;
    for (const [type, groups] of Object.entries(byType as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      // The group index IS the source node's output index — an IF's group 0 is
      // its "true" branch, group 1 its "false" branch. It was in scope here all
      // along and never passed on, so every caller silently read output 0
      // (Plan 63 task 4).
      for (const [outputIndex, group] of groups.entries()) {
        if (!Array.isArray(group)) continue;
        for (const target of group) {
          if (target && typeof target === "object") cb(target as { node?: unknown }, source, type, outputIndex);
        }
      }
    }
  }
}

/** Sanitize a workflow/node name for use as a file or folder name. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, "-")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from filenames is intentional.
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .replace(/\.+$/, "");
  return cleaned || "unnamed";
}

/** A node reference found in source or an expression. */
export interface NodeRef {
  /** The node name it points at. */
  name: string;
  /** The reference exactly as written — `$('Fetch')`, `$node["Fetch"]`, … */
  ref: string;
}

/**
 * The four reference forms n8n itself recognises — its `applyAccessPatterns`
 * rewrites exactly these on a rename (Plan 64). If n8n treats it as a reference,
 * our guard has to know it, or a rename strands something nothing reports.
 *
 * A quoted-string body: any escape, or any char that isn't the quote/backslash.
 */
const QUOTED = String.raw`(['"\`])((?:\\.|(?!\1)[^\\\n])*)\1`;
const NODE_REF_PATTERNS = [
  // $('Name') — single literal argument only; $(var), $('a', 2) and $() are
  // deliberately not matched (a regex cannot resolve them).
  new RegExp(String.raw`\$\(\s*${QUOTED}\s*\)`, "g"),
  // $node["Name"]
  new RegExp(String.raw`\$node\[\s*${QUOTED}\s*\]`, "g"),
  // $items('Name') / $items('Name', 0) — unlike $(), extra args are the norm here
  new RegExp(String.raw`\$items\(\s*${QUOTED}\s*[,)]`, "g"),
] as const;
/** $node.Name — unquoted, so a name with spaces can never use this form. */
const NODE_DOT_RE = /\$node\.([A-Za-z_$][\w$]*)/g;

const unescapeRef = (raw: string) => raw.replace(/\\(.)/g, "$1");

/**
 * Distinct node references in a piece of source or expression text.
 *
 * Heuristic on purpose (no parse): non-literal args like `$(var)`, and template
 * literals carrying `${…}`, don't match and are left alone — n8n's own rewriter
 * has the same ceiling.
 */
export function findNodeRefs(source: string): NodeRef[] {
  // Keyed by the reference AS WRITTEN, not by the name: a node reached both as
  // `$('Fetch')` and `$node["Fetch"]` has two broken call sites once it is gone,
  // and the error message names the form so "why does this fail now?" answers
  // itself. Collapsing to one per name would hide the second.
  const byRef = new Map<string, NodeRef>();
  const add = (name: string, ref: string): void => {
    if (name.includes("${") || byRef.has(ref)) return;
    byRef.set(ref, { name, ref });
  };
  for (const re of NODE_REF_PATTERNS) {
    // `$items('X', 0)` matches up to the comma — close it so the quoted ref we
    // show the user is a readable call rather than a dangling fragment.
    for (const m of source.matchAll(re)) add(unescapeRef(m[2]), m[0].replace(/,$/, ")"));
  }
  for (const m of source.matchAll(NODE_DOT_RE)) add(m[1], m[0]);
  return [...byRef.values()];
}

/**
 * The two ways a node reads another node's **non-first output**:
 * `$('Name').all(n)` and `$items('Name', n)` with `n > 0`. Every replay path
 * pins one items array per node — output 0 — so such a read is answered with
 * nothing (`test`, `preflight --simulate`) or refused outright (`node run`'s
 * `branchSignpost`). Finding them statically is what turns "my pinned run
 * mysteriously emitted 0 items" into a named cause (Plan 66).
 *
 * Same heuristic ceiling as `findNodeRefs`: literal name + literal index only.
 */
const BRANCH_READ_PATTERNS = [
  new RegExp(String.raw`\$\(\s*${QUOTED}\s*\)\s*\.\s*all\(\s*([1-9]\d*)\s*\)`, "g"),
  new RegExp(String.raw`\$items\(\s*${QUOTED}\s*,\s*([1-9]\d*)\s*[,)]`, "g"),
] as const;

/** A read of a node's output other than the first — `{ name, ref, output }`. */
export interface BranchRead extends NodeRef {
  /** The output index the call asks for (always > 0). */
  output: number;
}

/** Distinct non-first-output reads in a piece of source text. */
export function findBranchReads(source: string): BranchRead[] {
  const byRef = new Map<string, BranchRead>();
  for (const re of BRANCH_READ_PATTERNS) {
    for (const m of source.matchAll(re)) {
      const ref = m[0].replace(/,$/, ")");
      const name = unescapeRef(m[2]);
      if (name.includes("${") || byRef.has(ref)) continue;
      byRef.set(ref, { name, ref, output: Number(m[3]) });
    }
  }
  return [...byRef.values()];
}

/** Kebab-case node-file name from a node name ("Parse Order" -> "parse-order"). */
export function kebabCase(name: string): string {
  const kebab = sanitizeFilename(name)
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1-$2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || "unnamed";
}

const TOP_LEVEL_ORDER = [
  "id", "name", "active", "isArchived", "createdAt", "updatedAt",
  "nodes", "connections", "settings", "staticData", "meta", "pinData",
  "tags", "versionId",
];
const NODE_ORDER = [
  "id", "name", "type", "typeVersion", "position", "disabled",
  "parameters", "credentials",
];

function sortKeys(obj: object, preferred: string[] = []): string[] {
  const keys = Object.keys(obj);
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys;
}

function orderDeep(value: unknown, preferred: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => orderDeep(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of sortKeys(value, preferred)) out[k] = orderDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Canonical JSON for value comparison: recursively key-sorted, compact. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(orderDeep(value));
}

/** Deterministic pretty JSON for a workflow: stable key order, clean diffs. */
export function stableWorkflowJson(wf: Workflow): string {
  const ordered: Record<string, unknown> = {};
  for (const k of sortKeys(wf, TOP_LEVEL_ORDER)) {
    ordered[k] = k === "nodes"
      ? wf.nodes.map((n) => orderDeep(n, NODE_ORDER))
      : orderDeep(wf[k]);
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

const SETTINGS_WHITELIST = [
  "saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution",
  "saveDataSuccessExecution", "executionTimeout", "timezone", "errorWorkflow",
];

/** Reduce a workflow to the fields the PUT endpoint accepts. */
export function sanitizeForPut(wf: Workflow): WorkflowPut {
  const settings: Record<string, unknown> = {};
  for (const k of SETTINGS_WHITELIST) {
    if (wf.settings && wf.settings[k] !== undefined) settings[k] = wf.settings[k];
  }
  const out: WorkflowPut = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings,
  };
  if (wf.staticData !== undefined && wf.staticData !== null) out.staticData = wf.staticData;
  return out;
}

/**
 * Publication state from an API workflow response. n8n's public API
 * auto-publishes updates to a *published* workflow (publishIfActive is
 * hardcoded server-side), so pushes there go live immediately; on an
 * unpublished workflow they only update the draft. Undefined when the
 * server doesn't report `active`.
 */
export function publicationState(wf: Workflow | undefined): "published" | "unpublished" | undefined {
  if (typeof wf?.active !== "boolean") return undefined;
  return wf.active ? "published" : "unpublished";
}

/**
 * True when a **published** workflow's live version lags its draft — i.e. the
 * draft was edited (in the n8n UI) without being published, so the live code is
 * older than what `pull` would bring down. Compares the n8n 2.x GET fields
 * `versionId` (draft) and `activeVersionId` (published). Undefined when the
 * workflow is unpublished or the server omits either field (mocks, exotic
 * versions) — the same defensive stance as `publicationState`.
 */
export function publishedVersionLagsDraft(wf: Workflow | undefined): boolean | undefined {
  if (publicationState(wf) !== "published") return undefined;
  if (typeof wf?.versionId !== "string" || typeof wf?.activeVersionId !== "string") return undefined;
  return wf.activeVersionId !== wf.versionId;
}

/**
 * Hash of the sanitized, code-stripped workflow — detects structural edits
 * (nodes added/moved/reconnected, settings changed) independent of code edits.
 */
export function workflowStructureHash(wf: Workflow): string {
  const clone = structuredClone(sanitizeForPut(wf));
  for (const node of clone.nodes ?? []) {
    if (isJsCodeNode(node)) node.parameters.jsCode = "";
  }
  return sha256(JSON.stringify(orderDeep(clone)));
}
