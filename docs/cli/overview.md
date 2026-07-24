---
title: Overview
description: Command surface, workflow refs, flag placement, exit codes, and output styling.
order: 1
---

**The verb comes first:** `n8n-decanter <verb> [workflow…] [flags]`. Everything
after the verb is an argument, so a workflow named like a verb is just a normal
argument (no special rule). Flags may still sit anywhere.

```sh
n8n-decanter                        # interactive picker (terminal, inited project)

# Setup
n8n-decanter init [dir] [--force]   # bootstrap (add --host/--token/--api-key to skip prompts)
n8n-decanter completion zsh|bash

# Sync — over n8n's MCP server, Code-node source only (structure lives in n8n)
n8n-decanter pull [workflow…]       # code + structure snapshot -> workflows/<kebab>/
n8n-decanter push [workflow…] [--force] [--publish] [--no-typecheck]   # to the DRAFT
n8n-decanter watch [workflow]
n8n-decanter publish [workflow…]    # take the draft(s) live
n8n-decanter unpublish [workflow…]  # back to draft-only

# Inspect & test
n8n-decanter status [workflow…] [--diff]
n8n-decanter check [workflow…] [--no-typecheck]
n8n-decanter executions [workflow…] [--status=…] [--limit=N]
n8n-decanter executions [workflow…] clean
n8n-decanter data-tables [table…] [--filter='<json>'] [--search=…] [--sort=col:asc|desc] [--limit=N] [--all]
n8n-decanter data-tables [table…] clean
n8n-decanter test <workflow> [--execution <execution-id> | --scenario <slug>] [--trigger <node>] [--json]
n8n-decanter simulate <workflow> [--execution <execution-id> | --scenario <slug>] [--network-none] [--json]
n8n-decanter preflight [workflow…] [--quick|--full|--offline] [--json] [--fail-on=warn] [--fail-fast] [--require=<ids>]   # the whole ladder, scored (read-only)
n8n-decanter scenario create <workflow> ["<slug>"] [--execution <id>] [--scaffold]   # committed, gap-fillable pin-data set (offline; --scaffold needs MCP)
n8n-decanter scenario check <workflow> ["<slug>"]                                    # structurally validate a scenario (offline)

# Backup — git-native, redeployable disaster recovery (REST; needs N8N_API_KEY)
n8n-decanter backup create <workflow>                            # capture a full-export backup into backups/
n8n-decanter backup restore <workflow> [--version <id> | --at <ts>]   # redeploy as a NEW, unpublished workflow
n8n-decanter backup list <workflow>                             # retained backups (offline)

n8n-decanter list [--remote] [--json]

# Node
n8n-decanter node run <node-file> [fixture.json] [--allow-env]  # run a node locally (offline)

# Agent guard — structure/lifecycle acts go through n8n's MCP, guarded
n8n-decanter mcp connect            # stdio MCP guard (spawned from the scaffolded .mcp.json; no secret)
n8n-decanter mcp serve [--port N]   # HTTP variant: localhost guard-proxy for URL-configured agents
```

Creating, renaming, and archiving workflows — and adding or renaming nodes —
are **n8n's acts**: do them in the n8n editor or over n8n's MCP tools (your
agent reaches them through the [guard](/docs/cli/mcp-connect/), which blocks
only Code-node `jsCode` writes). The next [pull](/docs/cli/pull/) reconciles
the local mirror: files follow renames, new Code nodes land as files, and the
first push seeds a node born empty.

## Placeholder vocabulary

| Token | Means |
| --- | --- |
| `<workflow>` / `[workflow…]` | a workflow: **id · name · unique name-prefix · folder name** |
| `<node-file>` | a path to a node source file (`node run`) |
| `<execution-id>` | an n8n execution id (numeric) — `simulate --execution`, `executions <execution-id>` |
| `<slug>` | a scenario name — `scenario create`/`scenario check`, `simulate --scenario`/`test --scenario` (kebab-cased) |
| `<ids>` | a comma list of [preflight](/docs/cli/preflight/) check ids — `preflight --require=layout,test` |

## Interactive picker

