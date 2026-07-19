---
title: Watch & browser live-reload
description: The transparent dev proxy that refreshes the n8n editor tab after every push.
order: 4
---

Tired of ⌘R'ing the n8n editor after every push? Add
`"browserReload": "proxy"` to `decanter.config.json` and
[watch](/docs/cli/watch/) boots a transparent dev proxy on `127.0.0.1:5679`
(override with `"proxyPort"`):

```json
{ "root": "./workflows", "workflows": ["…"], "browserReload": "proxy" }
```

Open the n8n editor through the **proxy URL** (`http://localhost:5679`)
instead of the real port. The proxy pipes everything to your n8n host
untouched — login, assets, and n8n's native `/rest/push` WebSocket — and
injects a tiny reload client into the editor page. Every successful watch
push then refreshes the tab for you, **unless the editor has unsaved
changes** (it declines the reload and logs a console warning so nothing
in-browser is clobbered).

If the port is taken, watch warns and keeps syncing without live reload.

Built on native Node (no extra dependencies). It's designed for a **local
http** n8n (`http://localhost:5678`); pointing it at an https/remote host is
best-effort — Secure cookies don't survive the plain-http hop, so auth may
not carry through.
