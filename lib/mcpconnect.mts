// The stdio MCP guard (`mcp connect`): the same Code-node boundary as the
// HTTP guard-proxy (`mcp serve`), but as a stdio MCP server an agent spawns
// itself — which is what lets `init` scaffold a static, secret-free
// `.mcp.json` entry ({"command":"n8n-decanter","args":["mcp","connect"]}).
// Decanter reads its own credentials (.env / .decanter-auth.json) in this
// process; the agent only ever sees JSON-RPC over the process pipes, so no
// session secret exists at all.
//
// Transport: MCP stdio — one JSON-RPC message per line on stdin/stdout,
// stdout carries protocol messages ONLY (all logging goes to stderr).
// Each incoming message runs the shared guard (`guardMessage`): blocked
// jsCode writes are answered locally, everything else is forwarded to the
// instance's `POST /mcp-server/http` with decanter's bearer token, managing
// the `mcp-session-id` the way any MCP HTTP client would. Responses (JSON or
// SSE) are decoded back into per-line JSON-RPC messages. Parse failures fail
// CLOSED, mirroring the HTTP guard.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { MCP_PATH, type McpClient } from "./mcp.mts";
import { guardMessage } from "./mcpserve.mts";
import type { Log } from "./types.mts";

/** JSON-RPC error codes used by the bridge (server-defined range). */
const PARSE_ERROR = -32700;
const UPSTREAM_ERROR = -32001;

interface StdioGuardOptions {
  mcp: McpClient;
  host: string;
  /** Per-request upstream timeout (decanter.config.json `requestTimeoutMs`). */
  timeoutMs: number;
  /** stderr-only logger — the output stream belongs to the protocol. */
  log: Log;
  /** Protocol streams — default stdio; tests pass PassThrough pairs. */
  input?: Readable;
  output?: Writable;
}

/** JSON-RPC error response for one request id. */
function rpcError(id: unknown, code: number, text: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message: text } };
}

/**
 * Run the stdio guard until stdin closes (the agent ending the session).
 * Messages are processed strictly in order — an MCP client awaits its
 * responses anyway, and ordering keeps the initialize → session-id capture
 * race-free.
 */
export async function runStdioGuard({ mcp, host, timeoutMs, log, input = process.stdin, output = process.stdout }: StdioGuardOptions): Promise<void> {
  const upstream = host + MCP_PATH;
  let sessionId: string | undefined;

  /** One protocol message (or batch) out — a single output line. */
  const emit = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  /** Forward one already-guarded JSON-RPC unit (message or batch) upstream. */
  const forward = async (unit: unknown, ids: unknown[]): Promise<void> => {
    let res: Response;
    let refreshed = false;
    let rateRetries = 0;
    try {
      for (;;) {
        const token = await mcp.bearerToken(refreshed);
        res = await fetch(upstream, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId !== undefined && { "mcp-session-id": sessionId }),
          },
          body: JSON.stringify(unit),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 && !refreshed) {
          refreshed = true; // expired access token — refresh once and retry
          await res.text().catch(() => {});
          continue;
        }
        // Same rate-limit posture as the MCP client: a 429 was NOT applied,
        // so retrying is safe; honor Retry-After within n8n's 5-min window.
        if (res.status === 429 && rateRetries < 3) {
          rateRetries++;
          const retryAfter = Number(res.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 310_000) : Math.min(1000 * 2 ** (rateRetries - 1), 8000);
          if (delayMs > 5000) log.warn(`n8n rate-limited the MCP endpoint (429) — waiting ${Math.round(delayMs / 1000)}s before retrying`);
          await res.text().catch(() => {});
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    } catch (err) {
      const name = (err as Error).name;
      const reason = name === "TimeoutError" || name === "AbortError" ? `no response within ${timeoutMs / 1000}s` : (err as Error).message;
      log.warn(`upstream request failed: ${reason}`);
      for (const id of ids) emit(rpcError(id, UPSTREAM_ERROR, `n8n unreachable through the decanter guard (${reason}) — is ${host} up?`));
      return;
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid !== null) sessionId = sid;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const detail = res.status === 401
        ? "decanter's MCP credentials were rejected (401) — run `n8n-decanter init` (or refresh N8N_MCP_TOKEN)"
        : `n8n answered ${res.status} ${res.statusText}${text !== "" ? `: ${text.slice(0, 300)}` : ""}`;
      log.warn(detail);
      for (const id of ids) emit(rpcError(id, UPSTREAM_ERROR, detail));
      return;
    }
    if (text === "") return; // 202 for notifications — nothing to relay
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      // SSE: each data: line is one JSON-RPC message (response and/or
      // server notifications) — relay every one, a line each.
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          emit(JSON.parse(line.slice(5).trim()));
        } catch {
          // comment/heartbeat line — skip
        }
      }
      return;
    }
    try {
      emit(JSON.parse(text)); // plain JSON body (message or batch) — one line
    } catch {
      const detail = `n8n answered 200 with non-JSON content — is ${host} really your n8n instance (captive portal, proxy)?`;
      for (const id of ids) emit(rpcError(id, UPSTREAM_ERROR, detail));
    }
  };

  /** Guard one incoming line: answer blocked writes locally, forward the rest. */
  const handleLine = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return emit(rpcError(null, PARSE_ERROR, "decanter guard: unparseable JSON-RPC line — refusing to forward (fail closed)"));
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const ids: unknown[] = [];
    for (const msg of messages) {
      if (msg === null || typeof msg !== "object") {
        return emit(rpcError(null, PARSE_ERROR, "decanter guard: malformed JSON-RPC message — refusing to forward (fail closed)"));
      }
      const record = msg as Record<string, unknown>;
      const blocked = guardMessage(record);
      if (blocked !== null) {
        log.warn("blocked a jsCode write (update_workflow) — pointed the agent at the file + push flow");
        return emit(Array.isArray(parsed) ? [blocked] : blocked);
      }
      if (record.id !== undefined) ids.push(record.id);
    }
    await forward(parsed, ids);
  };

  // Strictly ordered processing: chain each line onto the previous one.
  let queue: Promise<void> = Promise.resolve();
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      queue = queue.then(() => handleLine(line)).catch((err: Error) => log.warn(`guard error: ${err.message}`));
    });
    rl.on("close", () => resolve());
  });
  await queue; // drain in-flight work before exiting with the agent
}
