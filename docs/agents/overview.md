---
title: Working with coding agents
description: What init scaffolds for agents, the AGENTS.md contract, and the guard hooks.
order: 1
---

n8n-decanter is built to let AI coding agents work on workflows safely. A
scaffolded [sync dir](/docs/concepts/sync-layout/#the-sync-dir) ([init](/docs/cli/init/)) contains everything an agent
needs to behave:

- **`AGENTS.md`** — the tool-agnostic contract for the repo: how code is
  stored here (placeholders, `code/`, markers), the file-ownership rules, the
  rename checklist, and how to verify changes. Codex and opencode read it
  natively; Claude Code reads it through a one-line import in `CLAUDE.md`.
- **Per-agent configs** — Claude Code, Cursor, Codex, opencode — kept as thin
  pointers to `AGENTS.md`, so every agent follows the same rules.
- **Guard hooks** — on Claude Code and opencode, edits that would break a
  hard invariant are blocked *before the write happens*; a Claude Code
  PostToolUse hook runs [`preflight --offline`](/docs/cli/preflight/) after
  node edits. A second PostToolUse hook watches MCP `update_workflow` calls and
  speaks up when a `renameNode` leaves `$('Old Name')` references behind —
  n8n's rename rewrites the node name and connections only, so those refs are
  the caller's to repair (see [`pull`](/docs/cli/pull/)). It scans for the old
  name rather than running `preflight`, because it fires before the background
  snapshot refresh, while every reference still resolves. The same rules are
  enforced by the CLI at push time regardless of who made the edit.
  Each hook finds the sync dir from its own installed location, so it behaves
  the same whether the agent was started in the sync dir or above it.
  On Claude Code these live in **`.claude/settings.json`** — *project* scope,
  meant to be committed, so everyone who clones the repo gets the same
  permissions and hooks. `.claude/settings.local.json` stays yours for
  machine-specific rules: permission lists merge across the two and a `deny`
  beats an `allow`, so your local file can add to the policy but cannot unblock
  what the project denies.

**Restart the agent after `init`.** MCP servers, permission rules and hooks are
read at **agent startup**, and `init` is normally run from inside the very
session it configures — so that session has no `n8n-instance` tools and no deny
rules until it restarts (or `/reload`s). There is no hot-reload; `init` prints
the reminder when it first scaffolds those files, and the scaffolded `AGENTS.md`
tells the agent to ask for a restart rather than route around the missing guard.

## Where the agent wiring loads from

`init` scaffolds `.mcp.json`, `.claude/settings.json` and the hook scripts
**into the sync dir**. When the sync dir is where you start the agent, that is
the end of the story. When it is a subfolder of a bigger repo, what actually
loads depends on **where the agent was started** — and the files disagree about
it (matrix verified against Claude Code 2.1.x):

| Agent started at | `<syncdir>/.mcp.json` | `<syncdir>/.claude/settings.json` | repo root's `.claude/settings.json` |
| --- | --- | --- | --- |
| **the repo root** | not loaded | not loaded | loaded |
| **the sync dir** | **loaded** (merged with the repo root's) | **loaded** | not loaded |

- **`.mcp.json` walks up.** Every ancestor of the launch directory is read and
  merged, nearest wins — so a nested one is *additive* for an agent started
  inside the sync dir, and unreachable from above. Nothing ever scans downward.
- **`.claude/settings.json` is launch-directory only** — no walk in either
  direction. A nested one contributes **nothing** to a root-launched session:
  not permissions, not hooks, not `env`. Nothing reports this; you get a hook
  that never runs and deny rules that were never in force.
- **`.claude/settings.local.json` is the one exception** — it is read from the
  *repository root*, so the root's local file is the one thing that still
  reaches a session started in a subdirectory, while the `settings.json` beside
  it does not. That makes it a trap when you test the nested case: a setup
  verified through `settings.local.json` looks fine while the committed
  `settings.json` next to it is inert. `init` writes no local file, so it is
  not a fix path either.
- **`--add-dir` does not rescue it.** It grants file *access* to another
  directory; it does not turn that directory into a settings source.
- **`${CLAUDE_PROJECT_DIR}` is not a shortcut either** — it expands to the
  agent's project root, i.e. the *parent*, so in a root-level file it reads as
  if it pointed at the sync dir and never does. Write the sync-dir prefix out.
- **Hooks have no discovery of their own** — they ride the `hooks` key of those
  same settings files. Their *scripts* do locate the sync dir themselves (from
  their own installed path), so a hook that runs behaves identically whether the
  agent started in the sync dir or above it. What still has to be right is the
  command path in whichever settings file declares it: the scaffolded
  `node .claude/hooks/verify.mjs` needs a `flows/` prefix in a root-level file.
- **Permission patterns anchor at the settings file's own project root**, which
  makes a verbatim hoist worse than a no-op: `Edit(workflows/**)` then matches
  nothing, and — the sharp end — `Read(.env)` / `Edit(.env)` stop protecting
  `<syncdir>/.env`, the credentials file. Prefix every relative **path** pattern
  with the sync dir if you move the block up — the `Bash(…)` rules and an
  already-`**/`-anchored one like `Edit(**/.decanter.json)` carry over as they
  are.

**Two shapes work, and the first is the recommendation:** start the agent **in
the sync dir** (zero configuration — you only give up the parent repo's root
`settings.json`), or wire the repo root deliberately. Root wiring means an MCP
entry carrying both `N8N_DECANTER_DIR` and a command that resolves from the root
— spelled out in
[mcp connect](/docs/cli/mcp-connect/#when-your-sync-dir-is-not-your-project-root)
— plus the prefixing above for any hooks and permissions you hoist.
[`init`](/docs/cli/init/#when-the-sync-dir-is-nested-in-a-bigger-repo) prints
both options when it scaffolds into a nested directory.

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
| `preflight --offline`, `node run`, `scenario` | Offline and safe — run freely (`scenario create --scaffold` is the exception; it needs MCP). Adding `--simulate` stays credential-free but boots a local Docker engine — minutes, not milliseconds, so opt in deliberately. |
| `preflight`, `diff`, `list --remote` | Read the remote, no writes — safe, but they do contact the instance. `preflight` is the gate (exit 1 when `not ready`); `diff` is the view and **always exits 0**. |
| `pull`, `push`, `watch` | Sync code with the instance. A push lands on the **draft** and never changes what is running, so it is **part of finishing the work** — code that only exists in the folder is not done. Say a word first if the workflow is published/active or a teammate is editing it. |
| `publish`, `unpublish`, `push --publish` | **Change what is actually live — only when the user explicitly asks.** Never fold going live into "finishing the work". |
| Structure/lifecycle acts over n8n's MCP (create, add/wire nodes — via the [guard](/docs/cli/mcp-connect/)) | Building the structure a request describes is part of the work. **Renaming or archiving something that already exists is not** — ask first. After a structure act, `pull` reconciles the local mirror. |
| `test` | Grades the workflow's **draft** on the instance. **Bare** it is a static check — dangling `$('…')` references, nothing executes, no capture needed. **With `--execution`/`--scenario`** it executes the draft (pinned trigger/network nodes, real logic nodes); the live version is never affected and non-interactive runs never write. Either way it is only meaningful **after a `push`** — before one, the draft holds the old code (or nothing). It is the post-push check in `preflight → push → test → publish`, and the static half is what `publish` refuses on. |
| Archiving (MCP `archive_workflow`) | **Outward-facing** — the workflow leaves the active list; a published one goes offline. Reversible only in the n8n UI. Never without an explicit instruction to archive *that* workflow. |
| `push --force` | Never without explicit instruction — it overrides the per-node drift guard protecting code edited on the instance. |

The default loop for an agent: **orient** → edit → verify
([`preflight`](/docs/cli/preflight/), or `preflight --offline` to stay
credential-free) → **push** → **`test`** (the draft now holds your code) → say
what landed and what the test showed. Stop before `publish` unless the user
asked for it. See [The offline feedback loop](/docs/agents/offline-loop/).

**Orienting is the same `preflight`, run before the first edit rather than
after the last one** — it reads the instance and writes nothing. Its sync tier
answers the question an agent otherwise discovers too late: did someone edit
this code in the n8n UI while you were away (`drift` — then
[`pull`](/docs/cli/pull/) and carry on), did both sides move (`CONFLICT` — stop
and show the user [`diff`](/docs/cli/diff/) before either version is
overwritten), is a push from an earlier session still pending (`parity`).
Skipping it is not destructive — `push` refuses to overwrite remote edits — but
the work may have to be redone.
