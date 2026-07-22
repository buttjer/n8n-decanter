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
  refreshAccessToken,
  resolveMcpAuth,
  runOAuthConsent,
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

/** OAuth discovery + token endpoint scaffold for the race/backoff suites. */
function oauthEndpoints(handleToken: (params: URLSearchParams, res: http.ServerResponse) => void) {
  return (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        authorization_endpoint: "http://x/mcp-oauth/authorize",
        token_endpoint: "http://x/mcp-oauth/token",
        registration_endpoint: "http://x/mcp-oauth/register",
      }));
      return true;
    }
    if (req.url === "/mcp-oauth/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handleToken(new URLSearchParams(body), res));
      return true;
    }
    return false;
  };
}

const grant = (res: http.ServerResponse, accessToken: string, refreshToken?: string): void =>
  void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    access_token: accessToken, token_type: "Bearer", expires_in: 3600,
    ...(refreshToken !== undefined && { refresh_token: refreshToken }),
  }));

const denyGrant = (res: http.ServerResponse): void =>
  void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));

describe("refresh-token race (Plan 33 HIGH fix)", () => {
  it("two parallel callTool()s share ONE redemption of the single-use refresh token", async () => {
    let tokenCalls = 0;
    const srv = await mcpServer({
      token: "fresh-access",
      tool: () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      onRequest: oauthEndpoints((params, res) => {
        tokenCalls++;
        if (params.get("refresh_token") !== "r1" || tokenCalls > 1) return denyGrant(res); // single-use: a second r1 redeem is a bug
        grant(res, "fresh-access", "r2");
      }),
    });
    const dir = path.join(TMP, "race-parallel");
    mkdirSync(dir, { recursive: true });
    try {
      writeAuthFile(dir, { host: srv.host, clientId: "c1", refreshToken: "r1" }); // no cached access token → both calls need a refresh
      const mcp = new McpClient({ host: srv.host, auth: resolveMcpAuth(dir, srv.host)! });
      const [a, b] = await Promise.all([mcp.callTool<{ ok: boolean }>("one", {}), mcp.callTool<{ ok: boolean }>("two", {})]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(tokenCalls, 1, "concurrent callers must join the same in-flight refresh");
      assert.equal(readAuthFile(dir)!.refreshToken, "r2", "rotation persisted");
    } finally {
      await srv.close();
    }
  });

  it("a lost cross-process race (invalid_grant) recovers by re-reading the winner's auth file", async () => {
    // The "winner" (another decanter process) redeemed r1 first: when OUR
    // redeem of r1 arrives, the server rewrites the auth file with the
    // winner's fresh state (r2 + valid access token), then answers
    // invalid_grant — exactly the race timing.
    const dir = path.join(TMP, "race-lost");
    mkdirSync(dir, { recursive: true });
    let tokenCalls = 0;
    const srv = await mcpServer({
      token: "winner-access",
      tool: () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      onRequest: oauthEndpoints((_params, res) => {
        tokenCalls++;
        writeAuthFile(dir, {
          host: srvHost, clientId: "c1", refreshToken: "r2",
          accessToken: "winner-access", accessTokenExpiresAt: new Date(Date.now() + 3_000_000).toISOString(),
        });
        denyGrant(res);
      }),
    });
    const srvHost = srv.host;
    try {
      writeAuthFile(dir, { host: srv.host, clientId: "c1", refreshToken: "r1" });
      const mcp = new McpClient({ host: srv.host, auth: resolveMcpAuth(dir, srv.host)! });
      const out = await mcp.callTool<{ ok: boolean }>("probe", {});
      assert.equal(out.ok, true, "recovered with the winner's access token");
      assert.equal(tokenCalls, 1, "no second redemption needed — the winner's cached token was adopted");
      assert.equal(readAuthFile(dir)!.refreshToken, "r2", "the winner's rotation survives");
    } finally {
      await srv.close();
    }
  });

  it("401 on a timestamp-valid cached token forces exactly one refresh, then succeeds", async () => {
    let tokenCalls = 0;
    const srv = await mcpServer({
      token: "fresh-access", // the server only accepts the refreshed token — the cached one 401s
      tool: () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      onRequest: oauthEndpoints((params, res) => {
        tokenCalls++;
        assert.equal(params.get("refresh_token"), "r1");
        grant(res, "fresh-access", "r2");
      }),
    });
    const dir = path.join(TMP, "force-refresh");
    mkdirSync(dir, { recursive: true });
    try {
      writeAuthFile(dir, {
        host: srv.host, clientId: "c1", refreshToken: "r1",
        accessToken: "stale-but-timestamp-valid", accessTokenExpiresAt: new Date(Date.now() + 3_000_000).toISOString(),
      });
      const mcp = new McpClient({ host: srv.host, auth: resolveMcpAuth(dir, srv.host)! });
      const out = await mcp.callTool<{ ok: boolean }>("probe", {});
      assert.equal(out.ok, true);
      assert.equal(tokenCalls, 1, "exactly one refresh after the 401");
    } finally {
      await srv.close();
    }
  });

  it("a refresh response WITHOUT a rotated refresh_token keeps the old one instead of persisting 'undefined'", async () => {
    const srv = await mcpServer({
      onRequest: oauthEndpoints((_params, res) => grant(res, "acc-1")), // no refresh_token in the response
    });
    try {
      const tokens = await refreshAccessToken(srv.host, "c1", "keep-me", 5000);
      assert.equal(tokens.refreshToken, "keep-me", "old token kept, not String(undefined)");
      assert.equal(tokens.accessToken, "acc-1");
    } finally {
      await srv.close();
    }
  });
});

describe("429 backoff", () => {
  it("honors Retry-After (capped at 30s), falls back to exponential delays, and gives up after 5 retries", async () => {
    let attempts = 0;
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
            return;
          }
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          attempts++;
          if (attempts === 1) return void res.writeHead(429, { "retry-after": "7200" }).end("later"); // bogus-huge header → capped at n8n's real 5-min window
          if (attempts <= 6) return void res.writeHead(429).end("later"); // no header → exponential
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "{}" }] } }));
        });
        return true;
      },
    });
    const delays: number[] = [];
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" }, sleep: async (ms) => void delays.push(ms) });
      // 5 retries after the first 429 → attempts 2..6 are still 429 → the 6th response ends the loop as an error
      await assert.rejects(mcp.callTool("probe", {}), /MCP tools\/call failed: 429/);
      assert.equal(attempts, 6, "1 initial + 5 retries");
      assert.deepEqual(delays, [310_000, 2000, 4000, 8000, 8000], "Retry-After capped at n8n's verified 5-min window (+margin), then exponential over the TOTAL retry count (capped at 8s)");
    } finally {
      await srv.close();
    }
  });

  it("a single 429 then 200 retries transparently", async () => {
    let attempts = 0;
    const srv = await mcpServer({
      tool: () => {
        attempts++;
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http" || attempts > 0) return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method !== "tools/call") {
            // let the handshake through untouched
            if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
            return void res.writeHead(202).end();
          }
          attempts++;
          res.writeHead(429, { "retry-after": "1" }).end("busy");
        });
        return true;
      },
    });
    const delays: number[] = [];
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" }, sleep: async (ms) => void delays.push(ms) });
      const out = await mcp.callTool<{ ok: boolean }>("probe", {});
      assert.equal(out.ok, true);
      assert.deepEqual(delays, [1000], "one Retry-After-driven delay");
    } finally {
      await srv.close();
    }
  });
});