Running **bare `n8n-decanter`** (no verb, no arguments) in an inited project
on a terminal opens a picker instead of printing usage: type to filter,
`↑`/`↓` to move. Each row leads with a status glyph — `●` for a pulled
workflow (green), `○` for a not-yet-pulled remote one (yellow), `⊘` for a
remote workflow **not yet available in MCP** (red, sorted last) — so the state
reads by shape, not color alone, and the ids line up in an aligned column.
`Enter` on a pulled workflow offers status/pull/push/watch/check/preflight/executions/simulate;
`Enter` on an unpulled one pulls it directly; `Enter` on a `⊘` row explains
where to flip the "Available in MCP" switch in n8n. It stays in the workflow's verb
menu between runs, `Esc` backs out to the list, `Esc` again quits. Piped
output and dirs without a `decanter.config.json` keep printing usage — scripts
and LLM harnesses never see the picker.

**No-ref → picker.** A ref-taking verb given *no* workflow, on a terminal, opens
the picker to choose one and then runs that verb on it (the verb menu is
skipped). For `pull` the list includes **remote** workflows too (as in the bare
picker), so a fresh setup with nothing pulled still gets a menu to pick from;
the other verbs act on already-pulled workflows only. Piped/non-TTY runs keep
the config-default / error path unchanged, so scripts and LLM harnesses never
block.

## Workflow refs

A `<workflow>` is its **id, its workflow/folder name, or a unique name
prefix** — `n8n-decanter push "Order Sync"` and `n8n-decanter push order`
both work. Matching is case-insensitive and never prompts: an ambiguous or
unknown name errors with the candidate list. `pull` resolves not-yet-pulled
names against the server's workflow list. Without a workflow argument, all
workflows from the config are processed (or the picker opens, on a terminal).

**Verb-first grammar.** The verb is the first argument; everything after it is
an argument. `n8n-decanter status push` runs `status` on the workflow named
`push` — no "address it by id" caveat. Verb-last (`n8n-decanter wf123 push`)
errors with *unknown verb*. Flags may still appear in any position.

## Offline vs. online

| Verbs | Network |
| --- | --- |
| `check`, `node run`, `list`, `simulate`, `scenario check`, `completion`, `executions clean`, `data-tables clean` | Fully offline — no credentials needed (`list --remote` is the exception; `simulate` needs Docker but never the n8n instance; `scenario create --scaffold` is the exception in the `scenario` namespace — it needs MCP) |
| `status`, `list --remote`, `executions`, `data-tables`, `backup create`/`restore` | Read the remote (`backup restore` also writes a **new** workflow, never touching the source) |
| `backup list` | Fully offline — reads the local `backups/` store |
| `test` | Runs the workflow's **draft** on the instance with pinned data (on a terminal it can push your local code to the draft first — it asks; non-interactive runs never write) |
| `preflight` | Runs the whole verification ladder read-only — static + instance reads + a pinned draft `test`/`simulate` run; **never writes** (no push/publish/restore), in every profile |
| `pull`, `push`, `watch`, `publish`, `unpublish` | Read/write the live instance (pushes land on the **draft**) |
| `mcp connect` / `mcp serve` | Long-running MCP guard (stdio / localhost HTTP) — forwards an agent's MCP traffic to the instance with decanter's credentials, blocking Code-node (`jsCode`) writes; a forwarded structure edit also triggers a background `workflow.json` refresh (`liveMirror`, on by default) |

Credentials come from `.env` next to `decanter.config.json` (searched upward
from the current directory) or the environment. `N8N_HOST` plus **MCP
credentials** (OAuth minted by [`init`](/docs/cli/init/) into
`.decanter-auth.json`, or an `N8N_MCP_TOKEN`) power the sync and lifecycle
verbs; the **public API key** (`N8N_API_KEY`, optional) powers only
`executions`, `data-tables`, and `backup` — the surfaces n8n's MCP server
doesn't cover.

## Output and scripting

Output is styled (color, `✓`/`!`/`✗` glyphs, progress) **only when writing to
a terminal** and respects `NO_COLOR`/`FORCE_COLOR`; piped or redirected
output is plain line-oriented text, safe for scripts and LLM harnesses.

API requests time out after 30 s (set `"requestTimeoutMs"` in
`decanter.config.json` for slow instances). `DEBUG=1` prints full stack
traces on errors.

Tab completion for verbs, flags, and workflow names:

```sh
eval "$(n8n-decanter completion zsh)"   # or bash — append to your shell rc
```
