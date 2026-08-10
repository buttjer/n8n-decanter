---
title: Installation
description: Install n8n-decanter globally, from a git checkout, or as a devDependency.
order: 1
---

Requires **Node >= 22.18** — the CLI is TypeScript (`.mts`), executed natively
via Node's type stripping; there is no build step for development.

```sh
npm install -g n8n-decanter
```

Alternatives:

- **From a git checkout:** `npm link` (run `npm run build` once first — the
  installed bin is the compiled `dist/`), or invoke `node n8n-decanter.mts …`
  directly, no build needed.
- **Per [sync dir](/docs/concepts/sync-layout/#the-sync-dir):** add `n8n-decanter` to the sync dir's `devDependencies`
  instead of installing globally. A local install lands in
  `node_modules/.bin`, **not** on your `PATH`, so invoke it as
  **`npx n8n-decanter <verb>`** (or via an `npm run` script — npm puts
  `node_modules/.bin` on `PATH` itself). A bare `n8n-decanter <verb>` is the
  one form that won't resolve. `npx n8n-decanter …` works under a global
  install too, so it is the safe form to use in scripts and docs shared across
  a team. The agent config `init` scaffolds allows **both** forms, and the
  MCP guard it wires up uses `npx --no-install` for exactly this reason.

## Old Node fails with a `SyntaxError`

On Node older than 22.18 the CLI fails at startup with a confusing
`SyntaxError` rather than a clean version message: npm's `engines` field only
*warns* at install time (unless you set `engine-strict`). If you see a syntax
error pointing into a `.mts` file, check `node --version` first.

Next: [Quickstart](/docs/getting-started/quickstart/) — set up a sync dir and
pull your first workflow.
