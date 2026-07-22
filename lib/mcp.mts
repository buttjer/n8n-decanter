// n8n MCP client (Plan 32): the sync backend for the workflow code path.
// Speaks JSON-RPC over n8n's Streamable-HTTP MCP endpoint with a minimal
// hand-rolled client — no SDK dependency. Auth is either a rotatable bearer
// token (N8N_MCP_TOKEN) or OAuth (client id + refresh token minted by `init`,
// stored in .decanter-auth.json). All shapes verified against n8n 2.30.7
// (plans/OPEN-32 spike).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Log, Workflow } from "./types.mts";
import { CODE_NODE_TYPE } from "./util.mts";

export const MCP_PATH = "/mcp-server/http";
export const AUTH_FILE = ".decanter-auth.json";
const PROTOCOL_VERSION = "2025-03-26";

/**
 * n8n's own guidance for a workflow that hasn't been opted into MCP —
 * mirrored (not invented) so CLI hints match what the server says.
 */
export const ENABLE_MCP_HINT = 'enable MCP access from the workflow card in the n8n workflows list (⋯ menu), or from the workflow settings, then retry';

/** One workflow row from `search_workflows` (all workflows, opted-in or not). */
export interface McpWorkflowSummary {
  id: string;
  name: string | null;
  active: boolean | null;
  /** The per-workflow MCP opt-in gate: details/edit tools refuse without it. */
  availableInMCP: boolean;
  updatedAt?: string | null;
  [key: string]: unknown;
}

/** Summary returned by `update_workflow` (the tool never returns the workflow). */
export interface McpUpdateSummary {
  workflowId: string;
  name: string;
  nodeCount: number;
  appliedOperations: number;
  validationWarnings: unknown[];
  [key: string]: unknown;
}

/** One `update_workflow` operation (the subset the decanter issues). */
export type McpOperation =
  | { type: "updateNodeParameters"; nodeName: string; parameters: Record<string, unknown> }
  | { type: "renameNode"; oldName: string; newName: string }
  | { type: "addNode"; node: { id?: string; name: string; type: string; typeVersion: number; position?: [number, number]; parameters?: Record<string, unknown> } }
  | { type: "setWorkflowMetadata"; name?: string; description?: string };

/**
 * A tool call the server answered with `isError: true`. `text` is the server's
 * own message (n8n replies with plain prose or a small `{"error": …}` JSON) —
 * surfaced verbatim so its guidance reaches the user unfiltered.
 */
export class McpToolError extends Error {
  constructor(tool: string, text: string) {
    super(`${tool}: ${text}`);
    this.name = "McpToolError";
  }
}

/** True when an error is the per-workflow "not available in MCP" refusal. */
export function isUnavailableInMcp(err: unknown): boolean {
  return err instanceof Error && /not available in MCP/i.test(err.message);
}

// ---------- auth ----------

/** .decanter-auth.json — OAuth credentials minted by `init` (gitignored, 0600). */
export interface McpAuthFile {
  host: string;
  clientId: string;
  /** Single-use: every refresh rotates it; the file is rewritten on each rotation. */
  refreshToken: string;
  accessToken?: string;
  /** ISO timestamp; the cached access token is reused until shortly before this. */
  accessTokenExpiresAt?: string;
}

export type McpAuth =
  | { kind: "bearer"; token: string }
  | { kind: "oauth"; file: string; data: McpAuthFile };

export function authFilePath(configDir: string): string {
  return path.join(configDir, AUTH_FILE);
}

export function readAuthFile(configDir: string): McpAuthFile | null {
  const file = authFilePath(configDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as McpAuthFile;
  } catch (err) {
    throw new Error(`corrupt ${AUTH_FILE} (${(err as Error).message}) — delete it and re-run: n8n-decanter init`);
  }
}

/**
 * Atomic auth-file persist (`.tmp` + rename): a concurrent reader (watch vs.
 * a manual push) never sees a half-written file — with single-use refresh
 * tokens, a torn read would cost the whole session.
 */
function persistAuthFile(file: string, data: McpAuthFile): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function writeAuthFile(configDir: string, data: McpAuthFile): void {
  persistAuthFile(authFilePath(configDir), data);
}

/**
 * Resolve MCP credentials: N8N_MCP_TOKEN (env / .env) wins, then the OAuth
 * auth file. An auth file minted for a different host is stale and ignored
 * (warned) — `init` against the new host refreshes it.
 */
