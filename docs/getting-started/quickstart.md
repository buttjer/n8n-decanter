---
title: Quickstart
description: Bootstrap a sync dir with init, pull a workflow, edit, and push it back.
order: 2
---

## 1. Bootstrap a sync dir

```sh
n8n-decanter init [dir]
```

`init` prompts for your n8n host, connects via **OAuth** in your browser (or
takes a pasted MCP token), offers the optional public API key, copies the
starter template, and scaffolds config, `.gitignore`, TypeScript tooling, and
agent configs. It never overwrites existing files (safe to re-run) and does a
best-effort connection check. See [init](/docs/cli/init/) for details.

One-time n8n-side setup: enable **MCP access** (n8n → Settings → MCP; needs
an n8n with the built-in MCP server, ~2.20+), and flip **"Available in MCP"**
on each workflow you want to sync (workflow card ⋯ menu, or workflow
settings).

## 2. Pull a workflow

Workflows are born in n8n — create one there (even empty) and switch on
**"Available in MCP"** (step 1); only opted-in workflows can be pulled. Then,
on a terminal, run `pull` and pick one from the list:

```sh
n8n-decanter pull                 # picker: lists your n8n workflows → pick one to pull
n8n-decanter pull <id-or-name>    # …or pull directly (scriptable, no TTY needed)
```

With no argument on a terminal, `pull` lists your n8n workflows (remote ones
too) so you can pick one — no config entry or id needed. Each workflow lands
as a folder under `workflows/`: a read-only `workflow.json` structure snapshot
plus one source file per Code node in a `code/` subdir — see
[Sync layout](/docs/concepts/sync-layout/). After every successful pull and
push, the workflow's folder is git-committed automatically (scoped to that
folder; outside a git repo it just warns).

To fix a default set that a bare `pull`/`push`/`status` acts on, list ids in
`decanter.config.json` (`"workflows": ["0cXNQKKzmO0pXiCq"]`); all keys are
documented in [Configuration](/docs/concepts/configuration/).

## 3. Edit and push

Edit the node files in your IDE (or let your agent do it), verify offline
with [check](/docs/cli/check/) and [node run](/docs/cli/node-run/), then:

```sh
n8n-decanter push             # lands on the workflow's DRAFT
n8n-decanter publish          # take it live (or: push --publish)
```

Every push updates the workflow's **draft** — the live version keeps running
until you `publish`. Push refuses to overwrite remote code changes made since
the last sync and blocks on layout or type errors — the
[push gates](/docs/concepts/push-gates/) page explains the guard rules. For a
save-to-push loop with browser live-reload, see [watch](/docs/cli/watch/).
