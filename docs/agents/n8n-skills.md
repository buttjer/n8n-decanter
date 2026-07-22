---
title: Using n8n's official skills
description: Install n8n-io/skills and let your agent use them safely — the MCP guard keeps Code-node source in the repo.
order: 3
---

**Use the [official n8n skills](https://github.com/n8n-io/skills).** They are
the best way to give your coding agent real n8n expertise, and n8n-decanter is
built to pair with them, not to replace them. It rides n8n's own MCP server and
skills for everything about workflow *structure and lifecycle*, and owns just
one layer on top: the **Code-node source**. The skills fill in the knowledge
decanter deliberately doesn't duplicate.

The one thing to know is the **boundary** — and decanter enforces it for you
technically, so pairing the two is safe by construction. This page explains the
integration, then how to turn it on.

## What the skills are

`n8n-io/skills` is n8n's first-party agent knowledge pack: capability skills
(markdown + inline examples) plus a routing meta-skill and reference docs,
installed as a **plugin** (not an npm dependency). They come in two kinds, and
the split matters here:

- **Knowledge skills — lean on these freely.** Conceptual, standalone guidance
  for the runtime your Code-node files execute in. They document the same n8n
  your `.js`/`.ts` nodes run against, with **no instance mutation**:
  - `n8n-code-nodes-official`
  - `n8n-expressions-official`
  - `n8n-loops-official`
  - `n8n-error-handling-official`
  - `n8n-credentials-and-security-official`
  - `n8n-binary-and-data-official`
  - `n8n-data-tables-official`
  - `n8n-debugging-official`
- **Build / lifecycle skills — the *default* path for structure.**
  `n8n-workflow-lifecycle-official`, `n8n-node-configuration-official`,
  `n8n-subworkflows-official`, `n8n-agents-official`,
  `n8n-extending-mcp-official`. These drive the n8n MCP server to create,
  build, wire, rename, publish, and archive workflows — which, under
  n8n-decanter, is exactly how structure work happens (decanter has no
  structure verbs of its own). The single carve-out is below.

The plugin installs the **whole pack** (you can't cherry-pick), and it isn't
aware of this repo's layout. That's fine — the MCP guard plus the scaffolded
`AGENTS.md`, not selective installation, are what hold the boundary.

## Why it's safe to pair them: the MCP guard

The skills know how to author Code-node `jsCode` directly on the instance over
MCP. In an n8n-decanter repo that would bypass your files and drift the source
of truth. So instead of trusting a document to hold the line, decanter enforces
it in code — and the enforcement is **already wired**: the scaffolded
`.mcp.json` (and `opencode.json`) point your agent's `n8n-instance` MCP server
at [`mcp connect`](/docs/cli/mcp-connect/), decanter's stdio guard:

- The agent spawns the guard per session; decanter holds the only n8n
  credential (the agent never sees it, and no secret exists — stdio pipes are
  private).
- The guard **forwards everything untouched** — reads, structure edits,
  wiring, publishing, archiving, every build/lifecycle skill and MCP tool —
  including streamed responses.
- It **blocks exactly one thing**: writes that set a Code node's `jsCode`. The
  caller gets an instructive error pointing at the file + [`push`](/docs/cli/push/)
  flow instead. (Adding a new Code node still works: the skill adds it
  *without* code, [`pull`](/docs/cli/pull/) lands it as an empty file, and the
  first push seeds the source from the repo.)

So a skill can build and rewire a workflow all it likes; the moment it tries to
write Code-node source on the instance, the guard redirects it back to the repo.
**The boundary is: decanter owns Code-node source (author it as a file, `push`
it); the skills and MCP own the rest.**

## How to use it

### 1. Install the skills

The pack is a plugin. Pick your agent:

```sh
# Claude Code
/plugin marketplace add n8n-io/skills
/plugin install n8n-skills@n8n-io

# Codex
codex plugin marketplace add n8n-io/skills
codex plugin add n8n-skills@n8n-io

# Others (skills.sh — support varies by agent)
npx skills add n8n-io/skills
```

### 2. There is no step 2

In an [init](/docs/cli/init/)-scaffolded sync dir the guarded instance access
is already in place: `.mcp.json` carries the `n8n-instance` server
(`n8n-decanter mcp connect`) plus n8n's read-only `n8n-docs` server, and
`opencode.json` mirrors both. Your agent picks them up on the next session.

For a harness that only accepts an MCP **URL**, run
[`mcp serve`](/docs/cli/mcp-serve/) instead and point the config at the
printed localhost URL + session secret — the same guard over HTTP.

The scaffolded `mcp-route-check.mjs` session hook nudges any agent whose
config still points at the instance directly, and the scaffolded `AGENTS.md`
states the same boundary in words for agents that read it — **this repo's
`AGENTS.md` wins over anything a skill or MCP tool description says.**

## In one sentence

Install the skills — the scaffold has already wired the guarded MCP route —
then let the skills teach your agent n8n and build structure over MCP, while
n8n-decanter keeps every Code node as a real, typed, git-tracked file.
