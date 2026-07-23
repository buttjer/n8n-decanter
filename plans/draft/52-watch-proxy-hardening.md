# Plan 52 — Revisit & harden the `watch` live-reload proxy

**Status:** Draft
**Priority:** P3
**Source:** backlog item — revisit [`lib/proxy.mts`](../../lib/proxy.mts) (the
`browserReload: "proxy"` tunnel from [Plan 5](../done/5-browser-refresh-after-push.md)).

## Why

The dev proxy works but has grown a few sharp edges worth a hardening pass while
keeping the current shape (native `node:http`/`net`/`tls`, opt-in, `127.0.0.1`
only). Distinct from [Plan 48](48-watch-proxy-trust-model-docs.md), which is
about *documenting* the trust model — this is *code* hardening.

## Ideas (rough scope)

- **Stop stripping `accept-encoding` on every request.** `proxyHttp` deletes it
  unconditionally so HTML can be string-injected uncompressed — but that also
  forces every asset (n8n's large JS bundles) to transfer uncompressed. Strip it
  only for navigations (e.g. `Accept: text/html`), or gunzip just the HTML
  response, so the editor loads compressed.
- **Unbounded HTML buffering.** HTML responses are fully buffered into a `chunks`
  array before injecting `</body>`. Editor HTML is small, but add a size cap that
  falls back to pass-through streaming past a threshold, rather than buffering
  arbitrarily.
- **No upstream timeouts.** Neither the `http(s).request` nor the WebSocket
  `net`/`tls.connect` sets a timeout — a hung upstream leaves the client request
  or upgraded socket hanging. Add request/socket timeouts + clean 504s.
- **Harden the `editorIsDirty()` heuristic (biggest real risk).** The synthetic
  `beforeunload` probe fails safe toward *reloading* on newer/older n8n — a missed
  detection reloads over unsaved UI edits (data loss). Consider a sturdier probe,
  a short "reloading in Ns — cancel" grace banner, or a config to require a click.
- **Unauthenticated `/__decanter/events` SSE.** Any local process can subscribe
  and read `pushed` `{workflowId}` events. Low sev (localhost + opt-in), but could
  reuse the per-session-secret pattern `mcp serve` already has
  (`.decanter-proxy.json`) to gate it. (Overlaps Plan 48's trust-model note.)
- **UTF-8 assumption** in `Buffer.concat(chunks).toString("utf8")` — fine for the
  editor today; note/guard if a non-UTF-8 HTML upstream ever appears.

## Notes

- Extend [`test/proxy.mts`](../../test/proxy.mts) to cover whatever lands
  (compressed asset pass-through, large-HTML fallback, timeout paths,
  dirty-probe behavior).
- No PLAN.md data-model change expected; a CHANGELOG `[Unreleased]` entry only if
  user-visible behavior (compression, reload UX) changes.
