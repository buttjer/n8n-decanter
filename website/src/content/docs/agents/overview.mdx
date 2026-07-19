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
4. `code/<node>.remote.js` is an incoming-change artifact — port it, delete
   it; never edit or push over it.

## Who runs what

| Commands | Agent policy |
| --- | --- |
| `check`, `run`, `uuid`, `rename` | Offline and safe — run freely. |
| `status` | Reads the remote, no writes — safe, but it does contact the instance. |
| `pull`, `push`, `watch` | Touch the live instance — only when the user explicitly asks. |
| `push --force` | Never without explicit instruction — it overrides the drift guard protecting UI edits. |

The default loop for an agent: edit → verify offline → report that the change
is ready to push. See [The offline feedback loop](/docs/agents/offline-loop/).
