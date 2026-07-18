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
  /** Publication state (n8n 2.x publish model; activation toggle on 1.x). Read-only via API. */
  active?: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  [key: string]: unknown;
}

/** The subset of a workflow the PUT endpoint accepts (see sanitizeForPut). */
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
}

/** .decanter.json — one per workflow folder. */
export interface DecanterState {
  workflowId: string;
  nodes: Record<string, NodeState>;
  /** Code-stripped, key-sorted structure hash at last pull. */
  lastPulledWorkflowHash?: string;
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
  host: string;
  apiKey: string;
}

export interface Log {
  info(message: string): void;
  /** Success line — rendered as a green `✓ ` prefix (plain `✓ ` when piped). */
  ok(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
