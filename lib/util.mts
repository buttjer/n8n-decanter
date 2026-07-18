import { createHash } from "node:crypto";
import type { JsCodeNode, Workflow, WorkflowNode, WorkflowPut } from "./types.mts";

export const CODE_NODE_TYPE = "n8n-nodes-base.code";
export const FILE_PLACEHOLDER_PREFIX = "//@file:";
/** Subdir inside a workflow folder that holds the node source files. */
export const CODE_DIR = "code";
const MARKER_PREFIX = "// @ts-n8n ";

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

/**
 * Split trailing `// @ts-n8n sha256:<hex>` marker off a jsCode string.
 * The marker must be the last non-blank line. `body` keeps everything up to
 * the marker line byte-exactly (including the newline before it), so
 * hash(body) matches the hash computed at push time.
 */
export function splitMarker(code: string): { body: string; marker: string | null; markerHash: string | null } {
  const m = code.match(/(?:^|\n)(\/\/ @ts-n8n (sha256:[0-9a-f]{64}))[ \t]*\n?[ \t\n]*$/);
  if (!m) return { body: code, marker: null, markerHash: null };
  const start = m.index! + (m[0].startsWith("\n") ? 1 : 0);
  return { body: code.slice(0, start), marker: m[1], markerHash: m[2] };
}

/** Build the jsCode payload for a TS-managed node from compiled JS. */
export function withMarker(compiledJs: string): { jsCode: string; hash: string } {
  const body = compiledJs.endsWith("\n") ? compiledJs : compiledJs + "\n";
  return { jsCode: body + MARKER_PREFIX + sha256(body), hash: sha256(body) };
}

/** Sanitize a workflow/node name for use as a file or folder name. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .replace(/\.+$/, "");
  return cleaned || "unnamed";
}

/**
 * Literal single-argument `$('Name')` / `$("Name")` / `$(`Name`)` calls.
 * Heuristic on purpose (no parse): non-literal args like `$(var)`, multi-arg
 * calls, template literals with `${…}`, and the legacy `$node["Name"]` form
 * don't match and are left alone.
 */
const NODE_REF_RE = /\$\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1\s*\)/g;

const unescapeRef = (raw: string) => raw.replace(/\\(.)/g, "$1");

/** Distinct node names referenced via literal `$('…')` in a piece of source. */
export function findNodeRefs(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(NODE_REF_RE)) {
    const name = unescapeRef(m[2]);
    if (!name.includes("${")) names.add(name);
  }
  return [...names];
}

/** Rewrite literal `$('old')` references to the new name, keeping each call's quote style. */
export function renameNodeRefs(source: string, oldName: string, newName: string): string {
  return source.replace(NODE_REF_RE, (whole, quote: string, raw: string) => {
    if (unescapeRef(raw) !== oldName) return whole;
    const escaped = newName.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`);
    return `$(${quote}${escaped}${quote})`;
  });
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
