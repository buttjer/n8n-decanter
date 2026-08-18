---
title: init
description: Bootstrap a sync dir — OAuth/token, starter template, config, agent tooling.
order: 2
---

```sh
n8n-decanter init [dir] [--force]
n8n-decanter init [dir] --host <url> [--token <mcp-token>] [--api-key <key>]   # non-interactive
```

Interactive setup for a new (or existing) [sync dir](/docs/concepts/sync-layout/#the-sync-dir):

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

> **Run `init` — don't hand-write `.env`.** No browser (a headless box, a CI
> job, a coding agent)? That is *not* a reason to skip `init` and drop
> `N8N_HOST`/`N8N_MCP_TOKEN` into a file yourself: `init --host … --token …`
> takes exactly those two values as flags and needs no prompt, no TTY and no
> browser. A hand-written `.env` leaves the rest of the setup silently missing
> — no `decanter.config.json`, no starter template, no `.gitignore` (so `.env`
> is one `git add` away from being committed), no `AGENTS.md`/`.mcp.json` agent
> wiring, no `.decanter-template.json` baseline — and most verbs then fail with
> "decanter.config.json not found". Mint the token in n8n
> (Settings → MCP → API key), then hand it to `init`.

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
  the paste path uses. **`--mcp-token` is an accepted alias** for it. Omit it and
  `init` writes the rest and warns that sync won't work until credentials are set
  (there is **no** headless OAuth — the browser consent flow needs a terminal).
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
that runs `preflight --offline` after node edits — see
[Agents](/docs/agents/overview/). The scaffolded MCP config (`.mcp.json` /
`opencode.json`) wires two servers out of the box: **`n8n-instance`** — your
instance's full MCP surface through the [mcp connect](/docs/cli/mcp-connect/)
guard (structure and lifecycle acts pass; Code-node `jsCode` writes are
blocked toward the file + push flow) — and **`n8n-docs`**, n8n's official
read-only docs MCP.

## When the sync dir is nested in a bigger repo

Everything in that scaffold assumes the agent is started **in the sync dir** —
which is exactly what stops being true when the sync dir is a subfolder of a
bigger project. So when a directory *above* the sync dir looks like a project
root (it holds a `.git` or a `package.json`), `init` prints — **in place of** the
restart reminder, on the same trigger: the run that first scaffolds those agent
files — the two shapes that actually work. (In place of, because a restart is
not the fix here: the wiring would sit below whatever dir the agent is started
in, and startup discovery only ever walks *up*.)

- **Option A, the recommendation: start the agent in the sync dir**
  (`cd flows && claude`). Nothing needs configuring; the only thing you give up
  is the parent repo's own root `.claude/settings.json` (its `.mcp.json` still
  loads, since that one is found by walking up).
- **Option B: wire the repo root**, for setups where Option A isn't possible. A
  paste-ready `<repo-root>/.mcp.json` entry (plus its opencode equivalent)
  carrying `N8N_DECANTER_DIR` **and** a command that resolves from the root, and
  a `<repo-root>/.claude/settings.json` hooks block with each script path
  prefixed by the sync dir. Permission rules you hoist need that same prefix —
  above all `Read(<syncdir>/.env)` / `Edit(<syncdir>/.env)`, which stop
  protecting the credentials file if they are copied verbatim.

Only *strict* ancestors count, so the sync dir's own scaffolded `package.json`
— and a `git init` run inside it, the shape these docs teach — never make it
look nested.

`init` **prints** the note; it never writes into a parent directory. That
parent's `.mcp.json` usually carries other servers, and it is not guaranteed to
be the directory you start the agent in — neither is a merge decanter can make
on your behalf. A standalone sync dir sees none of this: with no project above
it, the note stays silent.

Why any of it is necessary — which file loads from where — is the matrix in
[Working with coding agents](/docs/agents/overview/#where-the-agent-wiring-loads-from);
the root MCP entry is spelled out in
[mcp connect](/docs/cli/mcp-connect/#when-your-sync-dir-is-not-your-project-root).

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

**Restart your agent after `init`.** Nothing `init` scaffolds for an agent
hot-loads: MCP servers (`.mcp.json` / `opencode.json` — including the guarded
`n8n-instance` server), permission rules (`.claude/settings.json`), and session
hooks are all read at **agent startup**. Since `init` is normally run *from
inside* the session it configures, that session keeps running unconfigured — it
cannot see the `n8n-instance` MCP tools, and the deny rules that keep it off
`.decanter.json`, `.env` and `push --force` are inert. Restart the agent (or
`/reload`) before working in the sync dir; `init` says so when it first writes
those files. Until then the scaffolded `AGENTS.md` is the only thing holding the
line, and it asks rather than blocks.

**A restart is the fix only when the sync dir is where you start the agent.**
Missing `n8n-instance` tools have a second cause with the opposite answer: the
sync dir is [nested](#when-the-sync-dir-is-nested-in-a-bigger-repo) and the
agent was started at the repo root, so the `.mcp.json` `init` wrote sits *below*
the launch dir — where startup never looks. Restarting reruns the same discovery
and finds nothing again. Tell the two apart by asking whether the `.mcp.json` is
below the directory the agent was started in; if it is, the fix is Option A or B
above, not a restart. `init` knows which case you are in when it scaffolds and
says so, printing the nested options in place of the plain restart line.

## Flags

- `--force` — the escape hatch: overwrites **every** template file with its
  template version, including ones you edited (each such file is flagged
  `(had local changes)`), then re-records the baseline. `.env` is never touched.

The global `--dir` / `N8N_DECANTER_DIR`
([configuration](/docs/concepts/configuration/#pointing-at-a-nested-sync-dir))
is the one flag `init` does **not** take: it points the config search at an
*existing* sync dir, while `init` creates one and takes its target as the
positional `[dir]`. `init --dir flows` is refused rather than silently
scaffolding the working directory.