describe("client resilience", () => {
  it("a failed handshake does not poison later calls (initialized reset on rejection)", async () => {
    let initTries = 0;
    const srv = await mcpServer({
      tool: () => ({ content: [{ type: "text", text: '{"ok":true}' }] }),
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize" && ++initTries === 1) {
            return void res.writeHead(500).end("transient");
          }
          if (msg.method === "initialize") {
            return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-2" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          }
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }));
        });
        return true;
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      await assert.rejects(mcp.callTool("probe", {}), /MCP initialize failed: 500/);
      const out = await mcp.callTool<{ ok: boolean }>("probe", {});
      assert.equal(out.ok, true, "the second call re-attempts the handshake");
      assert.equal(initTries, 2);
    } finally {
      await srv.close();
    }
  });

  it("names the captive-portal case: 200 with non-JSON body", async () => {
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          res.writeHead(200, { "content-type": "text/html" }).end("<html>Hotel WiFi Login</html>");
        });
        return true;
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      await assert.rejects(mcp.callTool("probe", {}), /non-JSON content.*Hotel WiFi Login.*really your n8n instance/s);
    } finally {
      await srv.close();
    }
  });

  it("re-initializes once when the server dropped the session (404 with a session id)", async () => {
    let dropped = false;
    let session = "sess-1";
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") {
            return void res.writeHead(200, { "content-type": "application/json", "mcp-session-id": session }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          }
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          // a dropped session: the server 404s the stale session id once
          if (dropped && req.headers["mcp-session-id"] === "sess-1") {
            return void res.writeHead(404).end("session not found");
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }));
        });
        return true;
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      await mcp.callTool("probe", {}); // establishes sess-1
      dropped = true;
      session = "sess-2"; // the re-handshake mints a new session
      const out = await mcp.callTool<{ ok: boolean }>("probe", {});
      assert.equal(out.ok, true, "one transparent re-initialize instead of the 404 error");
    } finally {
      await srv.close();
    }
  });
});

