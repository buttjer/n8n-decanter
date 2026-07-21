# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`$('Node').item` in the type shim (`n8n-globals.d.ts`) is no longer typed
  `| undefined`.** Accessing `$('Node').item.json` no longer raises a spurious
  "Object is possibly 'undefined'" (TS2532) — the value is non-undefined, like
  `$input.item`, since a missing paired item throws at runtime rather than
  yielding `undefined`. Use `itemMatching(i)`, `first()`, or `last()` when you
  want an index-checked lookup instead.

## [0.4.2] - 2026-07-20

### Added

- **`simulate` verb** — `n8n-decanter <ref> simulate --execution <id>` replays
  a whole workflow through a **real n8n engine** (Docker) using a captured
  execution as the mock: side-effect-free nodes (Set, IF, Code, …) execute for
  real, every network/side-effectful node is pinned to its captured output,
  credentials are stripped, and no outbound-capable node survives — a dry,
  engine-true regression check. It diffs each executed node's output against the
  capture and **exits `1` on divergence** (CI-gateable). `--network-none` adds
  an enforced outbound cutoff; `--json` emits the report for tooling.
- **`simulate --pin <id>`** — copy a capture's network-node outputs into
  committed, provenance-stamped `workflows/<Name>/fixtures/<node>.json`, making
  replays reproducible and committable (prints a PII-review warning).
- **`n8nVersion` config field** (`decanter.config.json`) — pins the n8n version
  the `simulate` engine runs, so "engine-true" matches your instance;
  `--n8n-version <tag>` overrides it per run. Defaults to the project's pinned
  version with a hint when unset.
- **`npm run test:sim`** — opt-in engine simulation suite (needs Docker; never
  part of `npm test`); skips cleanly when no Docker daemon is available.

## [0.4.1] - 2026-07-20

### Changed

- **Refreshed the scaffolded agent guide (`AGENTS.md`).** It now steers agents
  to the `rename` and `duplicate` verbs (rename led with the command instead of
  a hand-edit checklist, `duplicate` added to the new-workflow and command
  taxonomies), opens with a compact "short version" of the hard invariants,
  points at `n8n-globals.d.ts` as the authoritative globals list instead of an
  inline copy that could drift, and drops a stale reference to a non-existent
  `SCAFFOLD.md`.

## [0.4.0] - 2026-07-20

### Added

- **`add` verb** — `n8n-decanter <ref> add "<Node name>" [--ts]` scaffolds a
  Code node into a pulled workflow in one offline step: it mints the node id,
  writes the `code/` source file (kebab-case, with the `-<id8>` collision
  suffix), adds the node object plus its `//@file:` placeholder, and registers
  it in `.decanter.json`, then re-checks the folder. The node lands
  **disconnected** (wire it in the editor); `--ts` scaffolds a `.ts` source.
  The next `push` propagates it.
- **`duplicate` verb** — `n8n-decanter <ref> duplicate ["<new name>"]` clones an
  already-pulled workflow into a **new workflow on the server** and pulls the
  copy. The clone carries the repo's current content (placeholders
  reconstituted from `code/`, `.ts` nodes compiled), is born **unpublished**,
  and defaults its name to `"<name> (copy)"`. The source folder and the source
  remote workflow are left untouched.

### Removed

- **Breaking: the `uuid` verb is gone.** Its only job was minting a node id for
  hand-adding a Code node — now `add` does the whole scaffold (id included) in
  one guard-checked step, so a bare id generator is redundant. Use
  `n8n-decanter <ref> add "<Node name>"` instead.

## [0.3.4] - 2026-07-20

### Added

- **Modification-aware template refresh.** `init` now records a copy-time
  baseline of every template file in a git-tracked `.decanter-template.json`
  manifest. Re-running `init` uses it to refresh files you haven't touched
  (after a confirm), pull in files newly added to the template, and **leave
  your local edits alone** — reporting them as drift instead of silently
  keeping the old version. Files that changed in both the template and your
  copy are flagged as conflicts and left untouched.

### Changed