export function resolveMcpAuth(configDir: string, host: string, log?: Log): McpAuth | null {
  const token = process.env.N8N_MCP_TOKEN ?? "";
  if (token !== "") return { kind: "bearer", token };
  const data = readAuthFile(configDir);
  if (!data) return null;
  if (data.host !== host) {
    log?.warn(`${AUTH_FILE} was minted for ${data.host}, not ${host} — ignoring it; re-run: n8n-decanter init`);
    return null;
  }
  return { kind: "oauth", file: authFilePath(configDir), data };
}

// ---------- OAuth plumbing (shared by init's consent flow and token refresh) ----------

interface OAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  [key: string]: unknown;
}

/**
 * OAuth discovery, with every endpoint re-based onto `host`: an instance
 * behind a proxy (or a Docker container) advertises its own idea of its URL,
 * which may not be reachable from here — the paths are what matters.
 */
export async function oauthDiscovery(host: string, timeoutMs: number): Promise<OAuthDiscovery> {
  const res = await fetch(`${host}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`OAuth discovery failed (${res.status}) — is MCP access enabled on ${host}? (n8n Settings → MCP; needs n8n ≥ ~2.20)`);
  }
  const raw = (await res.json()) as OAuthDiscovery;
  const rebase = (u: string): string => {
    try {
      return host + new URL(u).pathname;
    } catch {
      return u;
    }
  };
  return {
    ...raw,
    authorization_endpoint: rebase(raw.authorization_endpoint),
    token_endpoint: rebase(raw.token_endpoint),
    registration_endpoint: rebase(raw.registration_endpoint),
  };
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp derived from `expires_in` (n8n: 3600s), minus a safety margin. */
  accessTokenExpiresAt: string;
}

/**
 * A failed token-grant call, carrying the server's OAuth error code so the
 * client can tell a lost refresh race (`invalid_grant` — recoverable by
 * re-reading the rotated auth file) from a genuinely dead session.
 */
export class TokenRefreshError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`MCP session expired (token refresh failed: ${reason}) — re-run: n8n-decanter init`);
    this.name = "TokenRefreshError";
    this.reason = reason;
  }
}

/**
 * `fallbackRefreshToken` covers a server that answers a refresh grant without
 * rotating (no `refresh_token` in the body) — keep using the old one instead
 * of persisting the literal string "undefined" (the pre-Plan-33 failure).
 */
function tokensFromResponse(body: Record<string, unknown>, fallbackRefreshToken?: string): OAuthTokens {
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefreshToken;
  if (typeof body.access_token !== "string" || refreshToken === undefined) {
    throw new TokenRefreshError("malformed token response");
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    // 60s safety margin so a token never expires mid-request
    accessTokenExpiresAt: new Date(Date.now() + (expiresIn - 60) * 1000).toISOString(),
  };
}

/**
 * Redeem the refresh token. n8n ROTATES it — the old token is invalid the
 * moment this succeeds, so the caller must persist the returned one before
 * doing anything else. An `invalid_grant` means the stored token was already
 * used (or revoked) — the client treats that as a possibly-lost refresh race
 * (see `#refresh`) before surfacing the re-init guidance.
 */
export async function refreshAccessToken(host: string, clientId: string, refreshToken: string, timeoutMs: number): Promise<OAuthTokens> {
  const { token_endpoint } = await oauthDiscovery(host, timeoutMs);
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new TokenRefreshError(reason);
  }
  return tokensFromResponse(body, refreshToken);
}

/** Exchange an authorization code (init's consent flow) for the first token pair. */
export async function exchangeAuthorizationCode(
  host: string,
  { clientId, code, redirectUri, codeVerifier }: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
  timeoutMs: number,
): Promise<OAuthTokens> {
  const { token_endpoint } = await oauthDiscovery(host, timeoutMs);
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`OAuth token exchange failed (${reason})`);
  }
  try {
    return tokensFromResponse(body);
  } catch {
    throw new Error("OAuth token exchange failed (no refresh token in the response)");
  }
}

/** RFC 7591 dynamic client registration (public client, PKCE-only). */
export async function registerOAuthClient(host: string, redirectUri: string, timeoutMs: number): Promise<string> {
  const { registration_endpoint } = await oauthDiscovery(host, timeoutMs);
  const res = await fetch(registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "n8n-decanter",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: string };
  if (!res.ok || typeof body.client_id !== "string") {
    throw new Error(`OAuth client registration failed (HTTP ${res.status})`);
  }
  return body.client_id;
}

