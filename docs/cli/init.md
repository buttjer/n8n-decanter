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
  as `X` in the target, and a copy-time baseline is recorded in
  `.decanter-template.json` (see [Re-running init](#re-running-init)).
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

Commit `.decanter-template.json` — it's the shared baseline, so a teammate who
clones and re-inits sees the same drift picture. `.env` is never tracked in it.

## Flags

- `--force` — the escape hatch: overwrites **every** template file with its
  template version, including ones you edited (each such file is flagged
  `(had local changes)`), then re-records the baseline. `.env` is never touched.
