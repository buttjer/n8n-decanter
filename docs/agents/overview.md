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
  On Claude Code these live in **`.claude/settings.json`** — *project* scope,
  meant to be committed, so everyone who clones the repo gets the same
  permissions and hooks. `.claude/settings.local.json` stays yours for
  machine-specific rules: permission lists merge across the two and a `deny`
  beats an `allow`, so your local file can add to the policy but cannot unblock
  what the project denies.

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
for how the MCP guard (`mcp connect`; `mcp serve` for URL-only harnesses) makes
that boundary safe by construction.

## Who runs what

| Commands | Agent policy |
| --- | --- |
| `check`, `node run`, `scenario` | Offline and safe — run freely (`scenario create --scaffold` is the exception; it needs MCP). |
| `status`, `list --remote` | Read the remote, no writes — safe, but they do contact the instance. |
| `pull`, `push`, `watch` | Sync code with the instance. A push lands on the **draft** and never changes what is running, so it is **part of finishing the work** — code that only exists in the folder is not done. Say a word first if the workflow is published/active or a teammate is editing it. |
| `publish`, `unpublish`, `push --publish` | **Change what is actually live — only when the user explicitly asks.** Never fold going live into "finishing the work". |
| Structure/lifecycle acts over n8n's MCP (create, add/wire nodes — via the [guard](/docs/cli/mcp-connect/)) | Building the structure a request describes is part of the work. **Renaming or archiving something that already exists is not** — ask first. After a structure act, `pull` reconciles the local mirror. |
| `test` | Executes the workflow's **draft** on the instance (pinned trigger/network nodes, real logic nodes) — code runs remotely, but the live version is never affected and non-interactive runs never write. Fine as part of verifying your own change. |
| Archiving (MCP `archive_workflow`) | **Outward-facing** — the workflow leaves the active list; a published one goes offline. Reversible only in the n8n UI. Never without an explicit instruction to archive *that* workflow. |
| `push --force` | Never without explicit instruction — it overrides the per-node drift guard protecting code edited on the instance. |

The default loop for an agent: edit → verify offline → **push** → say what
landed. Stop before `publish` unless the user asked for it. See
[The offline feedback loop](/docs/agents/offline-loop/).
