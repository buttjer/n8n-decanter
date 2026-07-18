// Focused test for the browser-reload dev proxy (lib/proxy.mts, Plan 5).
// Drives the proxy module directly: `watch` never exits, so the e2e exec
// harness can't run it. Binds localhost ports — sandboxes may block that.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { notifyPushed, startProxy } from "../lib/proxy.mts";
import type { Log } from "../lib/types.mts";

const logs: { level: string; msg: string }[] = [];
const log: Log = {
  info: (m) => logs.push({ level: "info", msg: m }),
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
  res.writeHead(404).end("nope");
});

// ---------- helpers ----------
interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function get(url: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

let passed = 0;
async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
    upstream.close();
    process.exit(1);
  }
}

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

await handle.close();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
console.log(`\n${passed} proxy checks passed`);
process.exit(0);
