---
title: init
description: Interactive bootstrap — credentials, starter template, config, agent tooling.
order: 2
---

```sh
n8n-decanter init [dir] [--force]
```

Interactive setup for a new (or existing) sync dir:

- Prompts for the n8n host and API key and writes them to `.env`. When `.env`
  already holds both values, the prompts are skipped and the values reused —
  edit or delete `.env` to change credentials. A best-effort credential check
  runs at the end.
- Copies the starter template. Files named `X.example` in the template land
  as `X` in the target.
- Scaffolds `decanter.config.json` and a `.gitignore`.

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
[Agents](/docs/agents/overview/).

## Flags

- `--force` — re-copies template files over existing ones. `.env` is never
  touched by it. Without the flag, existing files are never overwritten
  (re-running `init` is safe).