/**
 * Interactive OAuth consent (init's flow): register a client, open the n8n
 * consent page in the browser, catch the authorization code on a localhost
 * callback, exchange it for tokens. `openBrowser` is injectable for tests;
 * the authorize URL is always printed too (headless/SSH users open it by
 * hand — DECANTER_NO_BROWSER=1 skips the auto-open entirely).
 */
export async function runOAuthConsent(
  host: string,
  { log, openBrowser, timeoutMs = 30_000, consentTimeoutMs = 300_000 }: { log: Log; openBrowser?: (url: string) => void; timeoutMs?: number; consentTimeoutMs?: number },
): Promise<{ clientId: string; tokens: OAuthTokens }> {
  const { createServer } = await import("node:http");
  const { createHash, randomBytes } = await import("node:crypto");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const clientId = await registerOAuthClient(host, redirectUri, timeoutMs);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");
    const { authorization_endpoint } = await oauthDiscovery(host, timeoutMs);
    const authorizeUrl = `${authorization_endpoint}?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    })}`;

    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for the browser consent — re-run init (or set N8N_MCP_TOKEN instead)")), consentTimeoutMs);
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") return void res.writeHead(404).end();
        const err = url.searchParams.get("error");
        const got = url.searchParams.get("code");
        const ok = err === null && got !== null && url.searchParams.get("state") === state;
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html" })
          .end(ok
            ? "<h1>n8n-decanter is connected</h1><p>You can close this tab and return to the terminal.</p>"
            : `<h1>Authorization failed</h1><p>${err ?? "bad state/code"} — return to the terminal and retry.</p>`);
        clearTimeout(timer);
        if (ok) resolve(got);
        else reject(new Error(`browser consent failed (${err ?? "state mismatch"})`));
      });
    });

    log.info(`opening the n8n consent page in your browser — approve access for n8n-decanter`);
    log.info(`  (no browser here? open this URL yourself: ${authorizeUrl})`);
    if (process.env.DECANTER_NO_BROWSER !== "1") openBrowser?.(authorizeUrl);
    const tokens = await exchangeAuthorizationCode(host, { clientId, code: await code, redirectUri, codeVerifier: verifier }, timeoutMs);
    return { clientId, tokens };
  } finally {
    server.close();
  }
}

/** Best-effort platform browser opener; failures fall back to the printed URL. */
export function openBrowserCommand(url: string): void {
  import("node:child_process").then(({ spawn }) => {
    const [cmd, args] = process.platform === "darwin"
      ? ["open", [url]] as const
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]] as const
        : ["xdg-open", [url]] as const;
    spawn(cmd, [...args], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  });
}

// ---------- the client ----------

export class McpClient {
  #host: string;
  #timeoutMs: number;
  #auth: McpAuth;
  #log?: Log;
  #sessionId: string | undefined;
  #rpcId = 0;
  #initialized: Promise<void> | undefined;
  #refreshInFlight: Promise<string> | undefined;
  #sleep: (ms: number) => Promise<void>;

