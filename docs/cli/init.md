---
title: init
description: Bootstrap a sync dir — OAuth/token, starter template, config, agent tooling.
order: 2
---

```sh
n8n-decanter init [dir] [--force]
n8n-decanter init [dir] --host <url> [--token <mcp-token>] [--api-key <key>]   # non-interactive
```

Interactive setup for a new (or existing) sync dir:

- Prompts for the n8n host. If you leave off the scheme, local addresses
  (`localhost`, loopback, private LAN ranges, `*.local`) default to `http://`
  and everything else to `https://` — type the scheme yourself to override.
  Then connects via **OAuth**: your browser opens
  n8n's consent page, and the resulting refresh token lands in a gitignored
  `.decanter-auth.json` (rotated automatically on every refresh). No browser
  or piped run? Paste an **MCP token** instead (minted in n8n → Settings →
  MCP → API key; stored as `N8N_MCP_TOKEN` in `.env`).
- Offers the **optional public API key** (`N8N_API_KEY`) — only needed for
  [executions](/docs/cli/executions/), [data-tables](/docs/cli/data-tables/),
  and [backup](/docs/cli/backup/).
- When credentials already exist they are reused — edit or delete `.env` /
  `.decanter-auth.json` to change them. A best-effort connection check runs
  at the end (it also reports how many workflows are already
  "Available in MCP").