describe("#rpc edge branches", () => {
  it("skips malformed data: SSE lines and still finds the matching message", async () => {
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          res.writeHead(200, { "content-type": "text/event-stream" }).end(
            `data: {broken json\n` +
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 999999, result: { content: [{ type: "text", text: '{"wrong":true}' }] } })}\n` +
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: '{"ok":true}' }] } })}\n\n`,
          );
        });
        return true;
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      assert.deepEqual(await mcp.callTool("probe", {}), { ok: true }, "malformed + wrong-id lines skipped");
    } finally {
      await srv.close();
    }
  });

  it("surfaces a JSON-RPC error member and the no-response-message case", async () => {
    let mode: "error" | "empty" = "error";
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          if (mode === "error") {
            return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool exploded" } }));
          }
          res.writeHead(200, { "content-type": "text/event-stream" }).end(": nothing but a comment\n\n");
        });
        return true;
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      await assert.rejects(mcp.callTool("probe", {}), /MCP tools\/call error: tool exploded/);
      mode = "empty";
      await assert.rejects(mcp.callTool("probe", {}), /MCP tools\/call: no response message/);
    } finally {
      await srv.close();
    }
  });

  it("maps a non-401/404/429 status to the generic failure with the body excerpt", async () => {
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url !== "/mcp-server/http") return false;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "initialize") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
          if (String(msg.method).startsWith("notifications/")) return void res.writeHead(202).end();
          res.writeHead(500).end("boom from n8n");
        });
        return true;
      },
    });
    try {
      const mcp = new McpClient({ host: srv.host, auth: { kind: "bearer", token: "x" } });
      await assert.rejects(mcp.callTool("probe", {}), /MCP tools\/call failed: 500[\s\S]*boom from n8n/);
    } finally {
      await srv.close();
    }
  });
});

