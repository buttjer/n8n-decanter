// Unit tests for the MCP client + auth plumbing (lib/mcp.mts, Plan 32):
// envelope/SSE parsing, session id echo, error normalization, auth
// resolution precedence, and the OAuth refresh-rotation persistence — all
// against a tiny in-process node:http server (no real n8n).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import {
  authFilePath,
  isUnavailableInMcp,
  McpClient,
  McpToolError,
  oauthDiscovery,
  readAuthFile,
  resolveMcpAuth,
  writeAuthFile,
} from "../../lib/mcp.mts";
import type { Log } from "../../lib/types.mts";

const TMP = mkdtempSync(path.join(os.tmpdir(), "decanter-mcp-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function capturingLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const push = (tag: string) => (m: string) => lines.push(`${tag} ${m}`);
  return { log: { info: push("info"), ok: push("ok"), warn: push("warn"), error: push("error") }, lines };
}

/** A scripted MCP server: `handler` maps a tool name to its result envelope. */
async function mcpServer(opts: {
  token?: string;
  sse?: boolean;
  tool?: (name: string, args: any, req: http.IncomingMessage) => any;
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
}): Promise<{ host: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    if (opts.onRequest?.(req, res)) return;
    if (req.url !== "/mcp-server/http") return void res.writeHead(404).end();
    if (opts.token !== undefined && req.headers.authorization !== `Bearer ${opts.token}`) return void res.writeHead(401).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      requests.push(msg.method === "tools/call" ? `tools/call:${msg.params.name}` : msg.method);
      if (msg.method === "initialize") {
        return void res
          .writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } }));
      }
      if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
      const result = opts.tool?.(msg.params.name, msg.params.arguments, req) ?? { content: [{ type: "text", text: "{}" }] };
      if (opts.sse !== false) {
        res.writeHead(200, { "content-type": "text/event-stream" })
          .end(`: heartbeat\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const host = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return { host, requests, close: () => new Promise((r) => server.close(() => r())) };
}

describe("McpClient.callTool", () => {
  it("initializes once, echoes the session id, and parses SSE tool results", async () => {
    let seenSession: string | undefined;
    const srv = await mcpServer({
      token: "tok",
      tool: (_name, _args, req) => {
        seenSession = req.headers["mcp-session-id"] as string | undefined;
        return { content: [{ type: "text", text: '{"data":[1,2]}' }], structuredContent: { data: [1, 2] } };
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "tok" } });
      const first = await mcp.callTool<{ data: number[] }>("search_workflows", {});
      assert.deepEqual(first.data, [1, 2], "structuredContent preferred");
      await mcp.callTool("search_workflows", {});
      assert.deepEqual(srv.requests, ["initialize", "notifications/initialized", "tools/call:search_workflows", "tools/call:search_workflows"], "handshake exactly once");
      assert.equal(seenSession, "sess-1", "session id echoed on later calls");
    } finally {
      await srv.close();
    }
  });

  it("falls back to parsing the text content when structuredContent is absent (plain JSON responses too)", async () => {
    const srv = await mcpServer({ sse: false, tool: () => ({ content: [{ type: "text", text: '{"ok":true}' }] }) });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      assert.deepEqual(await mcp.callTool("anything", {}), { ok: true });
    } finally {
      await srv.close();
    }
  });

  it("normalizes isError results to McpToolError, unwrapping {\"error\": …} JSON", async () => {
    const srv = await mcpServer({
      tool: (name) => name === "plain"
        ? { content: [{ type: "text", text: "Workflow is not available in MCP. Enable MCP access from the workflow card in the workflows list, or from the workflow settings." }], isError: true }
        : { content: [{ type: "text", text: '{"error":"Operation 0 failed: node \'X\' not found"}' }], isError: true },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      await assert.rejects(mcp.callTool("plain", {}), (err: Error) => {
        assert.ok(err instanceof McpToolError);
        assert.ok(isUnavailableInMcp(err), "the unavailable refusal is classifiable");
        return true;
      });
      await assert.rejects(mcp.callTool("json", {}), /Operation 0 failed: node 'X' not found/);
    } finally {
      await srv.close();
    }
  });

  it("maps 401 (bearer) and 404 to actionable errors", async () => {
    const srv = await mcpServer({ token: "right" });
    try {
      const bad = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "wrong" } });
      await assert.rejects(bad.callTool("x", {}), /MCP token was rejected \(401\)/);
    } finally {
      await srv.close();
    }
    const plain = http.createServer((_req, res) => void res.writeHead(404).end());
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", () => r()));
    const host404 = `http://127.0.0.1:${(plain.address() as import("node:net").AddressInfo).port}`;
    try {
      const mcp = new McpClient({ host: host404, auth: { kind: "bearer", token: "x" } });
      await assert.rejects(mcp.callTool("x", {}), /no MCP endpoint .*404.*enable MCP access/is);
    } finally {
      await new Promise<void>((r) => plain.close(() => r()));
    }
  });
});