- **Re-running `init` is no longer all-or-nothing.** Previously the default
  refused to overwrite anything and `--force` clobbered every template file.
  Now the default is modification-aware (see above); `--force` is unchanged —
  the escape hatch that overwrites everything, now noting which files "had
  local changes" as it goes.

## [0.3.3] - 2026-07-20

### Changed

- **Interactive picker got a visual refresh.** Each workflow row now leads with
  a `●` (pulled) / `○` (not pulled) status glyph and the ids line up in an
  aligned column; each stage carries a short title (`pick a workflow` over the
  list, the workflow name over its verb menu). The state distinction is now
  carried by the glyph *shape*, so the per-row `(not pulled)` words are gone —
  the key is stated once in a footer legend (`● pulled · ○ not pulled`), and
  the output stays legible under `NO_COLOR`. Behavior (filtering, navigation,
  verbs) is unchanged.

## [0.3.2] - 2026-07-20

### Fixed

- **Globally-installed CLI (`npm i -g n8n-decanter`) could crash on
  `push`/`check`/`watch`'s typecheck gate** — it resolved the `typescript`
  package relative to its own install location instead of the sync dir
  being checked, which only ever worked when the CLI happened to be nested
  inside the sync dir's `node_modules` (e.g. a local `devDependency`
  install). A global install is never nested there, so the gate could fail
  to find `typescript` at all. Now resolved relative to the sync dir first,
  falling back to the CLI's own location.

## [0.3.1] - 2026-07-20

### Added

- **`publish` / `unpublish` verbs** close the n8n 2.x workflow lifecycle from
  the CLI: `n8n-decanter <ref> publish` takes a draft live, `unpublish` returns
  it to draft-only. Already-in-that-state is a no-op with a note, not an error.
  A staged rollout is now `unpublish` → `push` → `publish` without leaving the
  terminal.
- **`create` verb** — `n8n-decanter create "<name>"` creates a blank workflow
  on the server (born unpublished) and immediately pulls it, so the folder and
  the new id are ready to edit → push → `publish`.
- **`delete` verb** — `n8n-decanter <ref> delete` removes a workflow from the
  server. It asks for a `y/N` confirmation naming the workflow; non-interactive
  runs require `--force`. The **local folder is left untouched** as the
  git-tracked record, and a stale `decanter.config.json` `workflows` entry is
  flagged. Requires a ref (never deletes config workflows by default), one at a
  time.

### Changed

- **`status` is version-aware.** On a published workflow whose draft has moved
  ahead of the live version (a UI edit not yet published), `status` now says
  the live version is older than the draft (`push` or `publish` to catch it
  up) instead of the plain `published` note.
- **`executions` warns on stale fixtures.** When a fetched execution ran a
  published version different from your local draft, the fetch now warns that
  the captured data may not match the code you're editing (still written — a
  warning, not an error).
- The recommended **scoped API key** now includes `workflow:create`,
  `workflow:delete`, `workflow:activate`, and `workflow:deactivate` so the new
  lifecycle verbs work (`README`, `.env.example`).

## [0.3.0] - 2026-07-20

### Security

- **Breaking:** `run`'s `$env` no longer exposes the CLI process environment
  by default. Previously a node that read or printed `$env` during `run`
  received every exported variable of the CLI process — including
  `N8N_API_KEY` and any other secret — straight into the JSON on stdout;
  n8n's real `$env` is scoped, this was not. Now `$env` is **empty** unless
  the fixture supplies an `"env"` object (which still wins), and the new
  **`--allow-env`** flag opts back into the old full-inherit behavior for the
  cases that need it (`n8n-decanter <node> run [fixture.json] --allow-env`).

### Added

- The interactive picker's per-workflow verb menu now includes
  **`executions`** (status/pull/push/watch/check/executions), so fetching a
  workflow's real run data no longer requires dropping to the CLI.

## [0.2.4] - 2026-07-20

### Added

