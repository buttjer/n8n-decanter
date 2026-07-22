---
title: watch
description: Push a workflow's Code-node saves to the draft, with optional browser live-reload.
order: 7
---

```sh
n8n-decanter watch [workflow] [--force]
```

Watches one workflow's `code/` files and pushes each save **to the
workflow's draft** over n8n's MCP server (needs exactly one workflow — pass
a ref, or list a single workflow in the config). Runs until Ctrl-C. Nothing
goes live during a watch session: run [`publish`](/docs/cli/publish/) when
the code should ship.

## Session start: safety commit + pull

Every watch session starts with a safety commit and a pull, so the session
has a clean baseline and nothing uncommitted can be lost to an incoming
change.

## workflow.json is a read-only snapshot

Saving `workflow.json` pushes nothing — structure lives in n8n. Watch warns
once per session if you edit it, and the next pull overwrites the file.

## Browser live-reload

With `"browserReload": "proxy"` in the config, watch boots a transparent dev
proxy and refreshes the n8n editor tab after every successful push — setup
and caveats in [Watch & live reload](/docs/concepts/watch-live-reload/).

Node saves are guarded by the same [compliance rules](/docs/cli/check/) as a
manual push, so a broken save doesn't reach n8n. `--force` carries through to
the per-node drift guard, exactly as on [push](/docs/cli/push/).