describe("resolveMcpAuth", () => {
  let dir: string;
  let seq = 0;
  beforeEach(() => {
    dir = path.join(TMP, `auth-${seq++}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    delete process.env.N8N_MCP_TOKEN;
  });
  afterEach(() => {
    delete process.env.N8N_MCP_TOKEN;
  });

  it("N8N_MCP_TOKEN wins over the auth file", () => {
    writeAuthFile(dir, { host: "http://h", clientId: "c", refreshToken: "r" });
    process.env.N8N_MCP_TOKEN = "envtok";
    const auth = resolveMcpAuth(dir, "http://h");
    assert.deepEqual(auth, { kind: "bearer", token: "envtok" });
  });

  it("uses the OAuth file when the host matches; ignores it (with a warning) when it doesn't", () => {
    writeAuthFile(dir, { host: "http://h", clientId: "c", refreshToken: "r" });
    const hit = resolveMcpAuth(dir, "http://h");
    assert.equal(hit?.kind, "oauth");
    const { log, lines } = capturingLog();
    assert.equal(resolveMcpAuth(dir, "http://other", log), null);
    assert.match(lines.join("\n"), /minted for http:\/\/h, not http:\/\/other/);
  });

  it("returns null with no credentials; auth file round-trips; corrupt file names itself", () => {
    assert.equal(resolveMcpAuth(dir, "http://h"), null);
    writeAuthFile(dir, { host: "http://h", clientId: "c", refreshToken: "r", accessToken: "a", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z" });
    assert.equal(readAuthFile(dir)?.accessToken, "a");
    fsWriteFileSync(authFilePath(dir), "{nope");
    assert.throws(() => readAuthFile(dir), /corrupt \.decanter-auth\.json/);
  });
});

describe("OAuth refresh rotation", () => {
  it("refreshes an expired access token, persists the ROTATED refresh token, and retries", async () => {
    // token endpoint state: refresh "r1" is valid once, rotates to "r2"
    let tokenCalls = 0;
    const srv = await mcpServer({
      token: "fresh-access",
      tool: () => ({ content: [{ type: "text", text: '{"fine":true}' }] }),
      onRequest: (req, res) => {
        if (req.url === "/.well-known/oauth-authorization-server") {
          // the instance advertises ITS OWN idea of its URL — re-based by the client
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            issuer: "http://localhost:5678",
            authorization_endpoint: "http://localhost:5678/mcp-oauth/authorize",
            token_endpoint: "http://localhost:5678/mcp-oauth/token",
            registration_endpoint: "http://localhost:5678/mcp-oauth/register",
          }));
          return true;
        }
        if (req.url === "/mcp-oauth/token") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            tokenCalls++;
            const params = new URLSearchParams(body);
            if (params.get("refresh_token") !== "r1") {
              res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
              access_token: "fresh-access", token_type: "Bearer", expires_in: 3600, refresh_token: "r2",
            }));
          });
          return true;
        }
        return false;
      },
    });
    const dir = path.join(TMP, "rotate");
    mkdirSync(dir, { recursive: true });
    try {
      // expired access token on disk forces a refresh before the first call
      writeAuthFile(dir, { host: srv.host, clientId: "c1", refreshToken: "r1", accessToken: "stale", accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" });
      const auth = resolveMcpAuth(dir, srv.host)!;
      const mcp = new McpClient({ host: srv.host, auth });
      const out = await mcp.callTool<{ fine: boolean }>("probe", {});
      assert.equal(out.fine, true);
      assert.equal(tokenCalls, 1, "exactly one refresh");
      const persisted = readAuthFile(dir)!;
      assert.equal(persisted.refreshToken, "r2", "rotated refresh token persisted immediately");
      assert.equal(persisted.accessToken, "fresh-access");
      // a second client run reuses the cached access token — no extra refresh
      const mcp2 = new McpClient({ host: srv.host, auth: resolveMcpAuth(dir, srv.host)! });
      await mcp2.callTool("probe", {});
      assert.equal(tokenCalls, 1, "cached access token reused across runs");
    } finally {
      await srv.close();
    }
  });

  it("an already-used refresh token surfaces as 'run init again'", async () => {
    const srv = await mcpServer({
      token: "never",
      onRequest: (req, res) => {
        if (req.url === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            authorization_endpoint: "http://x/mcp-oauth/authorize",
            token_endpoint: "http://x/mcp-oauth/token",
            registration_endpoint: "http://x/mcp-oauth/register",
          }));
          return true;
        }
        if (req.url === "/mcp-oauth/token") {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid refresh token" }));
          return true;
        }
        return false;
      },
    });
    const dir = path.join(TMP, "rotate-dead");
    mkdirSync(dir, { recursive: true });
    try {
      writeAuthFile(dir, { host: srv.host, clientId: "c1", refreshToken: "used-up" });
      const mcp = new McpClient({ host: srv.host, auth: resolveMcpAuth(dir, srv.host)! });
      await assert.rejects(mcp.callTool("probe", {}), /MCP session expired.*invalid_grant.*n8n-decanter init/s);
    } finally {
      await srv.close();
    }
  });
});

describe("oauthDiscovery", () => {
  it("re-bases every advertised endpoint onto the reachable host", async () => {
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            authorization_endpoint: "http://localhost:5678/mcp-oauth/authorize",
            token_endpoint: "https://internal.example/mcp-oauth/token",
            registration_endpoint: "http://localhost:5678/mcp-oauth/register",
          }));
          return true;
        }
        return false;
      },
    });
    try {
      const d = await oauthDiscovery(srv.host, 5000);
      assert.equal(d.authorization_endpoint, `${srv.host}/mcp-oauth/authorize`);
      assert.equal(d.token_endpoint, `${srv.host}/mcp-oauth/token`);
      assert.equal(d.registration_endpoint, `${srv.host}/mcp-oauth/register`);
    } finally {
      await srv.close();
    }
  });
});