- `.env.example` and the README now recommend a **scoped** n8n API key —
  limited to the scopes the CLI uses (`workflow:read`/`list`/`update`,
  `execution:read`/`list`) — instead of a full-access key, so a leaked `.env`
  has a smaller blast radius.

## [0.2.3] - 2026-07-20

### Changed

- **The picker is now a session** — after a verb finishes (or fails: the
  error is logged and you're back in the menu), the picker returns to the
  same workflow's verb menu with the cursor on the verb you just ran, so
  `status` → `pull` needs no re-picking. `Esc` steps back to the workflow
  list (freshly re-scanned, so a just-pulled workflow shows green), `Esc`
  there quits; the exit code reflects the last verb run. The remote
  workflow list is fetched once per session.

### Added

- While the remote workflow list loads, the picker shows light-gray `░`
  placeholder rows of varied widths where the entries will appear, instead
  of a "loading" line.
- The picker opens with the n8n-decanter logo banner (same as `init`).

## [0.2.2] - 2026-07-20

### Added

- **Interactive workflow picker** — running bare `n8n-decanter` (no verb, no
  arguments) in an inited project on a terminal now opens a picker instead of
  printing usage: type to filter, `↑`/`↓` to move, pulled workflows shown
  green, not-yet-pulled remote ones yellow with a `(not pulled)` marker
  (appended live once the server list loads; skipped without credentials).
  `Enter` on a pulled workflow offers status/pull/push/watch/check (`↑↓` +
  `Enter`, or a letter to cycle matching verbs); `Enter` on an unpulled
  workflow pulls it directly. `Esc` quits, `Ctrl-C` interrupts (exit 130).
  The chosen verb behaves exactly like typing the command. Piped output and
  directories without a `decanter.config.json` keep printing usage — scripts
  and LLM harnesses never see the picker. The `completion zsh|bash` verb
  stays: shell tab completion and the picker cover different moments.

## [0.2.1] - 2026-07-19

### Added

- **`executions` verb** — fetches recent execution data (full run JSON,
  newest first) for a workflow into
  `workflows/<Name>/executions/<execId>.json`:
  `n8n-decanter <ref> executions [--status=success|error|waiting]
  [--limit=N]` (default 5, API cap 250; both `--limit=N` and `--limit N`
  work). A numeric argument fetches that single execution by id and routes
  it to its workflow's folder. Read-only against the API. The files show the
  real items each node produced
  (`data.resultData.runData["<Node>"][0].data.main[0][]`) — temporary
  reference data for writing accurate `run` fixtures. Executions run the
  *published* workflow version (n8n 2.x), so they're convenience data, not
  ground truth.
- **`executions clean`** — offline; deletes fetched `executions/` dirs for
  the given workflow refs, or all pulled workflows without one.
- Execution data never reaches git: the verb writes each `executions/` dir
  self-ignoring (a `.gitignore` containing `*` — run data can hold
  credentials/PII), and `init`'s scaffolded root `.gitignore` now also
  lists `workflows/*/executions/`.
- Template `AGENTS.md`: new "Real execution data" section — when to fetch
  executions, where items live in the JSON, copy real shapes into `run`
  fixtures, never commit the data, clean up afterwards.

## [0.2.0] - 2026-07-19

### Added

- The template now ships **`decanter-ts-plugin/`**, a TypeScript
  language-service plugin that stops the editor from flagging legal n8n node
  source — top-level `return`/`await` — with false TS1108/TS1375/TS1378
  errors, while every other diagnostic (and every non-node file) stays live.
  Wired via the sync dir's `tsconfig.json` `plugins` entry and a
  `file:./decanter-ts-plugin` devDependency; `.vscode/settings.json` (new)
  points VS Code at the workspace TypeScript so tsserver can load it — run
  `npm install` and accept *Use Workspace Version* once (JetBrains IDEs use
  the project TypeScript by default). `n8n-decanter check` is unaffected and
  stays authoritative.
- **Workflow-name arguments**: `pull`/`push`/`status`/`check`/`rename`/`watch`
  now take a workflow's name (or a unique name prefix) wherever they took an
  id — `n8n-decanter "Order Sync" push`. Matching is case-insensitive and
  never prompts: ambiguous or unknown names error with the candidate list.
  `pull` also resolves names of not-yet-pulled workflows against the server's
  workflow list. A workflow literally named like a verb must be addressed by
  id (the verb wins argument detection).
- `list` verb — one line per pulled workflow (name, id, folder), offline;
  `list --remote` additionally shows remote workflows not pulled yet. The
  discovery surface for what a ref can address.
- `completion zsh|bash` prints a shell tab-completion script (append to your
  rc file) covering verbs, flags, and local workflow names/ids, backed by a
  hidden credentials-free `__complete` verb.
- Progress indication: multi-workflow `pull`/`push`/`status` prefix each line
  with a `[2/5]` counter, pull/push result lines get a `(0.4s)` duration
  suffix, and on a terminal a transient `pulling <id>…` line shows while the
  network call runs (piped output only ever gets the result lines).
- `init` greets with a small ASCII logo + version on a terminal; piped runs
  print a plain `n8n-decanter v<version>` line instead.
- `watch` prints a deep link straight to the watched workflow's editor page —
  through the live-reload proxy when it is running, the configured n8n host
  otherwise — as a clickable OSC 8 hyperlink on supporting terminals.
- n8n API requests now **time out after 30 seconds** instead of hanging the
  CLI forever on an unresponsive instance; raise `"requestTimeoutMs"` in
  `decanter.config.json` for slow instances. `init`'s best-effort credential
  probe gives up after 10 seconds.
- `DEBUG=1` prints the full stack trace when a command fails — the default
  stays the one-line error message.
- `run` now provides **`$getWorkflowStaticData('global' | 'node')`**, seeded
  from `workflow.json`'s `staticData` (the `global` and the node's own
  `node:` slice) — previously any node using it died with a ReferenceError.
  A fixture `staticData` field (`{ "global": …, "node": … }`) replaces the
  matching slice; mutations are visible during the run but never persisted
  (`run` stays offline). The template's fixture docs cover the new field.
