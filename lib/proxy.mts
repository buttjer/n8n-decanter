import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { Log } from "./types.mts";

/**
 * Transparent development proxy for `watch` (Plan 5): pipes every request to the
 * upstream n8n instance untouched (auth, assets, native `/rest/push` WebSocket),
 * but injects a tiny live-reload client into HTML responses. On a successful
 * local push the client refreshes the editor tab — unless it has unsaved edits.
 *
 * Native `node:http`/`net`/`tls` only, matching the project's no-extra-deps rule.
 * Supported cleanly for a *local http* upstream (`http://localhost:5678`);
 * https/remote upstreams are best-effort — Secure cookies won't survive the
 * plain-http hop, breaking auth (see PLAN.md / plans/5).
 */

const CLIENT_PATH = "/__decanter/client.js";
const EVENTS_PATH = "/__decanter/events";
const INJECT_TAG = `<script src="${CLIENT_PATH}" defer></script>`;

/** The browser-side live-reload client, served at CLIENT_PATH and injected into HTML. */
const CLIENT_SCRIPT = `(function () {
  "use strict";
  var LOG = "[decanter] ";
  // Best-effort, framework-agnostic dirty probe: dispatch a synthetic
  // beforeunload and see whether any handler tries to block navigation — n8n
  // installs such a guard only when the open workflow has unsaved changes.
  // Fails safe toward NOT reloading when we can detect dirtiness; a missed
  // detection (older/newer n8n) would reload over UI edits, so treat this as a
  // heuristic, not a guarantee.
  function editorIsDirty() {
    try {
      if (typeof window.onbeforeunload === "function") return true;
      var ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented || ev.returnValue === false;
    } catch (err) {
      return false;
    }
  }
  function openWorkflowId() {
    var m = location.pathname.match(/\\/workflow\\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  function connect() {
    var es = new EventSource(${JSON.stringify(EVENTS_PATH)});
    es.addEventListener("pushed", function (e) {
      var data = {};
      try { data = JSON.parse(e.data || "{}"); } catch (_) {}
      var open = openWorkflowId();
      if (data.workflowId && open && open !== data.workflowId) return; // a different workflow is open
      if (editorIsDirty()) {
        console.warn(LOG + "push received but the editor has unsaved changes — not reloading. Save or discard, then refresh manually.");
        return;
      }
      console.info(LOG + "reloading after push");
      location.reload();
    });
    es.onerror = function () { /* EventSource reconnects on its own */ };
  }
  connect();
})();
`;

export interface ProxyHandle {
  port: number;
  broadcast(event: string, data: unknown): void;
  close(): Promise<void>;
}

/** The one proxy a `watch` process runs, if any — the target of notifyPushed. */
let activeProxy: ProxyHandle | null = null;

/**
 * Signal any browser tabs connected to a running dev proxy to reload after a
 * push. No-op when no proxy is active (plain `push`, or watch without the
 * proxy) — this is why push code can call it unconditionally.
 */
export function notifyPushed(workflowId?: string): void {
  activeProxy?.broadcast("pushed", { workflowId });
}

/**
 * Boot the reverse proxy on 127.0.0.1:port, forwarding to `upstream`.
 * Resolves to a handle, or `null` if the port can't be bound (caller keeps
 * running without live reload — the acceptance "graceful fallback").
 */
export async function startProxy({ upstream, port }: { upstream: string; port: number }, log: Log): Promise<ProxyHandle | null> {
  const target = new URL(upstream);
  const secure = target.protocol === "https:";
  const upstreamPort = target.port ? Number(target.port) : secure ? 443 : 80;
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === CLIENT_PATH) return serveClient(res);
    if (url === EVENTS_PATH) return serveEvents(req, res, clients);
    proxyHttp(req, res, { target, upstreamPort, secure }, log);
  });
  server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, { target, upstreamPort, secure }, log));

  const ping = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);
  ping.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    clearInterval(ping);
    const e = err as NodeJS.ErrnoException;
    log.warn(`browser-reload proxy: could not bind 127.0.0.1:${port} (${e.code ?? e.message}) — continuing without live reload`);
    return null;
  }

  const boundPort = (server.address() as AddressInfo).port;
  const handle: ProxyHandle = {
    port: boundPort,
    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(payload);
    },
    async close() {
      clearInterval(ping);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeProxy === handle) activeProxy = null;
    },
  };
  activeProxy = handle;
  log.info(`browser-reload proxy: http://127.0.0.1:${boundPort} -> ${upstream} — open the n8n editor via the proxy URL`);
  return handle;
}

function serveClient(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
  res.end(CLIENT_SCRIPT);
}

function serveEvents(req: http.IncomingMessage, res: http.ServerResponse, clients: Set<http.ServerResponse>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

interface Upstream {
  target: URL;
  upstreamPort: number;
  secure: boolean;
}

function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, { target, upstreamPort, secure }: Upstream, log: Log): void {
  const headers = { ...req.headers, host: target.host };
  // Force an uncompressed body so HTML can be string-injected without decoding.
  delete headers["accept-encoding"];
  const request = secure ? https.request : http.request;
  const upstreamReq = request(
    { hostname: target.hostname, port: upstreamPort, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      // HEAD carries no body to inject into — pass it straight through.
      const isHtml = req.method !== "HEAD" && /text\/html/i.test(String(upstreamRes.headers["content-type"] ?? ""));
      if (!isHtml) {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (c: Buffer) => chunks.push(c));
      upstreamRes.on("end", () => {
        const body = Buffer.from(injectClient(Buffer.concat(chunks).toString("utf8")), "utf8");
        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders["content-length"];
        delete outHeaders["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode ?? 200, { ...outHeaders, "content-length": String(body.byteLength) });
        res.end(body);
      });
    },
  );
  upstreamReq.on("error", (err) => {
    log.error(`browser-reload proxy: upstream request failed (${(err as Error).message})`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("decanter proxy: upstream error");
  });
  req.pipe(upstreamReq);
}

/** Inject the client bootstrapper right before </body> (append if there is none). */
function injectClient(html: string): string {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  return idx === -1 ? html + INJECT_TAG : html.slice(0, idx) + INJECT_TAG + html.slice(idx);
}

/** Pipe a raw WebSocket/Upgrade through to the upstream (n8n's native /rest/push). */
function proxyUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer, { target, upstreamPort, secure }: Upstream, log: Log): void {
  const onConnect = () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const headers = { ...req.headers, host: target.host };
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${v}`);
    }
    upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  };
  const upstreamSocket = secure
    ? tls.connect({ host: target.hostname, port: upstreamPort, servername: target.hostname }, onConnect)
    : net.connect({ host: target.hostname, port: upstreamPort }, onConnect);
  const onError = (err: Error) => {
    log.error(`browser-reload proxy: websocket upstream failed (${err.message})`);
    clientSocket.destroy();
    upstreamSocket.destroy();
  };
  upstreamSocket.on("error", onError);
  clientSocket.on("error", onError);
}
