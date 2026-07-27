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
n8n-decanter --version              # print the installed version and exit (-v; errors if combined with a verb)
n8n-decanter help                   # the command surface (also --help, or a bare run when piped)

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
n8n-decanter preflight [workflow…] [--simulate] [--offline] [--viewer] [--json] [--fail-on=warn] [--fail-fast] [--require=<ids>]
                                    # the gate: grades LOCAL code, scored (read-only) — then push, then test
                                    #   --simulate ADDS a local-engine run (Docker); --offline DROPS the instance reads
n8n-decanter diff [workflow…]       # per-node line diff, local code vs the n8n draft (always exits 0)
n8n-decanter executions [workflow…] [--status=…] [--limit=N]
n8n-decanter executions [workflow…] clean
n8n-decanter data-tables [table…] [--filter='<json>'] [--search=…] [--sort=col:asc|desc] [--limit=N] [--all]
n8n-decanter data-tables [table…] clean
n8n-decanter test <workflow> [--execution <execution-id> | --scenario <slug>] [--trigger <node>] [--json]
n8n-decanter scenario create <workflow> ["<slug>"] [--execution <id>] [--scaffold]   # committed, gap-fillable pin-data set (offline; --scaffold needs MCP)
n8n-decanter scenario check <workflow> ["<slug>"]                                    # structurally validate a scenario (offline)

# Backup — git-native, redeployable disaster recovery (REST; needs N8N_API_KEY)
n8n-decanter backup create <workflow>                            # capture a full-export backup into backups/
n8n-decanter backup restore <workflow> [<backup>]               # redeploy as a NEW, unpublished workflow
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
| `<execution-id>` | an n8n execution id (numeric) — `preflight --execution`, `test --execution`, `executions <execution-id>` |
| `<slug>` | a scenario name — `scenario create`/`scenario check`, `preflight --scenario`/`test --scenario` (kebab-cased) |
| `<ids>` | a comma list of [preflight](/docs/cli/preflight/) check ids — `preflight --require=layout,simulate` |
| `<backup>` | a backup: **timestamp (or a prefix, e.g. a bare date) · versionId (short or full)** — `backup restore` |

## Interactive picker

Running **bare `n8n-decanter`** (no verb, no arguments) in an inited project
on a terminal opens a picker instead of printing usage: type to filter,
`↑`/`↓` to move. Each row leads with a status glyph — `●` for a pulled
workflow (green), `○` for a not-yet-pulled remote one (yellow), `⊘` for a
remote workflow **not yet available in MCP** (red, sorted last) — so the state
reads by shape, not color alone, and the ids line up in an aligned column.
`Enter` on a pulled workflow offers `preflight` / `preflight --simulate` /
`diff` / `pull` / `push` / `watch` / `executions` — a row may carry flags, and
the `--simulate` row runs the browsable
[`--viewer`](/docs/cli/preflight/#--viewer--browse-the-run-in-a-real-n8n) form.
`Enter` on an unpulled one pulls it directly; `Enter` on a `⊘` row explains
where to flip the "Available in MCP" switch in n8n. It stays in the workflow's verb
menu between runs, `Esc` backs out to the list, `Esc` again quits. Piped
output and dirs without a `decanter.config.json` keep printing usage — scripts
and LLM harnesses never see the picker.

**Pulled workflows are listed newest-synced first** — the one you last pulled
or pushed is under the cursor when the picker opens, so the workflow you are
actually working on doesn't have to be hunted for. Unpulled remote rows keep
their place after the local ones. The order comes from each workflow folder's
sync timestamp, which is *local activity* and not committed history: right
after a fresh `git clone` everything looks equally recent, so the list falls
back to alphabetical until your first pull or push. The scripted
[`list`](/docs/cli/list/) output is unaffected — it stays alphabetical.

**A drift failure offers a `--force` retry.** If a `push` from the picker
aborts because the code changed in n8n since your last sync, the picker asks
`retry with --force and overwrite the remote draft? [y/N]` instead of just
printing the hint and dropping back to the menu. The default is **No** — a bare
`Enter` (or anything other than `y`/`yes`) declines and returns to the menu,
and answering `y` re-runs the same action with `--force`, which overwrites the
n8n **draft** only. The offer appears *only* for failures `--force` can
actually fix: a [layout-compliance](/docs/cli/preflight/) error never prompts,
because forcing would not help. Non-interactive runs are unchanged — they never
prompt, they print the `--force` hint and exit non-zero.

**No-ref → picker.** A ref-taking verb given *no* workflow, on a terminal, opens
the picker to choose one and then runs that verb on it (the verb menu is
skipped). The same newest-synced-first ordering applies. For `pull` the list
includes **remote** workflows too (as in the bare picker), so a fresh setup
with nothing pulled still gets a menu to pick from; the other verbs act on
already-pulled workflows only. This includes the `backup …` and `scenario …`
sub-verbs, whose first argument is a workflow ref. Piped/non-TTY runs keep the
config-default / error path unchanged, so scripts and LLM harnesses never
block. The force-retry confirm belongs to the interactive picker *session*
(bare `n8n-decanter`), so this single-select path prints the ordinary
`--force` hint instead.

## Workflow refs

A `<workflow>` is its **id, its workflow/folder name, or a unique name
prefix** — `n8n-decanter push "Order Sync"` and `n8n-decanter push order`
both work. Matching is case-insensitive and never prompts: an ambiguous or
unknown name errors with the candidate list. `pull` resolves not-yet-pulled
names against the server's workflow list. Without a workflow argument, all
workflows from the config are processed (or the picker opens, on a terminal).

**Verb-first grammar.** The verb is the first argument; everything after it is
an argument. `n8n-decanter diff push` runs `diff` on the workflow named
`push` — no "address it by id" caveat. Verb-last (`n8n-decanter wf123 push`)
errors with *unknown verb*. Flags may still appear in any position.

## Offline vs. online

| Verbs | Network |
| --- | --- |
| `preflight --offline`, `node run`, `list`, `scenario check`, `completion`, `executions clean`, `data-tables clean` | Fully offline — no credentials needed (`list --remote` is the exception; `preflight --offline --simulate` needs Docker but never the n8n instance; `scenario create --scaffold` is the exception in the `scenario` namespace — it needs MCP) |
| `diff`, `list --remote`, `executions`, `data-tables`, `backup create`/`restore` | Read the remote (`backup restore` also writes a **new** workflow, never touching the source) |
| `backup list` | Fully offline — reads the local `backups/` store |
| `test` | Runs the workflow's **draft** on the instance with pinned data — run it **after a push** so the draft holds your code. On a terminal, when local differs: a **published** workflow gets a local-vs-draft prompt; an **unpublished** one is pushed without asking (a draft nobody runs). Non-interactive runs never write |
| `preflight` | Verifies your **local** code as one scored gate — static + instance reads, plus an optional local-engine replay (`--simulate`); **never writes and never runs on the instance**, with any flag combination. `--offline` drops the instance reads entirely. Run it *before* `push`; `test` comes after |
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
