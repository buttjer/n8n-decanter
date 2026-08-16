// Regression test for the stdio guard's handshake (lib/mcpconnect.mts).
//
// `initialize` was forwarded like any other message, so an unreachable instance
// answered the HANDSHAKE with a JSON-RPC error: the MCP client gets no
// serverInfo and tears the session down before a single tool call is made —
// while the guard's own log line already said "connected to … — forwarding all
// n8n MCP tools". The session must survive; the error belongs on the tool call
// that actually needed the instance.
//
// The happy path (initialize forwarded, upstream session id captured and
// replayed) is covered by test/guardproxy.mts against a live upstream.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { McpClient } from "../../lib/mcp.mts";
import { runStdioGuard } from "../../lib/mcpconnect.mts";
import type { Log } from "../../lib/types.mts";

const mcpStub = { bearerToken: async () => "token" } as unknown as McpClient;

/** Drive the guard over pipes, collecting one JSON-RPC message per line. */
function startStdio(host: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  const log: Log = { info: (m) => logs.push(m), ok: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const done = runStdioGuard({ mcp: mcpStub, host, timeoutMs: 1500, log, input, output });
  let buf = "";
  const lines: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  const next = async (): Promise<any> =>
    JSON.parse(
      await new Promise<string>((resolve) => {
        const l = lines.shift();
        if (l !== undefined) resolve(l);
        else waiters.push(resolve);
      }),
    );
  return {
    logs,
    send: (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`),
    next,
    end: async () => {
      input.end();
      await done;
    },
  };
}

describe("stdio guard handshake with an unreachable instance", () => {
  it("answers initialize itself and reports the failure on the tool call instead", async () => {
    // port 1 on loopback: nothing listens, so the forward fails fast
    const stdio = startStdio("http://127.0.0.1:1");
    stdio.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const handshake = await stdio.next();

    assert.equal(handshake.id, 1);
    assert.equal(handshake.error, undefined, "an unreachable instance must not kill the session at the handshake");
    assert.ok(handshake.result?.serverInfo, `the client needs a usable session: ${JSON.stringify(handshake)}`);
    assert.ok(handshake.result?.capabilities, "capabilities are part of a usable handshake");

    // …and the failure surfaces where it belongs: the call that needs n8n.
    stdio.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_workflows", arguments: {} } });
    const call = await stdio.next();
    assert.equal(call.id, 2);
    assert.match(JSON.stringify(call), /unreachable|refused|ECONNREFUSED|failed/i, `the tool call carries the upstream error: ${JSON.stringify(call)}`);

    await stdio.end();
  });
});