- **`status --diff`** — prints a unified line diff (`--- remote (n8n)` vs
  `+++ local`) under every drifted node: what a push would change, what a
  pull would bring, or both sides of a CONFLICT. `.ts` nodes diff their
  compiled JS — exactly what the sync hashes compare. In-sync nodes print
  nothing extra.
- **`.ts` nodes can import now** — shared code from inside the sync dir and
  opted-in npm packages — and push **bundles the imports into the compiled
  node**: the pushed code is self-contained and runs on any instance,
  n8n Cloud included, with no server-side module configuration. Put helpers
  and types in `shared/*.ts` and import them relatively (types *and*
  values); npm packages bundle after a normal install in the sync dir plus a
  `"bundleDependencies": ["zod", …]` opt-in in `decanter.config.json`
  (pure-JS packages only). Rules, enforced by `check` and the compiler:
  imports at the top of the file, relative imports stay inside the sync dir,
  Node builtins and unlisted packages are errors. Nodes without imports
  compile byte-identically to before — no drift noise on upgrade.
  Previously *any* import — even `import type` — failed the push compile
  outright ("Top-level return cannot be used inside an ECMAScript module").
  Editing a shared file marks every importing node push-pending in `status`
  (`--diff` shows the inlined change); pushing propagates it. Oversized
  compiles (> 100 KB) warn. The template ships `shared/example-helpers.ts`
  and updated agent guidance.

### Changed