- Copies the starter template. Files named `X.example` in the template land
  as `X` in the target, and a copy-time baseline is recorded in
  `.decanter-template.json` (see [Re-running init](#re-running-init)).
- Scaffolds `decanter.config.json` and a `.gitignore` (which covers `.env`
  and `.decanter-auth.json`).
- Closes by pointing at **n8n's official skills pack** — see
  [The n8n skills pointer](#the-n8n-skills-pointer) below.

The instance needs MCP access enabled once (n8n → Settings → MCP; ~2.20+),
and each workflow you sync needs its "Available in MCP" flag — see
[configuration](/docs/concepts/configuration/).

## Non-interactive setup (`--host` / `--token` / `--api-key`)

Passing **any** of `--host`, `--token`, or `--api-key` runs `init`
non-interactively — values come from the flags plus any existing `.env`, and
**no prompt is ever issued** (so it drives cleanly from a script or a coding
agent, with no stdin dance):

```sh
n8n-decanter init --host http://localhost:5678 --token "$N8N_MCP_TOKEN"
n8n-decanter init ./flows --host n8n.example.com --token "$TOK" --api-key "$KEY"
```

- `--host <url>` — the n8n origin. Normalized like a typed host (a scheme-less
  local address gets `http://`, everything else `https://`; a scheme you write
  is kept). **Required** in this mode — omit it and `init` errors instead of
  prompting.
- `--token <mcp-token>` — the MCP bearer token (`N8N_MCP_TOKEN`), the same one
  the paste path uses. Omit it and `init` writes the rest and warns that sync
  won't work until credentials are set (there is **no** headless OAuth — the
  browser consent flow needs a terminal).
- `--api-key <key>` — the optional public API key (`N8N_API_KEY`). Omit it and
  it's simply skipped.

An explicit flag wins over an existing `.env` value; the end-of-init connection
checks run exactly as they do interactively. `--force` composes with all three.

## The n8n skills pointer

decanter owns Code-node source; **[n8n's official skills pack](/docs/agents/n8n-skills/)**
teaches your agent everything else. A **first** `init` closes by naming it and
printing the install commands for the agent it detects:

```text
Recommended: n8n's official skills pack (n8n-io/skills) — it teaches your agent to
build workflow structure over MCP while decanter keeps every Code node a file.
  Claude Code (detected)
    claude plugin marketplace add n8n-io/skills
    claude plugin install n8n-skills@n8n-io
    then /reload-plugins (or restart Claude Code)
  Codex
    codex plugin marketplace add n8n-io/skills
    codex plugin add n8n-skills@n8n-io
    then restart Codex and approve the plugin's hooks (needs Codex >= 0.142.0)
  other agents (skills.sh)
    npx skills add n8n-io/skills -y
    no plugin hooks on this route — the scaffolded AGENTS.md carries the routing cue it needs
  guide: /docs/agents/n8n-skills/
```

The `(detected)` marker comes from your environment (running inside an agent,
its binary on `PATH`, or a `~/.claude` / `~/.codex` marker) and only decides
which route is listed first — every route is always shown.

**`init` prints; it never installs.** Running `claude`/`codex`/`npx skills` for
you would mean decanter spawning three third-party CLIs with their own version
floors, mutating agent state that lives outside the sync dir, at the most
fragile moment of setup — and a plugin installed mid-session isn't active until
the agent reloads anyway, so the subprocess buys nothing the printed command
doesn't. It is printed **once**, on a first init (before
`.decanter-template.json` exists); every re-run stays quiet, so there is no
flag to turn it off. Piped and `--host`-driven runs get it too — an agent
bootstrapping a sync dir should learn the pack exists as much as a human does.

## TypeScript tooling

`init` also scaffolds what a sync dir needs to type-check and run nodes
locally: a `package.json` (with a `typecheck` script and the `typescript`
devDependency), `tsconfig.json`, and `n8n-globals.d.ts` with types for the
Code-node globals (`$input`, `$('…')`, `DateTime`, …).

Verification routes through the CLI, so `n8n-decanter` must be on the sync
dir's PATH: install it globally, add it to the sync dir's `devDependencies`,
or `npm link` a git checkout (build it first — Node won't type-strip `.mts`
under `node_modules`).

## Agent configs

The template includes an `AGENTS.md` contract for coding agents plus
per-agent configs (Claude Code, Cursor, Codex, opencode), including a hook
that runs `check` after node edits — see
[Agents](/docs/agents/overview/). The scaffolded MCP config (`.mcp.json` /
`opencode.json`) wires two servers out of the box: **`n8n-instance`** — your
instance's full MCP surface through the [mcp connect](/docs/cli/mcp-connect/)
guard (structure and lifecycle acts pass; Code-node `jsCode` writes are
blocked toward the file + push flow) — and **`n8n-docs`**, n8n's official
read-only docs MCP.

## Re-running init

`init` is safe to re-run — for example to pick up template improvements after
upgrading the CLI. It's **modification-aware** (like dpkg conffiles): at first
init it records the hash of every template file in a git-tracked
`.decanter-template.json` manifest, then compares that baseline against your
working copy and the current template on each re-run:

- **Files you haven't touched** whose template version changed → `init` lists
  them and offers to update (a single `y/N` confirm). Non-interactive runs
  report that updates are available and apply nothing — re-run interactively or
  use `--force`.
- **Files you've edited locally** → left untouched; reported as
  `left unchanged (modified locally): …`.
- **Files changed in both the template and your copy** → left untouched;
  flagged as a conflict to resolve manually (or `--force` to take the template
  version).
- **Files new to the template** → copied in.
- **Files the template *renamed*** → migrated, never silently doubled. Your
  copy is removed and re-scaffolded under the new name if you hadn't touched it;
  if you had, it is left exactly where it is and the new name is **not** written
  (two overlapping settings files would fire their hooks twice) — `init` tells
  you to move it, and picks up where you left off next run. A file `init` never
  wrote is always left alone. `--force` resolves a pending rename by removing
  the old file, per its "reset everything" contract.

  The one rename so far: **`.claude/settings.local.json` →
  `.claude/settings.json`** (it holds shared project policy, not per-machine
  preferences — see [Agents](/docs/agents/overview/)).

Commit `.decanter-template.json` — it's the shared baseline, so a teammate who
clones and re-inits sees the same drift picture. `.env` is never tracked in it.

## Flags

- `--force` — the escape hatch: overwrites **every** template file with its
  template version, including ones you edited (each such file is flagged
  `(had local changes)`), then re-records the baseline. `.env` is never touched.
