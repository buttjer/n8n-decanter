---
title: mcp connect
description: The stdio MCP guard your agent spawns — full n8n MCP access, minus Code-node writes, no secret.
order: 11
---

```sh
n8n-decanter mcp connect
```

The **stdio MCP guard** — the default way a coding agent reaches your n8n
instance's MCP server. You never run it by hand: the scaffolded `.mcp.json`
(and `opencode.json`) from [init](/docs/cli/init/) already contains

```json
{
  "mcpServers": {
    "n8n-instance": { "command": "npx", "args": ["--no-install", "n8n-decanter", "mcp", "connect"] }
  }
}
```

and the agent spawns it per session. (It runs through `npx --no-install` so the
command resolves whether decanter is installed **globally** or as a **local**
project dependency — a bare `n8n-decanter` would only resolve on the agent's
`PATH`, i.e. a global install, and fail silently otherwise. `--no-install` keeps
it strictly local: it never downloads from npm, so a missing install fails
loudly instead.) It speaks MCP over stdio to the agent and
forwards each call to your instance's `/mcp-server/http` with **decanter's own
credentials** (from `.env` / `.decanter-auth.json`) — the agent never holds an
n8n credential, and because stdio pipes are private to the two processes,
**no session secret exists at all**.

**`connect` obtains no credentials — that is exclusively [init](/docs/cli/init/)'s
job.** "Decanter's own credentials" means credentials `init` already wrote to
`.env` (`N8N_MCP_TOKEN`) or `.decanter-auth.json` (OAuth); the guard only *reads*
them (and silently refreshes an OAuth access token from the stored refresh
token — it cannot mint one). There is no login, consent, or token-minting step
inside `connect`. So "no secret to manage" is about the **agent** having no
credential of its own, not about the sync dir needing none: without `init` there
is nothing to read, and the guard answers the agent's first tool call with
``no MCP credentials — run `n8n-decanter init …` `` rather than fetching any.
A 401 is the other direction — credentials exist but were rotated or revoked;
the guard says so explicitly so an agent does not report the project as
"never set up".

The guard is the same one [mcp serve](/docs/cli/mcp-serve/) enforces over HTTP:

- **Blocked:** `update_workflow` calls that write Code-node source
  (`jsCode`) — the caller gets an instructive tool error pointing at the file
  \+ [push](/docs/cli/push/) flow.
- **Blocked:** `publish_workflow` when the draft it would take live carries a
  dangling `$('…')` reference — the same check [`test`](/docs/cli/test/) and
  [`publish`](/docs/cli/publish/) run, so an agent cannot go live around the
  verb. **Fail-closed**: if the check itself cannot run, the publish is refused
  too, and the message says the *check* failed rather than blaming the workflow.
- **Everything else forwards untouched**: reads, structure edits (`addNode`,
  `renameNode`, wiring), archiving — the whole n8n MCP surface, SSE responses
  included.

That combination is what powers the guarded authoring loop: an agent builds
and wires structure over MCP (adding Code nodes **without** `jsCode` — the
guard blocks code), then `pull` lands each new Code node as an empty file in
`code/`, and the first `push` seeds its source from the repo.

**Live mirror.** When the guard forwards a structure edit (a non-blocked
`update_workflow`), it schedules a debounced background `pull` of that
workflow, so the read-only `workflow.json` snapshot (+ code files + state)
refreshes itself — the clean git diff of structure changes keeps pace with the
agent, with no manual `pull`. It's fire-and-forget (never blocks the agent's
next call), git-gated (a dirty tree is safety-committed before the pull; with
no git it's skipped), and tracked-only (a brand-new, untracked workflow is left
for an explicit `pull`). On by default; set `"liveMirror": false` in
`decanter.config.json` to turn it off (CI / deterministic setups).

**If that safety commit fails, the refresh does not happen.** The commit is what
makes the mirror safe to run behind your back, so a failed commit is treated as
"do not touch the tree" rather than as a warning to pull anyway — the mirror
skips and says so, and the snapshot stays stale until you `pull` yourself.

**If the refresh overwrites an unpushed local edit, the agent is told.** It is a
full `pull`, so local code the instance doesn't have yet loses. That has always
printed a warning — but to the guard's stderr, which is the MCP client's server
log, not the agent's transcript: the one party who could react never saw it. The
warning now rides the **result of the agent's next tool call**, naming the files
and how to recover them from the safety commit, and is delivered once rather than
repeated. Push local code edits before restructuring and it never fires.

This part is `mcp connect` only. [`mcp serve`](/docs/cli/mcp-serve/) pipes
upstream responses through untouched — including SSE — so there is no parsed
message to append to; buffering every response to inject an advisory line would
cost streaming for all of them to deliver it on some. On that transport the
stderr warning stays the only signal, so prefer pushing before you restructure
(or `"liveMirror": false`).

Failure posture matches the HTTP guard: unparseable input is refused
(**fail closed**), and an unreachable instance answers the agent with a
JSON-RPC error naming the host instead of hanging. Logs go to stderr; stdout
carries only protocol messages. The process ends when the agent closes the
session.

