// The stdio MCP guard (`mcp connect`): the same Code-node boundary as the
// HTTP guard-proxy (`mcp serve`), but as a stdio MCP server an agent spawns
// itself — which is what lets `init` scaffold a static, secret-free
// `.mcp.json` entry ({"command":"npx","args":["--no-install","n8n-decanter","mcp","connect"]};
// the `npx --no-install` prefix resolves the command under a local install
// too, where a bare `n8n-decanter` is off the agent's PATH — Plan 58).
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
import { MCP_PATH, type McpClient, PROTOCOL_VERSION } from "./mcp.mts";
import { attachMirrorNotices, guardMessage, guardPublish, logToolCall, mirrorTargetId } from "./mcpserve.mts";
import type { Mirror } from "./mirror.mts";
import type { Log } from "./types.mts";

/** JSON-RPC error codes used by the bridge (server-defined range). */
const PARSE_ERROR = -32700;
const UPSTREAM_ERROR = -32001;

interface StdioGuardOptions {
  mcp: McpClient;
  host: string;
  /** Per-request upstream timeout (decanter.config.json `requestTimeoutMs`). */
  timeoutMs: number;
  /**
   * Live snapshot mirror (Plan 51 Part A): scheduled after a forwarded,
   * non-blocked `update_workflow` so the local snapshot refreshes without a
   * manual `pull`. Omit / undefined to disable.
   */
  mirror?: Mirror;
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

/** The single `initialize` request in a unit, or null (batches are not one). */
function initializeRequest(unit: unknown): Record<string, unknown> | null {
  if (unit === null || typeof unit !== "object" || Array.isArray(unit)) return null;
  const msg = unit as Record<string, unknown>;
  return msg.method === "initialize" && msg.id !== undefined ? msg : null;
}

/**
 * The handshake the guard answers with when n8n cannot be reached.
 *
 * An error here is fatal to the whole session: an MCP client that gets no
 * `serverInfo` tears the connection down and never makes the tool call whose
 * failure it could have reported. So the guard — which is itself the server the
 * agent spawned, and is running fine — completes the handshake with its own
 * identity, and the unreachable instance surfaces on the first forwarded call.
 * No capability beyond `tools` is claimed: everything else is n8n's to answer.
 */
function localInitializeResult(request: Record<string, unknown>): Record<string, unknown> {
  const params = (request.params ?? {}) as { protocolVersion?: unknown };
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "n8n-decanter guard", version: "0" },
    },
  };
}

/**
 * Run the stdio guard until stdin closes (the agent ending the session).
 * Messages are processed strictly in order — an MCP client awaits its
 * responses anyway, and ordering keeps the initialize → session-id capture
 * race-free.
 */
