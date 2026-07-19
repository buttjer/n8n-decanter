// Focused test for the browser-reload dev proxy (lib/proxy.mts, Plan 5).
// Drives the proxy module directly: `watch` never exits, so the e2e exec
// harness can't run it. Binds localhost ports — sandboxes may block that.
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { notifyPushed, startProxy } from "../lib/proxy.mts";
import type { Log } from "../lib/types.mts";
import { createStepRunner } from "./harness.mts";

const logs: { level: string; msg: string }[] = [];
const log: Log = {
  info: (m) => logs.push({ level: "info", msg: m }),
  ok: (m) => logs.push({ level: "ok", msg: m }),
  warn: (m) => logs.push({ level: "warn", msg: m }),
  error: (m) => logs.push({ level: "error", msg: m }),
};

// ---------- mock upstream n8n ----------
let sawAcceptEncoding: string | undefined = "unset";
const upstream = http.createServer((req, res) => {
  if (req.url === "/") {
    sawAcceptEncoding = req.headers["accept-encoding"] as string | undefined;
    return void res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><head><title>n8n</title></head><body><h1>editor</h1></body></html>");
  }
  if (req.url === "/asset.js") {
    return void res.writeHead(200, { "content-type": "application/javascript" }).end('console.log("upstream asset");');
  }
  if (req.url === "/nobody") {
    return void res.writeHead(200, { "content-type": "text/html" }).end("<p>bare fragment");
  }
  res.writeHead(404).end("nope");
});

// ---------- helpers ----------
interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function request(url: string, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .request(url, { method }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on("error", reject)
      .end();
  });
}
const get = (url: string) => request(url);

const { step, passedCount } = createStepRunner({ onFail: () => upstream.close() });

// ---------- run ----------
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as AddressInfo).port;
const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

const handle = await startProxy({ upstream: upstreamUrl, port: 0 }, log);
assert.ok(handle, "proxy must bind on port 0");
const base = `http://127.0.0.1:${handle.port}`;

await step("HTML responses get the live-reload client injected before </body>", async () => {
  const r = await get(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.body, /<script src="\/__decanter\/client\.js" defer><\/script>/, "client script injected");
  const tagAt = r.body.indexOf('<script src="/__decanter/client.js"');
  const bodyCloseAt = r.body.toLowerCase().indexOf("</body>");
  assert.ok(tagAt < bodyCloseAt, "injected before </body>");
  assert.match(r.body, /<h1>editor<\/h1>/, "original markup preserved");
  // content-length must match the injected body, not the upstream original
  assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.body), "content-length recomputed");
});

await step("proxy strips accept-encoding so HTML arrives uncompressed", () => {
  assert.equal(sawAcceptEncoding, undefined, "upstream saw no accept-encoding");
});

await step("non-HTML responses pass through untouched", async () => {
  const r = await get(`${base}/asset.js`);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'console.log("upstream asset");', "asset byte-identical");
  assert.doesNotMatch(r.body, /__decanter/, "no injection into non-HTML");
});

await step("client asset is served at /__decanter/client.js", async () => {
  const r = await get(`${base}/__decanter/client.js`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /javascript/);
  assert.match(r.body, /EventSource/, "client opens an EventSource");
  assert.match(r.body, /"\/__decanter\/events"/, "client points at the events endpoint");
});

await step("notifyPushed broadcasts a 'pushed' SSE event to connected tabs", async () => {
  const received = await new Promise<string>((resolve, reject) => {
    const req = http.get(`${base}/__decanter/events`, (res) => {
      assert.match(String(res.headers["content-type"]), /text\/event-stream/);
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        if (buf.includes(": connected")) notifyPushed("wf-target"); // fire once the stream is live
        if (buf.includes("event: pushed")) {
          req.destroy();
          resolve(buf);
        }
      });
      res.on("error", () => {}); // req.destroy() surfaces here — ignore
    });
    req.on("error", reject);
    setTimeout(() => reject(new Error("no pushed event within 3s")), 3000).unref();
  });
  assert.match(received, /event: pushed/);
  assert.match(received, /"workflowId":"wf-target"/);
});

await step("startProxy returns null and warns when the port is taken", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const takenPort = (blocker.address() as AddressInfo).port;
  logs.length = 0;
  const failed = await startProxy({ upstream: upstreamUrl, port: takenPort }, log);
  assert.equal(failed, null, "must not return a handle when bind fails");
  assert.ok(logs.some((l) => l.level === "warn" && /could not bind/.test(l.msg)), "warns on bind failure");
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
});

await step("HTML without </body> gets the client appended at the end", async () => {
  const r = await get(`${base}/nobody`);
  assert.equal(r.status, 200);
  assert.ok(r.body.startsWith("<p>bare fragment"), r.body);
  assert.ok(r.body.endsWith('<script src="/__decanter/client.js" defer></script>'), "tag appended: " + r.body);
});

await step("HEAD passes through without injection", async () => {
  const r = await request(`${base}/`, "HEAD");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/html/);
  assert.equal(r.body, "", "HEAD must carry no body");
});

await step("upstream request failure → 502 plain-text error", async () => {
  // port 9 (discard) on localhost: nothing listens there, connect fails fast
  const dead = await startProxy({ upstream: "http://127.0.0.1:9", port: 0 }, log);
  assert.ok(dead, "proxy must bind even when the upstream is dead");
  logs.length = 0;
  const r = await get(`http://127.0.0.1:${dead!.port}/`);
  assert.equal(r.status, 502);
  assert.match(String(r.headers["content-type"]), /text\/plain/);
  assert.equal(r.body, "decanter proxy: upstream error");
  assert.ok(logs.some((l) => l.level === "error" && /upstream request failed/.test(l.msg)), "logs the upstream failure");
  await dead!.close();
});

await step("websocket upgrade round-trips through the proxy", async () => {
  // raw TCP upstream: answer the upgrade handshake, then echo every byte —
  // enough to prove the proxy pipes both directions after the 101
  const wsUpstream = net.createServer((sock) => {
    let buf = "";
    const onHandshake = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        sock.off("data", onHandshake);
        sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        sock.on("data", (d) => sock.write(d)); // echo
      }
    };
    sock.on("data", onHandshake);
  });
  await new Promise<void>((resolve) => wsUpstream.listen(0, "127.0.0.1", () => resolve()));
  const wsPort = (wsUpstream.address() as AddressInfo).port;
  const wsProxy = await startProxy({ upstream: `http://127.0.0.1:${wsPort}`, port: 0 }, log);
  assert.ok(wsProxy, "proxy must bind for the ws test");
  const received = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(wsProxy!.port, "127.0.0.1");
    let data = "";
    let payloadSent = false;
    sock.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (!payloadSent && data.includes("\r\n\r\n")) {
        payloadSent = true;
        sock.write("ping-payload"); // past the handshake: raw bytes both ways
      }
      if (data.includes("ping-payload")) {
        sock.destroy();
        resolve(data);
      }
    });
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(
        "GET /rest/push HTTP/1.1\r\nHost: proxy\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    setTimeout(() => reject(new Error("no ws echo within 3s; got: " + JSON.stringify(data))), 3000).unref();
  });
  assert.match(received, /101 Switching Protocols/);
  assert.match(received, /ping-payload/, "payload echoed back through the tunnel");
  await wsProxy!.close();
  await new Promise<void>((resolve) => wsUpstream.close(() => resolve()));
});

await handle.close();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
console.log(`\n${passedCount()} proxy checks passed`);
process.exit(0);
