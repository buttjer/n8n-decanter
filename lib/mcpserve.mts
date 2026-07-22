// The MCP guard-proxy (Plan 33 Task 4): technical enforcement of the
// Code-node boundary. Decanter is the sole n8n-credential holder; an agent's
// MCP client points at this localhost proxy, which forwards JSON-RPC to the
// instance's `POST /mcp-server/http` — EXCEPT `update_workflow` calls whose
// arguments contain a `jsCode` key anywhere (op types deliberately not
// enumerated; the op surface churns). Those are answered with an instructive
// tool error: Code-node source is files + `n8n-decanter push`.
//
// Requests are parsed; responses (incl. SSE) pipe through untouched. Parse
// failures fail CLOSED. Blast radius is availability, not integrity —
// decanter's own sync never routes through the proxy.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { unlinkSync, writeFileSync } from "node:fs";
import { MCP_PATH, type McpClient } from "./mcp.mts";
import type { Log } from "./types.mts";

/** Gitignored discovery file (sync-dir root): the running proxy's endpoint + secret. */
export const PROXY_STATE_FILE = ".decanter-proxy.json";

/** Default listen port — one above the browser-reload proxy's 5679. */
export const DEFAULT_GUARD_PORT = 5680;

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The guidance an agent sees when a jsCode write is blocked. */
export const JSCODE_BLOCK_TEXT =
  "blocked by the n8n-decanter guard-proxy: Code-node source (jsCode) is managed as files in this repo. " +
  "Edit the node's file under workflows/<workflow>/code/ and run `n8n-decanter push` (or ask the user to). " +
  "Structure operations (wiring, parameters other than jsCode, renames, new non-code fields) pass through normally.";

export interface GuardProxyHandle {
  url: string;
  secret: string;
  port: number;
  close: () => Promise<void>;
}

/** True when a `jsCode` key exists anywhere in the value (objects/arrays, any depth). */
export function containsJsCodeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsJsCodeKey);
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "jsCode") return true;
      if (containsJsCodeKey(v)) return true;
    }
  }
  return false;
}

/**
 * The per-message guard: `null` = forward; otherwise the JSON-RPC response
 * body answering the blocked call. Only `tools/call` → `update_workflow`
 * with a `jsCode` key anywhere in its arguments is blocked — everything
 * else (reads, structure ops, other tools, handshakes) passes.
 */
export function guardMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.method !== "tools/call") return null;
  const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
  if (params?.name !== "update_workflow") return null;
  if (!containsJsCodeKey(params.arguments)) return null;
  const result = { content: [{ type: "text", text: JSON.stringify({ error: JSCODE_BLOCK_TEXT }) }], isError: true };
  return { jsonrpc: "2.0", id: (msg as { id?: unknown }).id ?? null, result };
}

/**
 * Start the guard proxy on 127.0.0.1. Auth is a per-session random secret
 * (the agent's MCP config carries it; the n8n credential never leaves this
 * process). The current endpoint + secret land in a gitignored
 * `.decanter-proxy.json` for tooling (the config-drift hook) to discover.
 */