export async function runStdioGuard({ mcp, host, timeoutMs, mirror, log, input = process.stdin, output = process.stdout }: StdioGuardOptions): Promise<void> {
  const upstream = host + MCP_PATH;
  let sessionId: string | undefined;

  // Say we are alive BEFORE any traffic. A guard that only ever speaks to
  // report a block leaves an empty log meaning two opposite things — "ran,
  // blocked nothing" and "never started" — and they are indistinguishable
  // exactly when it matters. (A Plan 35 harness bug left the guard dead for
  // three committed field-test rounds; the silence read as innocence.)
  // "ready", not "connected": nothing has been contacted yet, and the line
  // claiming a live instance while the first handshake was still failing is
  // exactly what made an unreachable host read as a decanter bug.
  log.info(`guard: ready — forwarding all n8n MCP tools to ${host}, blocking jsCode writes in update_workflow`);

  /** One protocol message (or batch) out — a single output line. */
  const emit = (message: unknown): void => {
    // Every outgoing message passes here, which makes this the one place a
    // background live-mirror notice can reach the agent (Plan 68).
    output.write(`${JSON.stringify(attachMirrorNotices(message, () => mirror?.takeNotices() ?? []))}\n`);
  };

  /**
   * A handshake this guard answered itself because n8n was down. n8n never saw
   * it, so the HTTP session is uninitialized — it has to be replayed before the
   * next forward, or every later call rides a session n8n never opened.
   */
  let deferredHandshake: unknown = null;

  /** One upstream attempt: the decoded body, or why it failed. */
  type Attempt = { ok: true; text: string; sse: boolean } | { ok: false; detail: string };

  const attempt = async (unit: unknown): Promise<Attempt> => {
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
      return { ok: false, detail: `n8n unreachable through the decanter guard (${reason}) — is ${host} up?` };
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid !== null) sessionId = sid;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // 401/403 lead with the CAUSE, not with `init`. A blind round (ftrun-73440)
      // watched an agent read the old "run `n8n-decanter init`" wording and tell
      // its user the project "has never been set up — no .env, no token", when
      // the .env existed and was correct: the token had merely been rotated. The
      // CLI's own 401 says the right thing; this one has to match it, because it
      // is the message an agent sees FIRST.
      const detail = res.status === 401
        ? "n8n rejected decanter's existing MCP credentials (401) — they are configured but no longer valid. Mint a fresh token in n8n (Settings → MCP) and update N8N_MCP_TOKEN, or re-run `n8n-decanter init` for OAuth. This is NOT a missing-setup error."
        : res.status === 403
          ? `n8n refused the request (403)${text !== "" ? `: ${text.slice(0, 200)}` : ""} — MCP access is switched off for this instance (n8n → Settings → MCP), or this token's user lacks access`
          : `n8n answered ${res.status} ${res.statusText}${text !== "" ? `: ${text.slice(0, 300)}` : ""}`;
      log.warn(detail);
      return { ok: false, detail };
    }
    return { ok: true, text, sse: (res.headers.get("content-type") ?? "").includes("text/event-stream") };
  };

  /** Forward one already-guarded JSON-RPC unit (message or batch) upstream. */
  const forward = async (unit: unknown, ids: unknown[]): Promise<void> => {
    // Replay a handshake n8n never saw, so a recovered instance does not answer
    // every later call with "session not initialized". Failure is not reported
    // here — the real message follows and carries the error to the caller.
    if (deferredHandshake !== null && sessionId === undefined) {
      if ((await attempt(deferredHandshake)).ok) {
        deferredHandshake = null;
        await attempt({ jsonrpc: "2.0", method: "notifications/initialized" });
        log.info(`guard: reached ${host} — the handshake answered locally is now live upstream`);
      }
    }

    const result = await attempt(unit);
    if (!result.ok) {
      // A failed HANDSHAKE is answered by the guard itself: an error there ends
      // the session before a single tool call is made, and the agent is left
      // with a dead server instead of a working one pointed at a down instance.
      const handshake = initializeRequest(unit);
      if (handshake !== null) {
        deferredHandshake = unit;
        log.warn(`guard: n8n did not answer the handshake — completing it locally so the session survives; tool calls will report: ${result.detail}`);
        return emit(localInitializeResult(handshake));
      }
      for (const id of ids) emit(rpcError(id, UPSTREAM_ERROR, result.detail));
      return;
    }
    if (result.text === "") return; // 202 for notifications — nothing to relay
    if (result.sse) {
      // SSE: each data: line is one JSON-RPC message (response and/or
      // server notifications) — relay every one, a line each.
      for (const line of result.text.split("\n")) {
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
      emit(JSON.parse(result.text)); // plain JSON body (message or batch) — one line
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
    const mirrorIds: string[] = []; // forwardable update_workflow targets to refresh
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
      // Second gate (Plan 64 task 3c): a publish only forwards when the draft it
      // would take live is clean. Async — it needs a read — which is why it is
      // separate from the synchronous `guardMessage`, and shared with `mcp serve`
      // for the same reason that one is: the transports must not drift.
      const publishBlocked = await guardPublish(record, mcp, log);
      if (publishBlocked !== null) return emit(Array.isArray(parsed) ? [publishBlocked] : publishBlocked);
      // Audit trail: one line per tool call the guard lets through. NAME ONLY —
      // arguments carry workflow content and would make this log a PII/secret
      // surface. Every n8n MCP call an agent makes passes through here, so this
      // is the one place that can answer "what did the agent do to my instance?"
      logToolCall(record, log);
      if (record.id !== undefined) ids.push(record.id);
      // Live mirror (Plan 51 Part A): a forwardable structure edit — refresh the
      // local snapshot after it lands (none reach here blocked; a block returns).
      const target = mirror ? mirrorTargetId(record) : null;
      if (target !== null) mirrorIds.push(target);
    }
    await forward(parsed, ids);
    // Optimistic on forward: schedule once forwarded — non-blocking, debounced.
    for (const id of mirrorIds) mirror?.schedule(id);
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
  await mirror?.drain(); // let a pending snapshot refresh finish before exit
}
