---
title: Working with coding agents
description: What init scaffolds for agents, the AGENTS.md contract, and the guard hooks.
order: 1
---

n8n-decanter is built to let AI coding agents work on workflows safely. A
scaffolded sync dir ([init](/docs/cli/init/)) contains everything an agent
needs to behave:

- **`AGENTS.md`** — the tool-agnostic contract for the repo: how code is
  stored here (placeholders, `code/`, markers), the file-ownership rules, the
  rename checklist, and how to verify changes. Codex and opencode read it
  natively; Claude Code reads it through a one-line import in `CLAUDE.md`.
- **Per-agent configs** — Claude Code, Cursor, Codex, opencode — kept as thin
  pointers to `AGENTS.md`, so every agent follows the same rules.
- **Guard hooks** — on Claude Code and opencode, edits that would break a
  hard invariant are blocked *before the write happens*; a Claude Code
  PostToolUse hook runs [check](/docs/cli/check/) after node edits. The same
  rules are enforced by the CLI at push time regardless of who made the edit.

## The hard invariants

Violating these corrupts sync state, which is why they're machine-enforced:

1. `jsCode` in `workflow.json` never contains code — only `//@file:`
   placeholders.
2. Never write a `// @ts-n8n sha256:…` marker line — the tool appends it to
   compiled output on push.
3. `.decanter.json` is machine state — never edit it, never "fix" a hash.

Two boundary rules sit next to them: **Code-node source is authored as files
here and synced by decanter — never edited on the instance** (not in the UI,
not via n8n's MCP tools or skills); and **`workflow.json` is a read-only
snapshot** — structure changes go through n8n. n8n-decanter is built to pair
with n8n's official skills pack: see [Using n8n's official skills](/docs/agents/n8n-skills/)
for how the `mcp serve` guard-proxy makes that boundary safe by construction.

## Who runs what

| Commands | Agent policy |
| --- | --- |
| `check`, `node run`, `scenario` | Offline and safe — run freely (`scenario create --scaffold` is the exception; it needs MCP). |
| `status`, `list --remote` | Read the remote, no writes — safe, but they do contact the instance. |
| `pull`, `push`, `watch`, `publish`, `unpublish` | Touch the live instance — only when the user explicitly asks. Pushes land on the **draft**; `publish` (or `push --publish`) takes it live. |
| Structure/lifecycle acts over n8n's MCP (create, rename, add/wire nodes — via the [guard](/docs/cli/mcp-connect/)) | Touch the live instance too — same rule: only when the user asks. After a structure act, `pull` reconciles the local mirror. |
| `test` | Executes the workflow's **draft** on the instance (pinned trigger/network nodes, real logic nodes) — code runs remotely, so treat like a push: only when the user asks. Non-interactive runs never write; the live version is never affected. |
| Archiving (MCP `archive_workflow`) | **Outward-facing** — the workflow leaves the active list; a published one goes offline. Reversible only in the n8n UI. Never without an explicit instruction to archive *that* workflow. |
| `push --force` | Never without explicit instruction — it overrides the per-node drift guard protecting code edited on the instance. |

The default loop for an agent: edit → verify offline → report that the change
is ready to push. See [The offline feedback loop](/docs/agents/offline-loop/).
