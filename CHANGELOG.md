# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The compliance guard (`check`, the push gate, watch) now also enforces
  structural integrity: dangling connection sources/targets, duplicate node
  names or ids, orphan `.js`/`.ts` files no `//@file:` placeholder references
  (`.d.ts`, `.remote.js`, and subdirs other than `code/` are exempt), and
  dangling literal `$('…')` references in node source files and expression
  parameters are all errors now. These checks may flag pre-existing issues
  in already-pulled workflows — that's the point; fix them or the push stays
  blocked (`--force` does not bypass the guard).
- **Breaking:** node sources now live in a `code/` subdir inside each
  workflow folder, named in kebab-case after their node (`Parse Order` →
  `code/parse-order.js`). `//@file:` placeholders and `.decanter.json`
  entries carry the `code/` prefix, `.remote.js` conflict artifacts land in
  `code/` too, and `check`/`push` reject node files outside it. Existing
  folders migrate automatically on the next `pull` (files are renamed in
  place).
- `check <id …>` with explicit workflow ids now scopes the typecheck too:
  only diagnostics from the given workflows' folders are reported and
  counted (the whole project still compiles, so cross-file types keep
  working). Bare `check` stays project-wide.
- Template: the PostToolUse verify hook scopes its check to the edited
  workflow (it reads the workflow id from the sibling `.decanter.json`), so
  errors in unrelated workflows no longer block an edit.
- Template: node files are typechecked as separate module scopes
  (`moduleDetection: "force"` in `tsconfig.json`) — same-named top-level
  declarations in different node files no longer raise false "cannot
  redeclare" errors.
- **Breaking:** requires Node >= 22.18 (was >= 18.17). The CLI is now
  written in TypeScript and executed natively via Node's type stripping —
  no build step. The entry point is `n8n-decanter.mts` (invoke as
  `node n8n-decanter.mts …`); the installed `n8n-decanter` bin name is
  unchanged.
- Template: the Claude Code permission examples
  (`.claude/settings.local.json`) now reference the `n8n-decanter.mts`
  entry point.

### Added

- Browser live-reload for `watch` (opt-in). Set `"browserReload": "proxy"` in
  `decanter.config.json` and `watch` boots a transparent reverse proxy on
  `127.0.0.1:5679` (override with `"proxyPort"`) that forwards everything to
  your n8n host — auth, assets, and n8n's native `/rest/push` WebSocket — while
  injecting a small live-reload client into the editor HTML. Open the editor
  through the proxy URL; each successful single-node push then refreshes the
  tab automatically, **unless the editor has unsaved changes** — then it logs a
  console warning and leaves your in-browser work untouched. If the port can't
  be bound, `watch` warns and keeps syncing without live reload. Works cleanly
  against a local http n8n; https/remote upstreams are best-effort (Secure
  cookies don't survive the plain-http hop). Default off.
- `rename` verb: `n8n-decanter rename <id> "<old node>" "<new node>"` renames
  a node atomically everywhere the old name is load-bearing — `node.name`,
  connection keys and targets, literal `$('…')` references in every node
  source file and expression parameter, the kebab-case source filename (plus
  its `.remote.js` sibling), the `//@file:` placeholder, and the
  `.decanter.json` entry. Refuses names that already exist; validates the
  result and fails loudly if anything is left dangling. Offline — `push`
  propagates. `rename <id> --workflow "<new name>"` renames the workflow
  itself (the folder follows on the next pull).
- Id-first argument order: `n8n-decanter.mts wf123 push` ==
  `n8n-decanter.mts push wf123` — the first token matching a known verb is
  taken as the command; everything else, including flags, may appear in any
  position. The CLI help and README document id-first as the canonical form.
- Template: the `n8n-globals.d.ts` stub declares Luxon `Duration` and
  `Interval` (pragmatic subsets, matching the existing `DateTime` stub) —
  both were already advertised in `AGENTS.md` and provided at runtime, only
  the type stubs were missing. The AGENTS notes now also call out the
  editor-only TS1108 top-level-`return` squiggle as a false positive.
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