  constructor({ host, auth, requestTimeoutMs = 30_000, log, sleep }: { host: string; auth: McpAuth; requestTimeoutMs?: number; log?: Log; sleep?: (ms: number) => Promise<void> }) {
    this.#host = host;
    this.#auth = auth;
    this.#timeoutMs = requestTimeoutMs;
    this.#log = log;
    // injectable for tests only — the 429 backoff would otherwise take real seconds
    this.#sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Call one MCP tool and return its parsed payload (`structuredContent`,
   * falling back to the JSON in the text content). `isError` results throw
   * `McpToolError` carrying the server's message verbatim.
   */
  async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.#ensureInitialized();
    const result = (await this.#rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError === true) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {
        // plain-prose error text — keep as is
      }
      throw new McpToolError(name, message);
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { text } as T;
    }
  }

  #ensureInitialized(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "n8n-decanter", version: "0" },
      });
      await this.#rpc("notifications/initialized");
    })().catch((err) => {
      // a transient handshake failure must not poison every later call
      // (multi-ref runs, long-lived watch) — let the next caller retry
      this.#initialized = undefined;
      throw err;
    });
    return this.#initialized;
  }

  /** Current bearer: the static token, or a cached/refreshed OAuth access token. */
  async #accessToken(forceRefresh = false): Promise<string> {
    if (this.#auth.kind === "bearer") return this.#auth.token;
    const { data } = this.#auth;
    if (!forceRefresh && this.#cacheValid(data)) return data.accessToken!;
    // one refresh at a time in-process: concurrent callTool()s join the same
    // redemption instead of double-spending the single-use refresh token
    this.#refreshInFlight ??= this.#refresh().finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  /**
   * The upstream bearer for the guard proxy (Plan 33): the static token, or a
   * cached/refreshed OAuth access token — same path `callTool` uses, so the
   * proxy inherits the refresh-race coordination. `forceRefresh` after an
   * upstream 401.
   */
  bearerToken(forceRefresh = false): Promise<string> {
    return this.#accessToken(forceRefresh);
  }

  #cacheValid(data: McpAuthFile): boolean {
    return data.accessToken !== undefined && data.accessTokenExpiresAt !== undefined && new Date(data.accessTokenExpiresAt).getTime() > Date.now();
  }

  /** Best-effort re-read of the auth file — another process may have rotated it. */
  #reReadAuth(file: string): McpAuthFile | null {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as McpAuthFile;
    } catch {
      return null;
    }
  }

  /**
   * Redeem the (single-use, rotating) refresh token, coordinating with other
   * decanter processes sharing the auth file (watch + a manual push):
   *
   * - **Fast path:** another process already minted a *valid cached access
   *   token* on disk — reuse it, no redemption at all.
   * - Otherwise redeem OUR in-memory refresh token. We deliberately do NOT
   *   proactively adopt a *differing* on-disk refresh token here: after a
   *   failed persist (warned, non-fatal) our in-memory token is the newer,
   *   valid one and the on-disk token is the stale pre-rotation string —
   *   adopting it would redeem a spent token and strand a session that would
   *   otherwise keep working.
   * - Only an **`invalid_grant`** tells us our token is genuinely spent (a
   *   lost cross-process race): re-read once and, if disk now holds a newer
   *   token, retry with the winner's — else surface the re-init guidance.
   */
  async #refresh(): Promise<string> {
    const { data, file } = this.#auth as Extract<McpAuth, { kind: "oauth" }>;
    const onDisk = this.#reReadAuth(file);
    if (onDisk !== null && this.#cacheValid(onDisk) && onDisk.accessToken !== data.accessToken) {
      Object.assign(data, onDisk); // another process already refreshed — reuse its token
      return onDisk.accessToken!;
    }
    try {
      return await this.#redeemAndPersist(data, file);
    } catch (err) {
      if (!(err instanceof TokenRefreshError) || err.reason !== "invalid_grant") throw err;
      // our token was spent: a lost race means the winner rotated + persisted
      const latest = this.#reReadAuth(file);
      if (latest === null || latest.refreshToken === data.refreshToken) throw err; // no newer state — genuinely dead
      Object.assign(data, latest);
      if (this.#cacheValid(data)) return data.accessToken!;
      return this.#redeemAndPersist(data, file);
    }
  }

  async #redeemAndPersist(data: McpAuthFile, file: string): Promise<string> {
    const tokens = await refreshAccessToken(this.#host, data.clientId, data.refreshToken, this.#timeoutMs);
    // the refresh token ROTATED — persist before anything can interrupt us
    data.refreshToken = tokens.refreshToken;
    data.accessToken = tokens.accessToken;
    data.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
    try {
      persistAuthFile(file, data);
    } catch (err) {
      this.#log?.warn(`could not persist the rotated MCP refresh token to ${file} (${(err as Error).message}) — the next run may need a fresh \`init\``);
    }
    return tokens.accessToken;
  }

  async #rpc(method: string, params?: unknown): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    const isNotification = method.startsWith("notifications/");
    if (!isNotification) body.id = ++this.#rpcId;

    const timeoutError = () =>
      new Error(`MCP ${method} timed out after ${this.#timeoutMs / 1000}s — n8n did not respond (raise "requestTimeoutMs" in decanter.config.json for a slow instance)`);
    let res: Response;
    let refreshed = false;
    let rateRetries = 0;
    let sessionRetried = false;
    for (;;) {
      const token = await this.#accessToken(refreshed);
      try {
        res = await fetch(this.#host + MCP_PATH, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(this.#sessionId !== undefined && { "mcp-session-id": this.#sessionId }),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === "TimeoutError" || name === "AbortError") throw timeoutError();
        throw err;
      }
      if (res.status === 401 && this.#auth.kind === "oauth" && !refreshed) {
        refreshed = true; // access token may have just expired — refresh once
        continue;
      }
      // n8n rate-limits the MCP endpoint (verified: 100 requests per IP per
      // 5 MINUTES on 2.30.7 — mcp.config.ts, N8N_MCP_SERVER_RATE_LIMIT) — a
      // rejected request was NOT applied, so retrying is safe for every
      // method, including update_workflow. Honor Retry-After up to that
      // verified window (a bogus header must not stall longer); the cap must
      // NOT be shorter than the window, or a burst-heavy run gives up inside
      // it (smoke-proven regression).
      if (res.status === 429 && rateRetries < 5) {
        rateRetries++;
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 310_000) : Math.min(1000 * 2 ** (rateRetries - 1), 8000);
        if (delayMs > 5000) this.#log?.warn(`n8n rate-limited the MCP endpoint (429) — waiting ${Math.round(delayMs / 1000)}s before retrying (n8n allows 100 requests / 5 min by default)`);
        await res.text().catch(() => {}); // drain before the retry
        await this.#sleep(delayMs);
        continue;
      }
      // 404 *with* a session id usually means the server dropped our MCP
      // session (restart/expiry), not a missing endpoint — re-handshake once
      if (res.status === 404 && this.#sessionId !== undefined && !sessionRetried && method === "tools/call") {
        sessionRetried = true;
        this.#sessionId = undefined;
        this.#initialized = undefined;
        await res.text().catch(() => {});
        await this.#ensureInitialized();
        continue;
      }
      break;
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid !== null) this.#sessionId = sid;
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // the AbortSignal also covers body consumption — map it to the same
      // friendly message instead of a bare TimeoutError
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw timeoutError();
      throw err;
    }
    if (res.status === 401) {
      throw new Error(this.#auth.kind === "bearer"
        ? "the MCP token was rejected (401) — mint a fresh one in n8n (Settings → MCP) and update N8N_MCP_TOKEN (the public API key is not a valid MCP token)"
        : "MCP authorization rejected (401) — re-run: n8n-decanter init");
    }
    if (res.status === 404) {
      throw new Error(`no MCP endpoint at ${this.#host}${MCP_PATH} (404) — enable MCP access in n8n (Settings → MCP; needs n8n ≥ ~2.20)`);
    }
    if (isNotification) return undefined;
    if (!res.ok) throw new Error(`MCP ${method} failed: ${res.status} ${res.statusText}\n${text.slice(0, 2000)}`);

    let message: { id?: unknown; result?: unknown; error?: { message?: string } } | undefined;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as typeof message;
          if (parsed?.id === body.id) message = parsed;
        } catch {
          // non-JSON SSE line (comment/heartbeat) — skip
        }
      }
    } else if (text !== "") {
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        // a captive portal / reverse proxy answering 200 with HTML — name the
        // problem instead of leaking a raw SyntaxError
        throw new Error(`MCP ${method}: the server answered 200 with non-JSON content (${JSON.stringify(text.slice(0, 120))}) — is ${this.#host} really your n8n instance (captive portal, proxy)?`);
      }
    }
    if (message?.error) throw new Error(`MCP ${method} error: ${message.error.message ?? JSON.stringify(message.error)}`);
    if (message === undefined) throw new Error(`MCP ${method}: no response message in ${JSON.stringify(text.slice(0, 200))}`);
    return message.result;
  }
}

