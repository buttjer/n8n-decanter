// Shared shapes of the decanter data model. Types only — no runtime exports.

/** Parameters bag of an n8n node; the Code-node fields we touch made explicit. */
export type NodeParameters = Record<string, unknown> & {
  jsCode?: string;
  language?: string;
  mode?: string;
};

/** One n8n node as it appears in workflow JSON (extra fields pass through). */
export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  parameters: NodeParameters;
  [key: string]: unknown;
}

/** A JS Code node — the only kind the decanter extracts (see isJsCodeNode). */
export interface JsCodeNode extends WorkflowNode {
  type: "n8n-nodes-base.code";
  parameters: NodeParameters & { jsCode: string };
}

/** Full workflow as returned by GET /workflows/:id (extra fields pass through). */
export interface Workflow {
  id: string;
  name: string;
  /** Publication state (n8n 2.x publish model). Read-only via API. */
  active?: boolean;
  /** Draft version id (n8n 2.x GET) — always present on a real 2.x response. */
  versionId?: string;
  /**
   * Published (live) version id (n8n 2.x GET). `null`/absent when unpublished;
   * equals `versionId` when the live version matches the draft. It only lags the
   * draft after a UI edit that isn't published yet — the version-aware `status`
   * signal (see publishedVersionLagsDraft).
   */
  activeVersionId?: string | null;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  [key: string]: unknown;
}

/**
 * One execution as returned by GET /executions with includeData=true (extra
 * fields pass through). Items live under
 * `data.resultData.runData["<Node Name>"][0].data.main[0][]` with `.json`
 * payloads; `workflowVersionId` names the *published* version that ran
 * (n8n 2.x — executions never run the draft).
 */
export interface Execution {
  id: number | string;
  status?: string;
  workflowId?: string;
  /** The *published* version id this execution ran (n8n 2.x). */
  workflowVersionId?: string;
  [key: string]: unknown;
}

/**
 * One n8n data table (project-scoped built-in table, n8n ≥ 2.x) as returned by
 * `GET /data-tables`. Read-only in the decanter — never written through. Extra
 * fields pass through; `columns` may be inlined by the list endpoint or fetched
 * separately from `/data-tables/{id}/columns`.
 */
export interface DataTable {
  id: string | number;
  name: string;
  /** Owning project — data tables are project-scoped, not workflow-scoped. */
  projectId?: string;
  columns?: DataTableColumn[];
  [key: string]: unknown;
}

/** One data-table column (its schema entry). `type` is n8n's column type. */
export interface DataTableColumn {
  id?: string | number;
  name: string;
  /** n8n column type: `string` | `number` | `boolean` | `date` (extra pass through). */
  type?: string;
  [key: string]: unknown;
}

/** One data-table row: a flat column-name → value object (+ system id/timestamps). */
export type DataTableRow = Record<string, unknown>;

/**
 * The API-era PUT subset of a workflow (see sanitizeForPut). No verb writes
 * it anymore (Plan 33) — it survives as the code-stripped canonical shape
 * behind `workflowStructureHash` (status's snapshot-stale hint).
 */
export interface WorkflowPut {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  staticData?: unknown;
}

/** Per-node entry in .decanter.json. */
export interface NodeState {
  file: string;
  /** Hash of the *remote* code (marker-less body) at last sync — push or pull. */
  lastPushedHash?: string;
  /**
   * Cached node display name (Plan 32). MCP ops address nodes by NAME while
   * this map is keyed on the id (stable across renames) — the name is looked
   * up fresh from the remote at push time; this cache only feeds messages
   * about nodes that no longer exist remotely.
   */
  name?: string;
}

/** .decanter.json — one per workflow folder. */
export interface DecanterState {
  workflowId: string;
  /**
   * Cached display name, refreshed from `wf.name` on every pull (Plan 27). The
   * picker / `list` / ref-resolution read it, so the folder can be a stable
   * kebab slug that never follows a remote rename. Absent on states written
   * before Plan 27 — callers fall back to workflow.json, then the folder name.
   */
  name?: string;
  nodes: Record<string, NodeState>;
}

/** decanter.config.json + credentials, resolved (see loadConfig). */
export interface DecanterConfig {
  configDir: string;
  root: string;
  workflows: string[];
  commitOnPush: boolean;
  commitOnPull: boolean;
  /** `"proxy"` boots the browser-reload dev proxy during watch; `"off"` disables it. */
  browserReload: "off" | "proxy";
  /** Port the browser-reload proxy binds on 127.0.0.1 (browserReload: "proxy"). */
  proxyPort: number;
  /** Per-request timeout for n8n API calls, milliseconds (default 30 000). */
  requestTimeoutMs: number;
  /**
   * Whether the read-only `data-tables` fetch is available (default `true`).
   * `false` refuses the fetch with a clear message and the recommended key
   * needn't carry the data-table read scopes; `data-tables clean` (offline)
   * stays available regardless.
   */
  dataTables: boolean;
  /**
   * n8n version the `simulate` engine runs (npx tag / Docker tag). Optional —
   * absent, simulate defaults to the smoke pin (DEFAULT_N8N_VERSION) and hints
   * to pin it to match your instance. "Engine-true" means true to *your* n8n,
   * so pinning this to the running version is recommended (Plan 7).
   */
  n8nVersion?: string;
  /**
   * Keep the read-only `workflow.json` snapshot auto-fresh after an agent
   * restructures a workflow through the guard (`mcp connect`/`serve`, Plan 51
   * Part A). Default `true`; `false` disables the background refresh (CI /
   * deterministic setups). The refresh is fire-and-forget, git-gated, and
   * tracked-only — see lib/mirror.mts.
   */
  liveMirror: boolean;
  /**
   * Cap on the retained `backups/` working set per workflow (Plan 51 Part B).
   * Default `20`; `0` keeps all. Each `backup create` appends one file and
   * rolling-prunes the oldest beyond this count.
   */
  backupLimit: number;
  host: string;
  /**
   * n8n public API key — OPTIONAL since Plan 32: the workflow code path syncs
   * over MCP; only the surfaces MCP cannot serve still use the REST API
   * (executions and data-table reads — Plan 33 moved the last lifecycle
   * verbs off it). Empty string when unset; those verbs check and fail with
   * guidance.
   */
  apiKey: string;
}

export interface Log {
  info(message: string): void;
  /** Success line — rendered as a green `✓ ` prefix (plain `✓ ` when piped). */
  ok(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