- `workflow.json` stays lean on n8n 2.x: `pull` now keeps the file to the
  workflow itself — the server-side copy of the published version
  (`activeVersion`, which duplicates every node's code) and sharing metadata
  (`shared`) are left out. Your code exists exactly once (in `code/`), and
  git diffs show your edits instead of publish churn. Nothing is lost:
  neither field can be pushed anyway.
- **Breaking:** `status` now exits **1 when a pull is needed or a push would
  clobber remote work** — on a CONFLICT, remote-only changes (structure or
  node code), remote code nodes unknown locally, remotely deleted nodes, or a
  workflow not pulled yet. Local-only "push pending" edits still exit 0.
  Scripts that relied on `status` always exiting 0 must check output instead.

- CLI output is styled — color, `✓`/`!`/`✗` glyphs, bold names, dim
  metadata — **only when the stream is a terminal**, honoring `NO_COLOR` and
  `FORCE_COLOR`; piped/redirected output stays plain line-oriented text (no
  information is carried by color alone). Error lines now start with `✗ `
  (was `x `), success lines with `✓ `.

### Fixed

- ANSI escape codes no longer leak into piped output — previously the two
  hardcoded warn/error colors were emitted unconditionally, polluting logs,
  scripts, and LLM harness transcripts.
- `init` from the npm-installed package no longer fails to find `template/`:
  it resolved the directory relative to the compiled `dist/lib/`, a location
  that exists in a git checkout but not in the published tarball. The
  template (and the version banner) now resolve via the nearest
  `package.json`, which works in both layouts.
- The compliance guard now rejects a `.js` node containing an `import` —
  `.js` nodes are pushed verbatim, so the import would reach n8n unbundled
  and fail at runtime; the error points to `.ts` (where imports are bundled)
  or inlining.

## [0.1.0] - 2026-07-18

First public release.

### Added

- Push, watch, and `status` now report the workflow's **publication state**
  (n8n 2.x draft/publish model): push result lines end in
  `— published: code is live now` or `— unpublished: draft only`, `watch`
  warns at start when the workflow is published (n8n auto-publishes every
  API update to a published workflow — there is no draft-only push), and
  `status` shows `published`/`unpublished` in its header line. Servers that
  don't report an `active` flag are unaffected.
- `watch` now also watches **`workflow.json`** and pushes structural edits
  (connections, node settings, …) on save — the IDE becomes a peer editor of
  the n8n UI. A save only pushes cleanly when the remote structure is
  unchanged since the last sync; if both sides changed, an interactive
  prompt offers **[m]erge** (writes a diff-friendly `workflow.remote.json`
  to reconcile manually), **[l]ocal** (force-push over the remote changes),
  **[r]emote** (pull over the local file; the previous version stays in
  git), or Enter to skip. Non-interactive sessions log the conflict and
  skip; `--force` resolves as keep-local without asking. n8n-UI structural
  edits detected after a node push produce an early warning. `check` warns
  while an unreconciled `workflow.remote.json` exists.

### Changed

- `watch` starts every session with a **safety commit + pull** of the
  workflow folder: local state is committed first (even with
  `commitOnPush`/`commitOnPull` off — it's the data-loss guard, skipped on a
  clean tree), then the workflow is pulled so watch begins from a committed,
  in-sync baseline. Without git, the startup pull is skipped with a warning
  instead of risking uncommitted edits.
- `watch` no longer refuses workflows without Code nodes — they are
  watchable for structural (`workflow.json`) changes.

### Fixed

- One corrupt `.decanter.json` no longer breaks every command for every
  workflow: `pull`/`push`/`status`/`watch` now skip the broken folder with a
  warning, and `check` (and the push gate) report a scoped
  "corrupt .decanter.json (…)" compliance error for that folder — previously
  a raw `SyntaxError` aborted the whole command, healthy workflows included.
- Malformed `decanter.config.json`, and malformed `workflow.json` in
  `rename`, now fail with an error naming the offending file instead of
  leaking a bare JSON `SyntaxError`.
- `watch`: pushing a node whose `.decanter.json` entry disappeared
  mid-session (e.g. removed by a concurrent pull) now fails with a clear
  "pull first" error instead of a `TypeError`.

### Changed

- **Breaking:** `watch` now takes a **workflow id** and watches every Code
  node in that workflow's `code/` dir, pushing whichever node you save
  (previously it took a single node file and watched only that one). Run
  `n8n-decanter <id> watch`, or omit the id when `decanter.config.json` lists
  exactly one workflow. This matches the new browser live-reload, which is
  workflow-scoped.
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