**The handshake is the one exception, and it has to be.** `initialize` is
forwarded like everything else, but if n8n does not answer it, the guard
completes the handshake **itself** — an error there is fatal to the whole MCP
session, and the agent would be left with a dead server instead of a working
one pointed at a down instance. The tool call that actually needs n8n reports
the failure, which is where it belongs. Once the instance is reachable again,
the guard replays the handshake upstream before the next forward, so the
recovered session is a real one.

## When your sync dir is not your project root

`init` writes `.mcp.json` **into the sync dir**, which quietly assumes the sync
dir is where you start the agent. In a monorepo it often isn't — and the file is
loaded only if the agent's own discovery can see it. Claude Code finds
`.mcp.json` by walking **up** from its launch directory (every ancestor, merged,
nearest wins) and never scans downward: a sync dir at `<repo>/flows` is fully
wired for an agent started in `flows/`, and completely invisible to one started
at `<repo>/`. `.claude/settings.json` is stricter still — the full per-file
matrix is in
[Working with coding agents](/docs/agents/overview/#where-the-agent-wiring-loads-from).

**Option A — start the agent in the sync dir.** The recommendation, because it
needs no configuration at all:

```sh
cd flows && claude
```

Everything `init` scaffolded then applies exactly as written, including the
permission rules that keep the agent out of `.env`. The one cost: the parent
repo's own root `.claude/settings.json` no longer loads (its `.mcp.json` still
does, via the upward walk).

**Option B — wire the repo root.** Spawning the guard from above the sync dir
breaks **two** independent things, and a working entry has to fix both:

- decanter searches for `decanter.config.json` **upward** from the working
  directory, so from the repo root it never sees `flows/decanter.config.json`.
  `N8N_DECANTER_DIR` moves where that search starts — see
  [configuration](/docs/concepts/configuration/#pointing-at-a-nested-sync-dir).
- `npx --no-install` resolves the binary from the working directory's
  `node_modules/.bin`. Under a **local** install that directory is in the sync
  dir, so from the root the command itself is not found.

A `<repo-root>/.mcp.json` entry for a sync dir at `flows/`, decanter installed
as a project dependency of it:

```json
{
  "mcpServers": {
    "n8n-instance": {
      "command": "flows/node_modules/.bin/n8n-decanter",
      "args": ["mcp", "connect"],
      "env": { "N8N_DECANTER_DIR": "flows" }
    }
  }
}
```

With a **global** install the command is just `"n8n-decanter"` (the scaffolded
`npx --no-install` form works too — it falls back to `PATH`), so the `env` block
is the only new part. opencode's `opencode.json` wants the same two halves: its
`command` array plus an `environment` block carrying `N8N_DECANTER_DIR`.
[`init`](/docs/cli/init/#when-the-sync-dir-is-nested-in-a-bigger-repo) prints
both files, filled in with your actual paths, when it scaffolds into a nested
directory.

**Keep both paths repo-relative.** `N8N_DECANTER_DIR` resolves against the
working directory, so `"flows"` survives a clone on someone else's machine while
an absolute path breaks for every teammate — and a root `.mcp.json` is normally
committed.

None of this changes where credentials come from: the guard reads `.env` /
`.decanter-auth.json` **from the sync dir it now finds**, and obtaining them
stays exclusively [init](/docs/cli/init/)'s job. What Option B does *not* carry
along is the rest of the scaffolded wiring — permission rules and hooks live in
the sync dir's `.claude/settings.json`, and hoisting that file's relative globs
verbatim silently stops protecting `<syncdir>/.env`. That half is covered in
[Working with coding agents](/docs/agents/overview/#where-the-agent-wiring-loads-from).

## What the guard logs

On stderr, so it never touches the protocol stream:

```
guard: ready — forwarding all n8n MCP tools to https://n8n.example.com, blocking jsCode writes in update_workflow
guard: forwarded search_workflows
guard: forwarded get_workflow_details
blocked a jsCode write (update_workflow) — pointed the agent at the file + push flow
```

- **The startup line means the guard is alive — not that n8n answered.** It is
  printed before any traffic, on purpose: without it, an empty log is ambiguous
  ("ran and blocked nothing" and "never started" look identical, and they are
  opposites). It says *ready*, never *connected*, because nothing has been
  contacted yet. If you see no startup line, the guard did not spawn; check the
  command in your `.mcp.json`.
- **One line per forwarded tool call** — every n8n MCP call an agent makes goes
  through the guard, so this is the one place that answers *what did the agent
  do to my instance?*
- **Tool names only, never arguments.** Arguments carry workflow content and
  pinned run data; keeping them out means the log is not a secret surface and is
  safe to attach to a bug report.

`mcp serve` logs the identical lines — the two transports share this, the same
way they share the guard rule itself.

Prefer `mcp connect` wherever the agent's MCP config can spawn a command.
For harnesses that only accept an MCP **URL**, use
[mcp serve](/docs/cli/mcp-serve/) — the same guard as a localhost HTTP proxy
with a per-session secret.
