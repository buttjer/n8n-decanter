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
n8n-decanter init [dir] [--force]   # interactive bootstrap
n8n-decanter completion zsh|bash

# Sync
n8n-decanter pull [workflow…]       # remote -> workflows/<kebab>/
n8n-decanter push [workflow…] [--force] [--no-typecheck]
n8n-decanter watch [workflow]
n8n-decanter publish [workflow…]    # take the draft(s) live
n8n-decanter unpublish [workflow…]  # back to draft-only

# Workflow lifecycle
n8n-decanter create "<name>"                     # blank workflow, then pull
n8n-decanter duplicate <workflow> ["<name>"]     # clone a workflow, then pull
n8n-decanter delete <workflow> [--force]         # delete from the server
n8n-decanter rename <workflow> "<new name>"      # rename the workflow (offline)

# Inspect & test
n8n-decanter status [workflow…] [--diff]
n8n-decanter check [workflow…] [--no-typecheck]
n8n-decanter executions [workflow…] [--status=…] [--limit=N]
n8n-decanter executions [workflow…] clean
n8n-decanter simulate <workflow> [--execution <execution-id> | --mock <slug>] [--pin <execution-id>] [--network-none] [--json]
n8n-decanter mock create <workflow> ["<slug>"] [--execution <id>]   # committed, gap-fillable mock scenario (offline)
n8n-decanter mock check <workflow> ["<slug>"]                       # structurally validate a mock (offline)
n8n-decanter list [--remote] [--json]

# Node
n8n-decanter node create <workflow> "<Node name>" [--ts]        # scaffold a Code node (offline)
n8n-decanter node rename <workflow> "<old node>" "<new node>"   # rename a node everywhere (offline)
n8n-decanter node run <node-file> [fixture.json] [--allow-env]  # run a node locally (offline)
```

## Placeholder vocabulary

| Token | Means |
| --- | --- |
| `<workflow>` / `[workflow…]` | a workflow: **id · name · unique name-prefix · folder name** |
| `<node>` | a node **name** (`node create`, `node rename`) |
| `<node-file>` | a path to a node source file (`node run`) |
| `<execution-id>` | an n8n execution id (numeric) — `simulate --execution`, `executions <execution-id>` |
| `<slug>` | a mock scenario name — `mock create`/`mock check`, `simulate --mock` (kebab-cased) |
| `<name>` | a new literal name (`create`, `duplicate`, `rename`) |

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

**No-ref → picker.** A ref-taking verb given *no* workflow, on a terminal, opens
the picker to choose one and then runs that verb on it (the verb menu is
skipped). Piped/non-TTY runs keep the config-default / error path unchanged, so
scripts and LLM harnesses never block.

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
| `check`, `rename`, `node create`, `node rename`, `node run`, `list`, `simulate`, `completion` | Fully offline — no credentials needed (`list --remote` is the exception; `simulate` needs Docker but never the n8n API) |
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
