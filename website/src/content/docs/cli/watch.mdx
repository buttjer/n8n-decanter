---
title: watch
description: Push a workflow's files on save, with optional browser live-reload.
order: 8
---

```sh
n8n-decanter [ref] watch [--force]
```

Watches one workflow's `code/` files **and** its `workflow.json` and pushes
on save (needs exactly one workflow — pass a ref, or list a single workflow
in the config). Runs until Ctrl-C.

## Session start: safety commit + pull

Every watch session starts with a safety commit and a pull, so the session
has a clean baseline and nothing uncommitted can be lost to an incoming
change.

## Structural edits and conflicts

Saves of `workflow.json` are pushed too, gated by a three-way conflict check
against the session baseline. When the remote structure changed as well,
watch prompts interactively: merge, keep local, or keep remote. `--force`
skips the prompts in favor of local.

## Browser live-reload

With `"browserReload": "proxy"` in the config, watch boots a transparent dev
proxy and refreshes the n8n editor tab after every successful push — setup
and caveats in [Watch & live reload](/docs/concepts/watch-live-reload/).

Node saves are guarded by the same [compliance rules](/docs/cli/check/) as a
manual push, so a broken save doesn't reach n8n.
