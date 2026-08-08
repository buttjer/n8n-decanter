---
title: watch
description: Push a workflow's Code-node saves to the draft as you edit.
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

## The editor updates live

Keep the n8n editor tab open on the watched workflow — n8n 2.x reflects each
push in the open canvas natively (no proxy, no manual refresh), and skips the
update if the tab has unsaved edits so nothing in-browser is clobbered.

Node saves run the same folder-wide
[compliance guard](/docs/cli/preflight/#what-the-compliance-guard-catches) as a
manual push — including the dangling-reference check, which needs the whole
folder to know which node names exist. A save is **refused** when the violation
is in the file you just saved; violations elsewhere in the folder are printed on
every save but let it through, so a multi-file repair after a rename doesn't
deadlock the loop. `push` and `preflight` gate on all of them. `--force` carries through to
the per-node drift guard, exactly as on [push](/docs/cli/push/).
