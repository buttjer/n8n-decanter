# n8n-decanter

[![CI](https://github.com/buttjer/n8n-decanter/actions/workflows/ci.yml/badge.svg)](https://github.com/buttjer/n8n-decanter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/n8n-decanter)](https://www.npmjs.com/package/n8n-decanter)
[![Docs](https://img.shields.io/badge/docs-website-blue.svg)](https://buttjer.github.io/n8n-decanter/)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![vibe coded](https://img.shields.io/badge/vibe%20coded-with%20Claude%20Code-8A2BE2)](https://claude.com/claude-code)

**The toolkit for building code-heavy n8n workflows — agent-first, MCP-native.**

*Code nodes as files* — TypeScript, shared types & helpers, code-level git
versioning, preflights.

**Pre-1.0 — breaking changes to the data model or CLI may ship in minor
versions until v1.0.**

> **Built with AI agents.** Much of this codebase was written by Claude Code
> under human review. It's tested (CI + a real-n8n integration suite) and used
> in earnest, but treat pre-1.0 the way the version implies.

n8n-decanter puts your n8n **Code-node source** in git: a folder per workflow,
every Code node's source its own `.js` or `.ts` file, editable in your IDE or
by your agent, and synced back over **n8n's built-in MCP server** — draft-first,
so nothing goes live until you `publish`. Workflow *structure* stays n8n's job
(the editor, or n8n's own MCP tools); decanter keeps a read-only
`workflow.json` snapshot for review diffs.

![Terminal demo — the interactive picker: filter workflows, choose a verb, sync](./docs/terminal-demo.gif)

- **Real version control** — meaningful diffs, PRs, blame; every push and
  pull is auto-committed.
- **TypeScript or typed JS** — write nodes in TS (compiled on push) or plain
  JS; n8n globals (`$input`, `$('…')`, …) are typed in both.
- **Agent-native** — `init` scaffolds Claude Code / Cursor / Codex configs;
  offline `check` and `node run` give agents a credential-free feedback loop.
- **Guardrails & preflights** — a compliance guard, typecheck gate, and
  per-node drift guard gate every push; `check` (offline), `simulate`
  (offline engine replay, Docker), and `test` (instance-side) each diff every
  node against a real captured execution and exit 1 on divergence — and
  `preflight` runs the whole ladder as one **scored, read-only, CI-gateable
  verdict** (never mutates), the single gate an agent runs before `push`.
- **Committed, schema-scaffolded scenarios** — `scenario create` turns a
  captured execution and/or the workflow's own output schemas
  (`--scaffold`, no LLM API) into a reviewable, git-tracked pin-data set that
  `test`/`simulate` replay — the durable counterpart to an agent's ephemeral
  in-session pin flow.
- **Live editing** — `watch` pushes on save and auto-reloads the n8n editor
  tab via a local proxy.
- **Guarded agent access to n8n's MCP — wired by default** — the scaffolded
  `.mcp.json` spawns `mcp connect`, forwarding the full n8n MCP surface
  except writes to a Code node's `jsCode`; no secret to manage.
- **Shared code and small libraries** — `.ts` nodes import helpers/types from
  `shared/` and opted-in npm packages, bundled on push into self-contained
  nodes that run anywhere, n8n Cloud included.
- **Draft-first by construction** — every push lands on the workflow's
  **draft**; `publish` (or `push --publish`) is the deliberate go-live step.

![Agent demo — a coding agent edits a Code node, verifies it offline, then pushes to the draft](./docs/agent-demo.gif)

📖 **Full documentation: [buttjer.github.io/n8n-decanter](https://buttjer.github.io/n8n-decanter/)**

## Setup

Requires **Node >= 22.18** (no build step — the CLI runs natively via Node's
type stripping). Needs an n8n with the built-in **MCP server** (~2.20+):
enable it once (Settings → MCP) and flip **"Available in MCP"** on each
workflow you want to sync.

```sh
npm install -g n8n-decanter
n8n-decanter init [dir]   # OAuth in your browser (or a pasted MCP token)
```

Then add workflow ids to `decanter.config.json`:

```json
{ "root": "./workflows", "workflows": ["0cXNQKKzmO0pXiCq"] }
```

**Credentials:** OAuth by default (via `init`); `N8N_MCP_TOKEN` for
headless/CI; `N8N_API_KEY` is optional, needed only for `executions` and
`data-tables`. Details: [Installation](docs/getting-started/installation.md),
[init](docs/cli/init.md), [Configuration](docs/concepts/configuration.md).

## Works with n8n's official skills

n8n-decanter pairs with the **[official n8n skills](https://github.com/n8n-io/skills)**
— n8n's first-party agent knowledge pack — rather than replacing them: they
teach your agent the n8n runtime and build workflow structure over MCP, which
is n8n's job here. The one boundary is **Code-node source**, and it's already
enforced: the scaffolded `.mcp.json` routes your agent's n8n MCP traffic
through [`mcp connect`](docs/cli/mcp-connect.md), a guard that forwards
everything except writes to a Code node's `jsCode` — those redirect back to
the repo (edit the file, `push`). No secret to manage.

**Full guide: [Using n8n's official skills](docs/agents/n8n-skills.md).**

## Commands

Bare `n8n-decanter` (no verb) opens an interactive picker on a terminal.
Full flag reference: `n8n-decanter --help`, or the
[command overview](docs/cli/overview.md).

| Verb | What it does |
|---|---|
| `init [dir]` | Interactive bootstrap — OAuth, template, config, agent tooling |
| `completion zsh\|bash` | Print a shell completion script |
| `pull [workflow…]` | Code + structure snapshot → `workflows/<kebab>/` |
| `push [workflow…]` | Push Code-node source to the workflow's **draft** |
| `watch [workflow]` | Push on save (draft-only), optional browser live-reload |
| `publish` / `unpublish [workflow…]` | Take the draft live / back to draft-only |
| `status [workflow…]` | Drift report — exits 1 on conflict or remote drift |
| `check [workflow…]` | Offline layout-compliance check + typecheck |
| `executions [workflow…]` | Fetch recent execution data (read-only) |
| `data-tables [table…]` | Fetch data-table schema + rows (read-only) |
| `test <workflow>` | Pinned run **on the instance** (draft); diffs vs a capture |
| `simulate <workflow>` | Offline engine replay (Docker); diffs vs a capture |
| `preflight [workflow…]` | The whole verification ladder as one scored, read-only gate (exits 1 on *not ready*) |
| `scenario create` / `scenario check` | Build / validate a committed scenario (captured and/or schema-scaffolded) |
| `list [--remote]` | Pulled workflows (`--remote` adds unpulled ones) |
| `mcp connect` / `mcp serve` | Guarded MCP access for coding agents |
| `node run <node-file>` | Run a Code node offline, print its items |

A `<workflow>` is its **id, name, unique name-prefix, or folder name**
(case-insensitive; ambiguity errors instead of prompting). Creating,
renaming, and archiving workflows — and adding or renaming nodes — are
**n8n's acts**: do them in the editor or let your agent do it over n8n's MCP
tools (through the guard above); the next `pull` reconciles the local mirror.

## How it compares

n8n-decanter is **Code-node-first**: it optimizes the loop of writing, typing,
verifying, and shipping the JavaScript/TypeScript *inside* your workflows. It
builds **on** n8n's own MCP server and skills — they're the foundation it rides
for structure and lifecycle, not a rival. So the comparison below is against the
native editor and against
[n8n-as-code](https://github.com/EtienneLescot/n8n-as-code) — a broader,
whole-workflow authoring toolkit.

> **Choose [n8n-as-code](https://github.com/EtienneLescot/n8n-as-code) if you…**
> need an enterprise-ready automation framework — where AI agents assemble
> complete workflows, multi-environment Dev → Prod pipelines automatically handle
> credential governance, and full TypeScript GitOps ensures strict auditability
> across your team.
>
> **Choose n8n-decanter if you…** your workflows live or die by their Code nodes
> and you want them as real files — typed TypeScript, shared libraries,
> preflights (offline or instance-side), and code-level git history, synced
> draft-first between your IDE, your coding agent, and n8n (even on Cloud).

| Capability | Native n8n (browser) | n8n-as-code | n8n-decanter |
|---|---|---|---|
| **TypeScript for Code nodes** | ❌ JavaScript or Python only | ❌ TS is at workflow level, not node logic | ✅ Code nodes as `.ts`, compiled on push, typed n8n globals |
| **Shared types & helpers in Code nodes** | ❌ self-host `NODE_FUNCTION_ALLOW_*` only; no libraries | ❌ not part of its model | ✅ `shared/*.ts` + npm bundled into self-contained nodes (Cloud-safe) |
| **Code as individual files** | ❌ no source files (JSON blob) | 🟡 one `.workflow.ts` per workflow | ✅ folder per workflow; each Code node its own `.js`/`.ts` |
| **Code-level git versioning** | 🟡 in-app history (DB snapshots, tiered retention); Git source control is Enterprise-only | ✅ GitOps sync of workflow source | ✅ real git — diffs, PRs, blame per Code node; auto-commit each sync (+ read-only structure snapshot) |
| **Preflights** (`check` / `simulate` / `test` / `preflight`) | 🟡 re-run past executions / pin data, but online in-editor | 🟡 inspect executions against a live env | ✅ offline `check` + `simulate`, instance-side `test`; each diffs every node vs a real capture, exits 1 on divergence — and `preflight` scores the whole ladder into one read-only, CI-gateable verdict |
| **Draft-first code sync** | ✅ editor *Save* vs *Publish* (manual, in-browser) | 🟡 API sync republishes on push (no draft-only) | ✅ pushes land on the **draft**; `publish` is the deliberate go-live (over MCP) |
| **Live editing** | ✅ the canvas (baseline) | 🟡 explicit pull/push, no auto-watch | ✅ `watch`: push on save + auto-reload the editor tab |
| **Agent-native tooling** | 🟡 n8n's own canvas AI, not your agent on the codebase | ✅ Agent Workbench, skills, MCP, Claude/editor plugins | ✅ scaffolds Claude Code / Cursor / Codex configs incl. a pre-wired `mcp connect` guard holding the credentials; offline `check`/`node run` loop |
| **Model ownership** | ❌ locked to n8n's own hosted AI; can't use your Claude subscription | 🟡 beta Claude Code plugin uses your subscription; flagship Workbench needs an Anthropic key for Claude | ✅ never calls an LLM itself — your agent/subscription does 100%, no key or model config ever |
| **Agentic workflow creation** | 🟡 AI Workflow Builder (natural language), but Cloud / plan-gated — credits, self-host needs setup | ✅ 537 node schemas + 7,700+ templates + skills | ✅ your agent builds structure over n8n's MCP (through the pre-wired `mcp connect` guard); decanter owns the Code-node source (files + `push`) |
| **Whole-workflow authoring** | ❌ | ✅ `.workflow.ts` decorator classes (structure + links) | ❌ by design — structure stays n8n's (read-only `workflow.json` snapshot) |
| **Multi-environment promotion** | 🟡 Enterprise source control / environments | ✅ `promote` remaps creds + refs Dev→Prod | 🟡 separate sync dir per instance, but no `promote` (IDs/creds/refs not remapped) |

Legend: ✅ first-class · 🟡 partial or indirect · ❌ not supported.

**Bottom line:** reach for n8n-decanter when your workflows live or die by their
Code nodes — TypeScript, shared libraries, preflights, and code-level git
history, shipped draft-first. It rides n8n's own MCP and skills for everything
structural, so n8n-as-code still shines for whole-workflow authoring/generation
and multi-environment ops, and the native editor stays the live visual canvas
everything syncs back to. And decanter makes no LLM calls of its own — you drive
it with the coding agent you already run, so Claude Code on a Claude subscription
needs no extra API tokens.

## Caveats

- **MCP floor and opt-ins.** Needs n8n's built-in MCP server (~2.20+), MCP
  access enabled instance-wide, and each workflow's "Available in MCP" flag —
  `list --remote` and the picker show what's still missing.
- **Structure edits don't sync from here.** `workflow.json` is a read-only
  snapshot: wire nodes, change parameters, and arrange the canvas in n8n
  itself (or an agent over n8n's MCP) — `pull` reconciles afterwards.
- **Remote code edits are surfaced, then overwritten.** The per-node drift
  guard blocks a push when a Code node changed on the instance since the last
  sync; pulling re-baselines, so the next push replaces it by design — the
  repo's files are the source of truth for code.

Details: [Push gates](docs/concepts/push-gates.md),
[Sync layout](docs/concepts/sync-layout.md),
[Configuration](docs/concepts/configuration.md).

*Not affiliated with or endorsed by n8n GmbH.*