export async function startGuardProxy(
  { mcp, host, configDir, port = DEFAULT_GUARD_PORT, log }: { mcp: McpClient; host: string; configDir: string; port?: number; log: Log },
): Promise<GuardProxyHandle> {
  const secret = randomBytes(24).toString("base64url");
  const upstream = host + MCP_PATH;

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== `Bearer ${secret}`) {
        return void res.writeHead(401, { "content-type": "text/plain" }).end("guard-proxy: bad or missing session secret — restart your agent with the secret `mcp serve` printed");
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        return void res.writeHead(405).end();
      }

      let body: Buffer | undefined;
      if (req.method === "POST") {
        // Classic event reading, not for-await: on an oversized body we answer
        // 413 while DRAINING the rest — destroying the socket mid-upload would
        // reset the connection before the client can read the response.
        const read = await new Promise<{ kind: "ok"; body: Buffer } | { kind: "toobig" } | { kind: "err" }>((resolve) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let done = false;
          const finish = (r: { kind: "ok"; body: Buffer } | { kind: "toobig" } | { kind: "err" }) => {
            if (!done) {
              done = true;
              resolve(r);
            }
          };
          req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) finish({ kind: "toobig" }); // later chunks drain, unbuffered
            else if (!done) chunks.push(chunk);
          });
          req.on("end", () => finish({ kind: "ok", body: Buffer.concat(chunks) }));
          req.on("error", () => finish({ kind: "err" }));
        });
        if (read.kind === "toobig") {
          return void res.writeHead(413, { "content-type": "text/plain" }).end("guard-proxy: request body too large");
        }
        if (read.kind === "err") return void res.writeHead(400).end();
        body = read.body;

        // Fail closed: a body this proxy cannot parse is a body it cannot
        // guard. (MCP clients always send JSON-RPC JSON.)
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          return void res.writeHead(403, { "content-type": "text/plain" }).end("guard-proxy: unparseable JSON-RPC body — refusing to forward (fail closed)");
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of messages) {
          if (msg === null || typeof msg !== "object") {
            return void res.writeHead(403, { "content-type": "text/plain" }).end("guard-proxy: malformed JSON-RPC message — refusing to forward (fail closed)");
          }
          const blocked = guardMessage(msg as Record<string, unknown>);
          if (blocked !== null) {
            log.warn(`blocked a jsCode write (update_workflow) — pointed the agent at the file + push flow`);
            return void res
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(Array.isArray(parsed) ? [blocked] : blocked));
          }
        }
      }

      // Forward with the real credential; retry once on an upstream 401
      // (expired access token — bearerToken(true) redeems/refreshes).
      let upstreamRes: Response;
      try {
        for (let attempt = 0; ; attempt++) {
          const token = await mcp.bearerToken(attempt > 0);
          upstreamRes = await fetch(upstream, {
            method: req.method,
            headers: {
              authorization: `Bearer ${token}`,
              ...(req.headers["content-type"] !== undefined && { "content-type": req.headers["content-type"] }),
              accept: req.headers.accept ?? "application/json, text/event-stream",
              ...(req.headers["mcp-session-id"] !== undefined && { "mcp-session-id": String(req.headers["mcp-session-id"]) }),
              ...(req.headers["mcp-protocol-version"] !== undefined && { "mcp-protocol-version": String(req.headers["mcp-protocol-version"]) }),
            },
            body: body === undefined ? undefined : new Uint8Array(body),
          });
          if (upstreamRes.status !== 401 || attempt > 0) break;
        }
      } catch (err) {
        log.warn(`upstream request failed: ${(err as Error).message}`);
        return void res.writeHead(502, { "content-type": "text/plain" }).end(`guard-proxy: upstream n8n unreachable (${(err as Error).message})`);
      }

      const headers: Record<string, string> = {};
      for (const name of ["content-type", "mcp-session-id"]) {
        const value = upstreamRes.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      res.writeHead(upstreamRes.status, headers);
      if (upstreamRes.body === null) return void res.end();
      // responses (incl. SSE) pipe through untouched
      Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
    })().catch((err) => {
      log.warn(`guard-proxy request failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${actualPort}${MCP_PATH}`;

  const stateFile = path.join(configDir, PROXY_STATE_FILE);
  try {
    // discovery for tooling (the config-drift hook); gitignored, 0600
    writeFileSync(stateFile, JSON.stringify({ url, secret, pid: process.pid }, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    log.warn(`could not write ${PROXY_STATE_FILE} (${(err as Error).message}) — the config-drift hook won't find the proxy`);
  }

  return {
    url,
    secret,
    port: actualPort,
    close: async () => {
      try {
        unlinkSync(stateFile);
      } catch {
        // best-effort cleanup
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
