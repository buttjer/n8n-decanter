# Plan 48 — Document the `watch` live-reload proxy trust model

**Status:** Done (2026-07-23) — superseded, not implemented as described
**Priority:** P3
**Source:** backlog item
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

`lib/proxy.mts` binds `127.0.0.1` only (good) and is opt-in
(`browserReload: "proxy"`), but it's a transparent auth-passthrough tunnel to the
n8n instance and serves an unauthenticated `/__decanter/events` SSE endpoint.
Localhost + opt-in keeps risk low, but the trust model (any local process
reaching the port rides the browser's forwarded cookies; https/remote upstreams
are best-effort) deserves one explicit paragraph in PLAN.md/README beyond the
current "https is best-effort" note. Severity: low.

**Superseded (2026-07-23) by [Plan 52](52-remove-watch-browser-reload-proxy.md)**
— the proxy was **removed** (n8n 2.x reflects MCP draft edits in the open
editor natively), so there's no trust model left to document. Kept for history.
