import { createHash } from "node:crypto";

export const CODE_NODE_TYPE = "n8n-nodes-base.code";
export const FILE_PLACEHOLDER_PREFIX = "//@file:";
const MARKER_PREFIX = "// @ts-n8n ";

/** True for Code nodes whose source is JavaScript (the only kind we extract). */
export function isJsCodeNode(node) {
  return (
    node?.type === CODE_NODE_TYPE &&
    typeof node.parameters?.jsCode === "string" &&
    (node.parameters.language === undefined || node.parameters.language === "javaScript")
  );
}

export function sha256(text) {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Split trailing `// @ts-n8n sha256:<hex>` marker off a jsCode string.
 * The marker must be the last non-blank line. `body` keeps everything up to
 * the marker line byte-exactly (including the newline before it), so
 * hash(body) matches the hash computed at push time.
 */
export function splitMarker(code) {
  const m = code.match(/(?:^|\n)(\/\/ @ts-n8n (sha256:[0-9a-f]{64}))[ \t]*\n?[ \t\n]*$/);
  if (!m) return { body: code, marker: null, markerHash: null };
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  return { body: code.slice(0, start), marker: m[1], markerHash: m[2] };
}

/** Build the jsCode payload for a TS-managed node from compiled JS. */
export function withMarker(compiledJs) {
  const body = compiledJs.endsWith("\n") ? compiledJs : compiledJs + "\n";
  return { jsCode: body + MARKER_PREFIX + sha256(body), hash: sha256(body) };
}

/** Sanitize a workflow/node name for use as a file or folder name. */
export function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .trim()
    .replace(/\.+$/, "");
  return cleaned || "unnamed";
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

function sortKeys(obj, preferred = []) {
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

function orderDeep(value, preferred) {
  if (Array.isArray(value)) return value.map((v) => orderDeep(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of sortKeys(value, preferred)) out[k] = orderDeep(value[k]);
    return out;
  }
  return value;
}

/** Deterministic pretty JSON for a workflow: stable key order, clean diffs. */
export function stableWorkflowJson(wf) {
  const ordered = {};
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
export function sanitizeForPut(wf) {
  const settings = {};
  for (const k of SETTINGS_WHITELIST) {
    if (wf.settings && wf.settings[k] !== undefined) settings[k] = wf.settings[k];
  }
  const out = {
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
export function workflowStructureHash(wf) {
  const clone = structuredClone(sanitizeForPut(wf));
  for (const node of clone.nodes ?? []) {
    if (isJsCodeNode(node)) node.parameters.jsCode = "";
  }
  return sha256(JSON.stringify(orderDeep(clone)));
}