describe("runOAuthConsent (init's browser flow)", () => {
  /**
   * A scripted OAuth server: register mints a client id; the token endpoint
   * verifies code+PKCE-verifier presence and answers a full token pair. The
   * TEST plays the browser via the injectable `openBrowser` hook — it parses
   * the authorize URL and drives the CLI's localhost callback.
   */
  async function consentServer(opts: { tokenOk?: boolean } = {}) {
    const seen: { register?: Record<string, unknown>; token?: URLSearchParams } = {};
    const srv = await mcpServer({
      onRequest: (req, res) => {
        if (req.url === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            authorization_endpoint: "http://internal/mcp-oauth/authorize",
            token_endpoint: "http://internal/mcp-oauth/token",
            registration_endpoint: "http://internal/mcp-oauth/register",
          }));
          return true;
        }
        if (req.url === "/mcp-oauth/register") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            seen.register = JSON.parse(body);
            res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ client_id: "client-1" }));
          });
          return true;
        }
        if (req.url === "/mcp-oauth/token") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            seen.token = new URLSearchParams(body);
            if (opts.tokenOk === false) {
              res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
              access_token: "acc-1", token_type: "Bearer", expires_in: 3600, refresh_token: "ref-1",
            }));
          });
          return true;
        }
        return false;
      },
    });
    return { srv, seen };
  }

  const silentLog: Log = { info() {}, ok() {}, warn() {}, error() {} };

  it("happy path: register → browser consent → callback → PKCE token exchange", async () => {
    const { srv, seen } = await consentServer();
    try {
      const { clientId, tokens } = await runOAuthConsent(srv.host, {
        log: silentLog,
        openBrowser: (url) => {
          const u = new URL(url);
          assert.equal(u.searchParams.get("client_id"), "client-1");
          assert.equal(u.searchParams.get("code_challenge_method"), "S256");
          const redirect = new URL(u.searchParams.get("redirect_uri")!);
          redirect.searchParams.set("code", "auth-code-1");
          redirect.searchParams.set("state", u.searchParams.get("state")!);
          void fetch(redirect); // the browser "approving" consent
        },
      });
      assert.equal(clientId, "client-1");
      assert.equal(tokens.accessToken, "acc-1");
      assert.equal(tokens.refreshToken, "ref-1");
      assert.equal(seen.token!.get("grant_type"), "authorization_code");
      assert.equal(seen.token!.get("code"), "auth-code-1");
      assert.ok((seen.token!.get("code_verifier") ?? "").length >= 40, "PKCE verifier sent");
      assert.deepEqual(seen.register!.grant_types, ["authorization_code", "refresh_token"], "refresh grant registered");
    } finally {
      await srv.close();
    }
  });

  it("rejects a state mismatch (CSRF) without exchanging the code", async () => {
    const { srv, seen } = await consentServer();
    try {
      await assert.rejects(
        runOAuthConsent(srv.host, {
          log: silentLog,
          openBrowser: (url) => {
            const u = new URL(url);
            const redirect = new URL(u.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("code", "auth-code-1");
            redirect.searchParams.set("state", "attacker-state");
            void fetch(redirect);
          },
        }),
        /browser consent failed \(state mismatch\)/,
      );
      assert.equal(seen.token, undefined, "no token exchange on a bad state");
    } finally {
      await srv.close();
    }
  });

  it("surfaces an error redirect (user denied consent)", async () => {
    const { srv } = await consentServer();
    try {
      await assert.rejects(
        runOAuthConsent(srv.host, {
          log: silentLog,
          openBrowser: (url) => {
            const u = new URL(url);
            const redirect = new URL(u.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("error", "access_denied");
            redirect.searchParams.set("state", u.searchParams.get("state")!);
            void fetch(redirect);
          },
        }),
        /browser consent failed \(access_denied\)/,
      );
    } finally {
      await srv.close();
    }
  });

  it("times out when the browser consent never arrives", async () => {
    const { srv } = await consentServer();
    try {
      await assert.rejects(
        runOAuthConsent(srv.host, { log: silentLog, openBrowser: () => {}, consentTimeoutMs: 80 }),
        /timed out waiting for the browser consent.*N8N_MCP_TOKEN/s,
      );
    } finally {
      await srv.close();
    }
  });

  it("propagates a failed token exchange after a good consent", async () => {
    const { srv } = await consentServer({ tokenOk: false });
    try {
      await assert.rejects(
        runOAuthConsent(srv.host, {
          log: silentLog,
          openBrowser: (url) => {
            const u = new URL(url);
            const redirect = new URL(u.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("code", "auth-code-1");
            redirect.searchParams.set("state", u.searchParams.get("state")!);
            void fetch(redirect);
          },
        }),
        /OAuth token exchange failed \(invalid_grant\)/,
      );
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
