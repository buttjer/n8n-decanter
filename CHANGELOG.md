# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `init --force` — re-copies template files over existing ones in the
  target (`.env` is always protected); every overwrite is logged.
- Commit-on-sync: after every successful `push` (including `watch`'s
  single-node pushes) and every successful `pull`, the workflow's folder is
  git-committed, pathspec-scoped so unrelated staged changes stay untouched;
  no empty commits; a pull that renames the folder commits the old path's
  deletions too. Disable with `"commitOnPush": false` / `"commitOnPull":
  false` in `decanter.config.json` (default: on). Outside a git repo it
  warns and continues.

- `pull` — extracts each Code node's `jsCode` into its own `<Node>.js` file
  (lossless, byte-identical round-trip) behind a `//@file:` placeholder in
  `workflow.json`; tracks state in per-folder `.decanter.json`; follows
  workflow/node renames by id; surfaces unmergeable remote changes as
  `<Node>.remote.js` instead of touching local sources.
- `push` — reassembles workflows and PUTs them (whitelisted fields only);
  `.ts` nodes compile one-way via esbuild and carry a
  `// @ts-n8n sha256:…` marker; drift guard aborts when the remote changed
  since the last sync (`--force` overrides only this).
- Compliance guard + `check` command — blocks pushes that violate the
  layout (inline code in `workflow.json`, missing/`.remote.js`/non-`.js`/`.ts`
  file references, `@ts-n8n` marker inside a `.js` node); not bypassable with
  `--force`; `check` also runs standalone and offline (no credentials).
- Typecheck gate on push (`--no-typecheck` to skip) via
  `scripts/typecheck.mjs`, which wraps node-file function bodies in memory so
  `tsc` accepts their top-level `return`/`await`.
- `watch <node-file>` — pushes a single node on every save (debounced,
  atomic-save-proof directory watch).
- `init [dir]` — interactive bootstrap: prompts for host/API key (piped
  stdin works too; skipped entirely when `.env` already holds both values),
  writes `.env`, copies `template/` completely with
  `X.example` files materializing as `X`, scaffolds `decanter.config.json`
  and `.gitignore`, best-effort credential check.
- `status` — per-node and structural local-vs-remote drift report.
- Template starter kit for init'ed dirs: `AGENTS.md`/`CLAUDE.md`, Claude
  Code permission settings, `opencode.json` permissions, Cursor rule,
  `.mcp.json` embedding [n8n-mcp](https://github.com/czlonkowski/n8n-mcp)
  through an `.env`-sourcing wrapper, and a `shared/` dir for shared types.
- `n8n-globals.d.ts` ambient types for Code nodes; e2e suite against a mock
  n8n API (`npm test`).