/**
 * Build the MCP client for a loaded config, or fail with setup guidance.
 * MCP is the sync backend for the workflow code path (Plan 32) — every
 * pull/push/status/watch/lifecycle verb goes through here.
 */
export function createMcpClient(config: { host: string; configDir: string; requestTimeoutMs: number }, log?: Log): McpClient {
  if (config.host === "") {
    throw new Error("N8N_HOST must be set (via .env next to decanter.config.json or the environment)");
  }
  const auth = resolveMcpAuth(config.configDir, config.host, log);
  if (auth === null) {
    throw new Error("no MCP credentials — run `n8n-decanter init` to connect via OAuth, or set N8N_MCP_TOKEN (n8n → Settings → MCP → API key)");
  }
  return new McpClient({ host: config.host, auth, requestTimeoutMs: config.requestTimeoutMs, log });
}

// ---------- typed tool wrappers ----------

/** The page size `searchWorkflows` requests — a full page means "probably truncated". */
const SEARCH_LIMIT = 200;

/** All workflows on the instance (opted-in or not); `availableInMCP` gates detail/edit. */
export async function searchWorkflows(mcp: McpClient, log?: Log): Promise<McpWorkflowSummary[]> {
  const res = await mcp.callTool<{ data: McpWorkflowSummary[] }>("search_workflows", { limit: SEARCH_LIMIT });
  const rows = res.data ?? [];
  if (rows.length === SEARCH_LIMIT) {
    log?.warn(`the instance returned exactly ${SEARCH_LIMIT} workflows (the page cap) — the list is probably truncated; workflows beyond it are invisible to name resolution and the picker`);
  }
  return rows;
}

