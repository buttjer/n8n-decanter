# Plan 48 — Document the `watch` live-reload proxy trust model

**Status:** Draft
**Priority:** P3
**Source:** backlog item

`lib/proxy.mts` binds `127.0.0.1` only (good) and is opt-in
(`browserReload: "proxy"`), but it's a transparent auth-passthrough tunnel to the
n8n instance and serves an unauthenticated `/__decanter/events` SSE endpoint.
Localhost + opt-in keeps risk low, but the trust model (any local process
reaching the port rides the browser's forwarded cookies; https/remote upstreams
are best-effort) deserves one explicit paragraph in PLAN.md/README beyond the
current "https is best-effort" note. Severity: low.
