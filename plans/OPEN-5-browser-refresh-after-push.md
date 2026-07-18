# Plan 5 — Browser refresh after push (The Proxy Method)

**Priority:** P2 (High DX Impact)

**Status:** Implemented (offline-tested); live-instance verification pending

**Theme:** Spin up a transparent development proxy during `decanter watch`. The proxy injects a lightweight live-reload client into n8n's frontend HTML payload. When a local push completes, the proxy signals the client to cleanly refresh the browser tab.

---

## Why

The current edit loop requires a manual refresh (⌘R) after every local push. Forgetting this step leads to a stale browser editor holding outdated workflow code, which invites accidental clobbering.

By utilizing a local development proxy, we achieve a **100% cross-platform, zero-configuration live reload loop**. It requires:

* No macOS-specific AppleScript permissions.
* No risky Chrome DevTools Protocol (CDP) debugging flags.
* No manual Tampermonkey/browser extension setups for the developer.

---

## Architecture Overview

```
[ Browser Tab ] 
       │  ▲
       │  │ 1. Serves UI + Injects Client Script
       ▼  │ 3. WebSocket/SSE: "pushed" -> window.location.reload()
[ Decanter Proxy Server (Port 5679) ] ◄─── (Fired by local watch/push)
       │  ▲
       │  │ 2. Transparently pipes all auth, assets, and native WS traffic
       ▼  │
[ Live n8n Instance (Port 5678) ]

```

When `browserReload: "proxy"` is enabled in `decanter.config.json`:

1. `decanter watch` boots a lightweight HTTP/WebSocket proxy on a secondary port (e.g., `5679`).
2. The proxy transparently forwards all traffic to the upstream n8n host, preserving cookies, headers, and n8n's native `/rest/push` WebSockets.
3. For HTML responses (`text/html`), the proxy intercepts the stream and injects a small, self-contained client script before the closing `</body>` tag.
4. The client script establishes a Server-Sent Events (SSE) or WebSocket connection back to the Decanter proxy. When a push succeeds, an event triggers an intelligent page reload.

---

## Configuration

Add the following knobs to `decanter.config.json`:

```json
{
  "browserReload": "proxy",
  "proxyPort": 5679
}

```

---

## Tasks

### 1. Core Proxy Engine (`lib/proxy.mts`)

* Implement an HTTP/HTTPS reverse proxy using a robust library (e.g., `http-proxy` or native Node.js `http` streams).
* Ensure strict forwarding of `Host`, `Cookie`, and connection-upgrade headers to prevent breaking n8n's authentication system.
* Support WebSocket proxying to allow n8n's native `/rest/push` channel to function natively through the proxy.

### 2. HTML Interception & Script Injection

* Intercept responses where the `Content-Type` header matches `text/html`.
* Inject the client bootstrapper snippet:
```html
<script src="/__decanter/client.js" defer></script>

```


* Intercept `GET /__decanter/client.js` requests at the proxy level to serve the dynamic client-side live-reload asset.

### 3. Client Reload Script (`src/templates/proxy-client.js`)

* Establish an SSE (`EventSource`) or lightweight WebSocket connection back to `/__decanter/events`.
* **Dirty State Protection:** Before executing `window.location.reload()`, read the browser DOM or state variables to check for unsaved n8n changes.
> **Note:** If the editor is dirty, log a prominent warning to the browser console and decline the reload to prevent loss of in-browser work.



### 4. CLI Watch Hook Integration

* Update `lib/watch.mts` to initialize the proxy server on boot if configured.
* Expose a global or contextual broadcast method: `global.__decanterProxy?.broadcast('pushed', { workflowId })`.
* Trigger this broadcast inside the successful resolution loop of `lib/push.mts` and `pushSingleNode`.

---

## Acceptance / Verification

* **Seamless Proxying:** Navigating to `http://localhost:5679` serves the full, authenticated n8n workspace identically to the raw instance port.
* **Auto-Refresh:** Modifying a local node file triggers `decanter` auto-push $\rightarrow$ the browser tab focused on that workflow instantly reloads to show the changes without manual intervention.
* **Dirty Safeguard:** If a node parameter is actively being edited in the UI (showing unsaved changes), a local push does *not* clobber the browser state; it surfaces a console message instead.
* **Graceful Fallbacks:** If the proxy fails to bind to the port, `decanter watch` logs a warning but continues executing local sync operations safely.

---

## Implementation status (2026-07-18)

Built in `lib/proxy.mts` + wired into `watch`/`push`/config. Deviations from the
task sketch above, all deliberate:

* **Native Node, no new dependency** (`node:http`/`https`/`net`/`tls`) instead
  of `http-proxy` — matches the project's esbuild-+-luxon-only, no-build rule.
* **Reload channel is SSE**, not a WebSocket — one-way server→client, plain
  HTTP, nothing to hand-shake.
* **Client lives inlined in `lib/proxy.mts`** (served at `/__decanter/client.js`),
  not a separate `src/templates/proxy-client.js` — there is no `src/` tree and
  the CLI ships as source with no bundling step.
* **Broadcast is a typed module singleton**, `notifyPushed(workflowId)` exported
  from `lib/proxy.mts` and called by `pushWorkflow`/`pushSingleNode`, instead of
  a magic `global.__decanterProxy`. No-op when no proxy is running, so plain
  `push` calls it harmlessly.
* **Dirty probe** dispatches a synthetic `beforeunload` and treats
  `defaultPrevented`/`returnValue===false` (or a property-style
  `window.onbeforeunload`) as dirty — framework-agnostic, but a heuristic that
  can miss on some n8n versions; it fails toward *not* reloading when it detects
  dirtiness. The client also skips reload when a *different* workflow id is open.
* **Config knobs** `browserReload` (`"off"`|`"proxy"`, default off) and
  `proxyPort` (default 5679) parsed in `lib/config.mts`.
* **`watch` is now workflow-id-scoped** (breaking, decided while landing this):
  `watch <id>` watches the whole `code/` dir and pushes whichever node you save,
  instead of a single node file — browser-reload is workflow-scoped, so a
  single-node watch was the wrong granularity. See PLAN.md "Watch mode".

Verified offline by `test/proxy.mts` (in `npm test`): HTML injection before
`</body>` with recomputed content-length, `accept-encoding` stripped for
injection, non-HTML passthrough byte-identical, client asset served, `pushed`
SSE broadcast delivered, and graceful `null`+warning on a taken port.

**Still needs a live n8n** (can't be exercised against the mock): real auth +
asset + `/rest/push` WebSocket passthrough, the dirty safeguard against n8n's
actual unsaved-changes guard, and the end-to-end auto-refresh loop. Best on a
local http n8n — https/remote upstreams are best-effort (Secure cookies).

## Notes

* **PLAN.md Updates:** This architectural shift introduces a persistent network component to `watch`. Ensure `PLAN.md` documentation reflects the secondary port usage. *(Pending — raised with the user per CLAUDE.md's "don't rewrite PLAN.md unasked" rule.)*
* **Performance:** HTML stream modification must be handled efficiently via buffering or lightweight regex streaming to ensure page load latency remains imperceptible. *(HTML responses are buffered then injected; non-HTML is streamed through untouched.)*