/**
 * The workflow tip — what the n8n editor shows: the unpublished draft when one
 * exists, else the published content. Node `jsCode` is byte-exact. Refuses
 * workflows not opted into MCP (`isUnavailableInMcp`).
 */
export async function getWorkflowDetails(mcp: McpClient, id: string): Promise<Workflow> {
  const res = await mcp.callTool<{ workflow: Workflow }>("get_workflow_details", { workflowId: id });
  // Normalize the guarded-authoring shape at the single read choke point: a
  // JS Code node born over MCP `addNode` carries NO jsCode param (the guard
  // blocks code in addNode; n8n stores the params as sent). Treat it as
  // empty source so pull lands it as a file and push can seed it — instead
  // of every verb ignoring it as "not a JS Code node".
  for (const node of res.workflow.nodes ?? []) {
    if (node.type === CODE_NODE_TYPE && node.parameters && node.parameters.jsCode === undefined
        && (node.parameters.language === undefined || node.parameters.language === "javaScript")) {
      node.parameters.jsCode = "";
    }
  }
  return res.workflow;
}

/** Atomic op batch; addresses nodes by NAME. Returns a summary, never the workflow. */
export async function updateWorkflow(mcp: McpClient, id: string, operations: McpOperation[]): Promise<McpUpdateSummary> {
  return mcp.callTool<McpUpdateSummary>("update_workflow", { workflowId: id, operations });
}

/**
 * `prepare_test_pin_data` result — a **schema oracle** for scenario scaffolding
 * (Plan 37). Read-only/idempotent; the server returns **JSON Schemas, never
 * data** (the caller authors realistic values). `nodeSchemasToGenerate` is keyed
 * by node name; `nodesWithoutSchema` need pins but have no schema (empty
 * defaults); `nodesSkipped` execute normally (no pin needed). Shape source-
 * verified against n8n's prepare-workflow-pin-data.tool.ts (2026-07-22).
 */
export interface PinDataScaffold {
  nodeSchemasToGenerate: Record<string, unknown>;
  nodesWithoutSchema: string[];
  nodesSkipped: string[];
  coverage: {
    withSchemaFromExecution: number;
    withSchemaFromDefinition: number;
    withoutSchema: number;
    skipped: number;
    total: number;
  };
}

/** Ask n8n for the per-node output schemas of the nodes a test run must pin (read-only). */
export async function prepareTestPinData(mcp: McpClient, id: string): Promise<PinDataScaffold> {
  return mcp.callTool<PinDataScaffold>("prepare_test_pin_data", { workflowId: id });
}

/**
 * Take the draft live. n8n reports failure in-band (`success: false` with the
 * reason, e.g. the not-available refusal) — normalized to a throw here.
 */
export async function publishWorkflowMcp(mcp: McpClient, id: string): Promise<{ activeVersionId?: string | null }> {
  const res = await mcp.callTool<{ success: boolean; activeVersionId?: string | null; error?: string }>("publish_workflow", { workflowId: id });
  if (res.success !== true) throw new McpToolError("publish_workflow", res.error ?? "publish failed");
  return res;
}

/** Return a published workflow to draft-only (same in-band error contract). */
export async function unpublishWorkflowMcp(mcp: McpClient, id: string): Promise<void> {
  const res = await mcp.callTool<{ success: boolean; error?: string }>("unpublish_workflow", { workflowId: id });
  if (res.success !== true) throw new McpToolError("unpublish_workflow", res.error ?? "unpublish failed");
}

