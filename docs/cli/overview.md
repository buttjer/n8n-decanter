---
title: Overview
description: Command surface, workflow refs, flag placement, exit codes, and output styling.
order: 1
---

```sh
n8n-decanter                        # interactive picker (terminal, inited project)
n8n-decanter init [dir]             # interactive bootstrap
n8n-decanter [ref...] pull          # remote -> workflows/<Name>/
n8n-decanter [ref...] push [--force] [--no-typecheck]
n8n-decanter [ref...] status [--diff]
n8n-decanter [ref...] check [--no-typecheck]
n8n-decanter <ref> rename "<old node>" "<new node>"
n8n-decanter <ref> rename --workflow "<new name>"
n8n-decanter <ref> add "<Node name>" [--ts]           # scaffold a Code node (offline)
n8n-decanter [ref] watch [--force]
n8n-decanter create "<name>"                          # blank workflow, then pull
n8n-decanter <ref> duplicate ["<new name>"]           # clone a workflow, then pull
n8n-decanter [ref...] publish                         # take the draft(s) live
n8n-decanter [ref...] unpublish                       # back to draft-only
n8n-decanter <ref> delete [--force]                   # delete from the server
n8n-decanter [ref...] executions [--status=…] [--limit=N]
n8n-decanter [ref...] executions clean
n8n-decanter <ref> simulate --execution <id> [--network-none] [--json]   # engine-true replay
n8n-decanter list [--remote]
n8n-decanter completion zsh|bash
n8n-decanter <node-file> run [fixture.json] [--allow-env]
```

## Interactive picker

Running **bare `n8n-decanter`** (no verb, no arguments) in an inited project
on a terminal opens a picker instead of printing usage: type to filter,
`↑`/`↓` to move. Each row leads with a status glyph — `●` for a pulled
workflow (green), `○` for a not-yet-pulled remote one (yellow) — so the state
reads by shape, not color alone, and the ids line up in an aligned column.
`Enter` on a pulled workflow offers status/pull/push/watch/check/executions/simulate;
`Enter` on an unpulled one pulls it directly. It stays in the workflow's verb
menu between runs, `Esc` backs out to the list, `Esc` again quits. Piped
output and dirs without a `decanter.config.json` keep printing usage — scripts
and LLM harnesses never see the picker.

## Workflow refs

A workflow `ref` is its **id, its workflow/folder name, or a unique name
prefix** — `n8n-decanter "Order Sync" push` and `n8n-decanter order push`
both work. Matching is case-insensitive and never prompts: an ambiguous or
unknown name errors with the candidate list. `pull` resolves not-yet-pulled
names against the server's workflow list; a workflow literally named like a
verb must be addressed by id. Without refs, all workflows from the config are
processed.

The verb may sit anywhere among the arguments (`push wf123` is the same as
`wf123 push`) — the first token matching a known verb is the command; flags
may appear in any position too.

## Offline vs. online

| Verbs | Network |
| --- | --- |
| `check`, `run`, `rename`, `add`, `list`, `simulate`, `completion` | Fully offline — no credentials needed (`list --remote` is the exception; `simulate` needs Docker but never the n8n API) |
| `status`, `executions` | Read the remote, never write |
| `pull`, `push`, `watch`, `create`, `duplicate`, `publish`, `unpublish`, `delete` | Read/write the live instance |

Credentials come from `.env` next to `decanter.config.json` (searched upward
from the current directory) or the environment (`N8N_HOST`, `N8N_API_KEY`).

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
