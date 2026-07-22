---
title: Using n8n's official skills
description: Install n8n-io/skills and let your agent use them safely — the guard-proxy keeps Code-node source in the repo.
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
- **Build / lifecycle skills — fine for *structure*.** `n8n-workflow-lifecycle-official`,
  `n8n-node-configuration-official`, `n8n-subworkflows-official`,
  `n8n-agents-official`, `n8n-extending-mcp-official`. These drive the n8n MCP
  server to build and wire workflows — which, under n8n-decanter, is n8n's job
  and entirely welcome. The single carve-out is below.

The plugin installs the **whole pack** (you can't cherry-pick), and it isn't
aware of this repo's layout. That's fine — the guard-proxy plus the scaffolded
`AGENTS.md`, not selective installation, are what hold the boundary.

## Why it's safe to pair them: the guard-proxy

The skills know how to author Code-node `jsCode` directly on the instance over
MCP. In an n8n-decanter repo that would bypass your files and drift the source
of truth. So instead of trusting a document to hold the line, decanter enforces
it in code with the [`mcp serve`](/docs/cli/mcp-serve/) **guard-proxy**:

- Your agent's MCP config points at a **localhost proxy**, not your instance.
  decanter holds the only n8n credential; the agent never sees it.
- The proxy **forwards everything untouched** — reads, structure edits, wiring,
  publishing, every build/lifecycle skill and MCP tool — including streamed
  responses.
- It **blocks exactly one thing**: writes that set a Code node's `jsCode`. The
  caller gets an instructive error pointing at the file + [`push`](/docs/cli/push/)
  flow instead.

So a skill can build and rewire a workflow all it likes; the moment it tries to
write Code-node source on the instance, the proxy redirects it back to the repo.
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

### 2. Run the guard-proxy

From your sync dir:

```sh
n8n-decanter mcp serve
```

It prints a localhost URL and a **session secret** (also written to a
gitignored `.decanter-proxy.json`), and keeps running.

### 3. Point your agent's MCP config at the proxy

Use the printed URL and secret — never your instance directly:

```json
{
  "mcpServers": {
    "n8n-instance": {
      "type": "http",
      "url": "http://127.0.0.1:5680/mcp-server/http",
      "headers": { "Authorization": "Bearer <printed secret>" }
    }
  }
}
```

That's it. Your agent now has the full n8n MCP surface *and* the official skills,
with Code-node source safely fenced into the repo. The scaffolded
`mcp-route-check.mjs` session hook nudges any agent whose config still points at
the instance directly, and the scaffolded `AGENTS.md` states the same boundary
in words for agents that read it — **this repo's `AGENTS.md` wins over anything a
skill or MCP tool description says.**

## In one sentence

Install the skills, run `mcp serve`, point the agent at the proxy — then let the
skills teach your agent n8n and build structure over MCP, while n8n-decanter
keeps every Code node as a real, typed, git-tracked file.
