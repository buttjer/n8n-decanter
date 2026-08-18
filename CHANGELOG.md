# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **"Missing `n8n-instance` tools? Restart" is no longer the only answer we
  give — in a nested sync dir it was a dead end.** Agent wiring loads at
  startup *from the dir the agent was started in*, so tools declared in
  `.mcp.json` can be absent for two reasons: the wiring is new (a restart fixes
  it), or the wiring sits **below** the launch dir, where no restart will ever
  load it. Every surface that taught only the first now teaches both, with the
  discriminator you can apply yourself — *is that `.mcp.json` below the
  directory you started the agent in?* — and the two working routes (start the
  agent in the sync dir, or wire the root with `N8N_DECANTER_DIR` plus a
  root-resolvable command): the scaffolded `AGENTS.md`, `init`'s own output
  (which now prints the nested guidance **instead of** the restart line when it
  scaffolds into a nested dir), [Working with coding
  agents](/docs/agents/overview/), [init](/docs/cli/init/) and a new
  [troubleshooting](/docs/faq/troubleshooting/) entry. The CLI never needed
  that wiring, so `pull`/`push`/`preflight` keep working either way — the docs
  now say so too.

- **The oversized-scenario warning now names a remedy you can actually take.**
  Above 1 MB `scenario create` said "Trim it before that" — but there is no
  trim flag, so the advice pointed nowhere. It now says what is true and what
  to do: nothing is committed yet (`scenario create` never commits — only the
  next `pull`/`push` sweeps the folder into history), so you can still cut
  items out of `data.resultData.runData` by hand, or re-create the scenario
  with `--scaffold` instead of `--execution` and author the pins yourself.
  `docs/cli/scenario.md` spells out both, including which parts of a capture
  are unsafe to delete.

- **The agent contract now says to orient *before* the first edit, not only
  before the push.** `preflight` was always the read-only report of the
  instance's side (`drift`, `CONFLICT`, a pending `parity`), but every surface
  framed it as the pre-push gate — so an agent edited first and learned about a
  colleague's UI edit afterwards. The scaffolded `AGENTS.md` and both agent doc
  pages now open the loop with it: on drift, `pull` and carry on; on a
  `CONFLICT`, show `diff` and ask before either side is overwritten.
- **The scaffold stopped advertising a deny rule it no longer has.** The
  Claude Code `settings.json` denies `.decanter.json`, `.env` and
  `push --force` — but the scaffolded `CLAUDE.md` and `opencode.json` still
  claimed `*.remote.js` was blocked too. Those conflict artifacts were removed
  in the MCP pivot; both files now describe the policy that actually ships.
- **Docs: `mcp connect` / `mcp serve` no longer read as if the guard obtained
  credentials itself.** "decanter's own credentials", "the agent never holds an
  n8n credential" and "no secret to manage" led readers (and agents) to believe
  the guard handles the n8n login. It does not: it only *reads* what `init`
  wrote to `.env` / `.decanter-auth.json`, and can at most refresh an OAuth
  token. The mcp-connect / mcp-serve pages and the template `AGENTS.md` now say
  so outright — obtaining credentials is exclusively `init`'s job, and a
  "no MCP credentials" answer means run `init`, not retry.

- **"decanter.config.json not found" now points at `init` — with its flags.**
  The classic half-setup is a hand-written `.env`: an agent that cannot run the
  browser OAuth flow asks its human to paste `N8N_MCP_TOKEN` into a file and
  stops there, leaving no config, template, `.gitignore` or agent wiring behind.
  The error now says the dir is not a sync dir yet, that `.env` alone is not
  enough, and prints the prompt-free command that fixes it
  (`n8n-decanter init . --host <host-url> --token <mcp-token>`). The docs
  (init, configuration, troubleshooting, README) say the same thing: headless is
  not a reason to skip `init` — it takes the same token as a flag.

- **`init`'s restart reminder now covers everything it wires, not just
  permission rules.** MCP servers (`.mcp.json` / `opencode.json` — including the
  guarded `n8n-instance` server), permission rules and hooks are all read at
  agent **startup**, and `init` normally runs inside the session it configures.
  The reminder now fires when any of those files is newly scaffolded and says
  what it means: this session is still unconfigured, restart the agent (or
  `/reload`). README, init and the agents docs say the same, and the scaffolded
  `AGENTS.md` tells the agent to **ask for a restart** when the `n8n-instance`
  tools are missing instead of connecting to the instance directly.

### Fixed

- **The scaffolded hooks now work when your sync dir is not where the agent was
  started.** All three found the sync dir by assuming it was the current
  directory, which only holds for an agent launched inside it. With the sync dir
  nested in a bigger repo — a layout the docs explicitly allow — the agent runs
  at the repo root and every one of them misbehaved: the rename-reference guard
  became a **silent no-op**, so `$('Old Name')` references left behind by a
  `renameNode` went unreported until a later `push` refused them; the verify hook
  spawned the CLI without a directory, so it **blocked every node-file edit** with
  a "not a sync dir" error; and the MCP routing check scanned the wrong tree.
  Each hook now locates the sync dir from its own installed path, so it behaves
  the same wherever the agent starts.
- **The routing check no longer misses direct-route servers in your user
  config.** Its lookup for this project's entry in `~/.claude.json` matched the
  current directory, but that file is keyed by the repository root — so in any
  sync dir inside a git repo the check silently found nothing. It now matches the
  project entry for the sync dir or any parent of it.
- **The verify hook finds a locally installed CLI.** It only ever looked for
  `n8n-decanter` on `PATH`, so with a local (non-global) install it stayed quiet
  and no verification ran at all. It now prefers the sync dir's
  `node_modules/.bin` and falls back to `PATH`.
- **"decanter.config.json not found" no longer sends you to `init` when the sync
  dir is simply somewhere else.** Run from *above* a perfectly good sync dir —
  what happens whenever an agent starts at the repo root — the error read as if
  nothing had ever been set up, and advised scaffolding a second sync dir on top
  of the working one. It now looks below the directory it searched from, names
  the sync dir it finds there, and prints the `--dir` / `N8N_DECANTER_DIR` form
  that reaches it. When there really is no sync dir, the `init` advice is
  unchanged.

### Added

- **The routing check also looks at parent directories, up to your repository
  root.** Agents merge `.mcp.json` from every directory above the one they start
  in, so a server pointing straight at your n8n instance can sit in the repo
  root's config and still route this session. The scan stops at the repository
  boundary, so it never reaches into unrelated parent directories, and an
  offender found above the sync dir is named by its relative path
  (`../.mcp.json`) so you can tell which file it means.

- **`--dir <path>` (or `N8N_DECANTER_DIR`) points any verb at a sync dir that is
  not the current directory.** The layout the docs allow but nothing supported:
  the sync dir nested inside a bigger repo, with the agent started at the repo
  root. The MCP entry `init` writes into the sync dir is invisible from up
  there, and hoisting it to the repo root spawned the guard where no
  `decanter.config.json` could be found — so the guard did not work at all. The
  search still only walks *up*; this says where it starts. In an agent's server
  entry the environment variable is the form to reach for
  (`"env": { "N8N_DECANTER_DIR": "flows" }`), and relative values resolve
  against the working directory, so a repo-relative one keeps working for
  everyone who clones. `init` does not take `--dir` — it still takes the
  directory to scaffold as an argument.

- **`init` now tells you how to wire an agent when your sync dir is nested in a
  bigger project.** Agents look for `.mcp.json`, `opencode.json` and
  `.claude/settings.json` from the directory they were *started* in and never in
  one below it, so everything `init` scaffolds is inert for an agent started at
  the repo root above the sync dir. When init sees a project around it (a `.git` or
  `package.json` in a parent) it prints both shapes that work: starting the
  agent inside the sync dir — recommended, nothing further to configure — or the
  paste-ready MCP, opencode and hooks/permissions blocks for the project root,
  with every path and glob already prefixed. That prefixing is the point: copied
  up verbatim, `Read(.env)` / `Edit(.env)` guard the *root's* `.env` and quietly
  stop protecting your credentials. `init` prints this; it never writes into a
  parent directory. Only on the run that first scaffolds the agent files, and
  never for a standalone sync dir.

## [0.10.1] - 2026-08-16

### Added

- **The live mirror now tells the agent when it overwrote your work.** It runs a
  full `pull` after a structure edit, so it can replace an unpushed local code
  edit with what is on the instance. It always warned about that — on stderr,
  which is the one stream an MCP agent structurally cannot read, so the party
  able to react never heard it. The warning now rides the **result of the
  agent's next tool call**, naming the files and how to recover them from the
  safety commit. Delivered once, never repeated.

  Only on `mcp connect` (the transport `init` scaffolds). `mcp serve` pipes
  upstream responses through untouched — including SSE — and buffering them to
  inject an advisory line would break streaming for every response to deliver it
  on some. On that transport the stderr warning stays the only signal.

- **`init` now says that its permission rules only bind the next session.** It
  writes `.claude/settings.json` with the deny rules that keep an agent off
  `.decanter.json`, `.env` and `push --force` — but agents read permission config
  at startup, not on change, and `init` is normally run *from inside* the session
  those rules are meant to constrain. They were silently inert until a restart,
  and the docs mentioned a restart only for the skills plugin — so the rules that
  actually gate the agent went unmentioned. Printed once, when the file is first
  written; a re-init in a set-up directory stays quiet.

- **`node run` fixtures can pin a node's other outputs, so `$('Node').all(1)`
  finally answers.** Give a node one items array **per output** and the branch
  is readable offline:

  ```json
  "nodes": { "Decide": [[{ "json": { "side": "true" } }], [{ "json": { "side": "false" } }]] }
  ```

  `all(1)` / `first(1)` / `last(1)` and `$items('Decide', 1)` read output 1, and
  an **empty** array is a real answer — that branch took no items. `input` takes
  the same shape, indexed by the node's *input* (a Merge node's second input).
  A plain items array still means a single output, so existing fixtures are
  unchanged; asking for an output the fixture doesn't supply still refuses,
  now saying how many it has. Until now every such call was refused outright,
  because a fixture could only express one array per node.

- **`preflight --simulate` now replays a pinned node's other outputs too.** The
  stand-in decanter substitutes for a network node is a Code node, which has one
  output — so an error output (or any second branch) captured in your execution
  was replayed nowhere, and everything behind it sat with no input, emitted
  nothing, and let the run pass. Each populated output now gets **its own
  stand-in**, wired to the same input as the original and feeding exactly that
  output's targets, so the branch really runs. Deliberately not wired to the
  synthetic trigger: a stand-in fires only when the original would, so a replay
  whose real nodes take a different path can't have the old branch's items
  injected into it anyway. The `simulate` check names the splits in its details
  (terminal and `--json`). **`test` still replays `main[0]` only** — n8n's
  `pinData` is one flat items array per node, with no output dimension — and
  `scenario check` now spells out which of the two you are looking at.

- **`test` now reports what the run actually moved, not just that it
  finished** — a coverage line over the nodes that executed (enabled and
  unpinned; a pinned node's items are the input you supplied):
  `coverage: 7/9 unpinned node(s) emitted items — 2 emitted none: Group
  products, Write rows`. A node counts as emitting if it put an item on **any**
  output. Some empty nodes are normal — a filter that dropped everything — so
  the line warns and nothing more.

  **But a run in which not one unpinned node emitted an item now fails
  (exit 1), even with synthetic pins.** n8n calls such a run `success` and
  it is: nothing errored. No data moved either, so nothing was demonstrated,
  and reporting it as a pass was the check lying. The message names the usual
  cause — a pin replays a node's first output only.

- **`scenario check` warns about what the replay will throw away.** Both replay
  paths (`test`'s `pinData`, `preflight --simulate`'s stand-in node) read
  `main[0]` only, while the validator happily accepts — and `✓ valid`s — a
  scenario carrying items on several outputs. The check now says so offline:
  once for a node whose data populates more than one output, naming the indices
  that get dropped, and once for a node source that reads a pinned node's
  non-first output (`$('Enrich').all(1)`, `$items('Enrich', 1)`) — the call that
  returns nothing and leaves the node emitting nothing. Warnings only; the
  scenario stays valid for the outputs that do replay.

### Changed

- **An explicit `.ts` extension in a node file's import no longer fails the
  typecheck.** The scaffolded `tsconfig.json` now sets
  `allowImportingTsExtensions`, so `import { total } from
  "../../../shared/money.ts"` type-checks — until now it was rejected
  (TS5097) even though `push` bundles it without complaint, which made the
  gate and the bundler disagree over a pure spelling choice. Extensionless
  stays the recommended form (it survives a helper later becoming `.js`);
  both spellings resolve everywhere. Existing sync dirs are offered the
  updated `tsconfig.json` on the next `init` — a `tsconfig.json` you edited
  yourself is reported as drift and left alone, so add the option by hand
  there.
- **Two of the four import rules for `.ts` nodes now warn instead of
  blocking a push**: a relative import resolving outside the sync dir, and an
  absolute-path import. Both only endanger the author's own portability — the
  bundle still builds locally and fails loudly (`Could not resolve`) wherever
  the target is genuinely absent — so blocking them was decanter making the
  user's call. The advisory prints on every surface (`preflight`'s `layout`
  details, `push`, `node run`) and exactly once per push;
  `preflight --fail-on=warn` is the strict variant for CI. **Node builtins
  and npm packages not opted into `bundleDependencies` still block** —
  esbuild is silent about both, so without the block the failure would
  surface at runtime on the n8n instance.
- **The scaffolded `mcp-route-check.mjs` session hook now also inspects
  user-level agent config for direct n8n MCP routes** — Claude Code's
  `~/.claude.json` (including its entry for the current project), Cursor's
  `~/.cursor/mcp.json`, the VS Code user profile, and opencode's global
  config. Previously it read only project files, so an `n8n` server added
  with `claude mcp add -s user` (or any other user-scoped config) bypassed
  the decanter guard without a word — exactly the "second door" the hook
  exists to catch. Still a warning, never a gate. Re-run `init` in an
  existing sync dir (or re-copy the hook from the template) to pick it up.
- **The scaffolded `tsconfig.json` now covers the whole sync dir**, not just
  `shared/` and `workflows/` — helper code may live in any folder inside the
  sync dir (`shared/` is only the scaffolded default), so the typecheck and
  the editor's tsserver now own every root without a config edit. Existing
  sync dirs keep their scaffolded file; to match, widen `include` to
  `["n8n-globals.d.ts", "**/*.ts", "**/*.js"]` and add
  `"**/backups/**", "**/executions/**", "decanter-ts-plugin", "dist"` to
  `exclude`. Two consequences worth knowing: a loose node-shaped scratch file
  (top-level `return` outside any workflow's `code/`) is now part of the
  program and reports TS1108 — move it into a workflow or add its folder to
  `exclude`; and when `init` scaffolds into an **existing project** that had
  no `tsconfig.json`, the new config sweeps that project's own `.ts`/`.js`
  into the node-file typecheck — add your app dirs to `exclude` if they
  shouldn't gate pushes.

### Fixed

- **`diff` and `preflight` no longer report a `CONFLICT` for a node with no
  recorded sync hash.** "Changed both locally and remotely" is measured against
  the last-sync baseline in `.decanter.json`; with no baseline nothing is
  *known* to have moved on the instance, and `push` has always treated that as
  pushable. The two disagreed, so the report described a dead end the CLI did
  not have — worse, its documented exit (`push --force`) is denied to agents by
  the permission rules `init` scaffolds. Such a node now reads as
  `push pending`, which is what `push` does with it. `pull` no longer warns
  `CONFLICT` for the same case on `.ts` nodes.
- **A `.js` → `.ts` conversion no longer reads as data loss.** Re-pointing a
  node's `//@file:` placeholder is the sanctioned way to convert, and `push`
  and `pull` both adopt it before doing anything — but `diff` and `preflight`
  looked the file up in `.decanter.json` alone and announced `local file
  code/<node>.js missing` for the file you had just replaced. They now read the
  placeholder too, so a converted node reports `local changes in
  code/<node>.ts — push pending`, identically for every converted node.
- **`preflight` no longer prints `✓ parity local code matches the draft`
  directly above `✗ drift CONFLICT`.** Both checks read the same facts, so
  `parity` may claim a match only when every node is in sync; divergence that
  `drift` owns is reported as an `info` line pointing at it.
- **`mcp connect` survives an unreachable n8n instead of dying at the
  handshake.** `initialize` was forwarded like any other message, so a
  connection failure answered the *handshake* with an error: the agent's MCP
  client got no `serverInfo` and tore the session down before a single tool
  call could report what was wrong. The guard now completes the handshake
  itself when n8n does not answer, and the failure surfaces on the tool call
  that needed the instance. Once n8n is reachable, the handshake is replayed
  upstream so the session it uses is a real one. The startup line now reads
  `guard: ready — forwarding all n8n MCP tools to <host>` instead of
  `connected to <host>`, which claimed a connection nothing had made yet.
- **The scaffolded `AGENTS.md` now names the n8n-side prerequisites.** MCP
  access is a switch per *instance* **and** one per *workflow* ("Available in
  MCP"), and until a workflow's is on, `pull`/`push`/`diff`/`preflight`/`watch`
  all fail for it. The CLI's error says so; the file an agent reads *before*
  running anything did not.
- **`preflight`'s `types` check now reports type errors in shared helper
  files** instead of passing green while `push` fails on them. The scoped
  typecheck dropped every diagnostic outside the graded workflow's own dir —
  and helper code lives outside every workflow dir by definition — so a
  workflow could grade `ready` on code `push` then rejected. Helper
  diagnostics (under `shared/` or any other folder) now surface in every
  workflow's `types` line, while another workflow's *node* errors stay out of
  scope as before.
- **The documented shared-import path was one level short** for the `code/`
  layout: `../../shared/money` in the TypeScript-nodes docs and the scaffolded
  `AGENTS.md` resolved to `workflows/shared/money` and failed on copy-paste.
  The correct depth from `workflows/<folder>/code/` is `../../../shared/money`.
- **Compiled module labels — and therefore sync hashes — are now stable when
  the sync dir is reached through a symlinked path** (macOS `/tmp`, a
  symlinked checkout). esbuild resolves bundled files to their realpaths, so
  an un-realpathed label base produced machine-specific `../…`-climbing
  labels inside the hashed bytes — nodes reading "push pending" across
  machines with nobody touching code. The same spelling mismatch made a
  *scoped* typecheck silently drop every node diagnostic under a symlinked
  path; both now realpath. If a sync dir lives behind a symlink, the first
  push after this release re-baselines the affected nodes' hashes once.
- **The route-check hook now reads opencode's real config shape**
  (`mcp.<name>`). It previously looked only for `mcpServers` / `mcp.servers` /
  `servers` bags, so an `opencode.json` routing straight at the instance was
  listed as checked but never actually flagged.
- **A `watch` save now runs the same folder-wide compliance guard as `push`.** It
  used to check only the saved file, which cannot see the workflow's node names —
  so it could not catch a dangling `$('Renamed Node')` and pushed straight to the
  draft what a manual `push` refuses outright. The break then surfaced at run time
  in n8n instead of at save time. Four surfaces already claimed the guards were
  the same; now they are.

  **The abort is scoped, deliberately:** a save is refused when the violation is
  in the file you just saved, and violations elsewhere in the folder are printed
  on every save without blocking it. Repairing a rename means fixing several
  files, and a folder-wide abort would stop every save until the last fix — which
  would disable `watch` during exactly the job it is for.

- **`liveMirror` is documented as what it is: a full `pull`.** The shipped agent
  contract and the config reference both described it as refreshing the
  `workflow.json` snapshot. It also rewrites the `code/` files and
  `.decanter.json` and moves files on a rename, so it can overwrite an unpushed
  local edit — which is worth knowing before you restructure. No behaviour change;
  the docs now say what the code has always done.

## [0.10.0] - 2026-08-07

### Added

- **`scenario create <workflow> "<slug>" --extend`** — top an **existing**
  scenario up with the pinnable nodes it is missing, keeping every value already
  authored. Previously `scenario create` refused an existing file outright, so a
  scenario `test` rejected could only be fixed by hand-editing raw JSON for nodes
  the tool had never named. Also covers the ordinary case of a workflow that
  gained a node after its scenario was written.

- **`scenario create --scaffold` now works with no instance.** The fill entries
  were always built from your local `workflow.json`; the instance only supplied
  the per-node output **JSON Schemas**, which annotate the fill rather than
  enable it. With no `N8N_HOST` configured it now says the annotations are
  missing and scaffolds anyway — each node lands as provenance `authored`
  instead of `scaffolded`, so the difference stays visible in the file. This is
  what makes `preflight --offline --simulate` reachable on a plane: of the four
  pin sources, only *fetching a fresh capture* actually needs n8n. The messages
  that route you to a pin source now lead with the offline-viable ones, and
  `docs/cli/preflight.md` states which of the four need the instance.

### Changed

- **Breaking:** **a slug-less `scenario create --scaffold` now writes
  `scenarios/scaffold.json`, not `scenarios/scenario.json`.** The old default collided with the `scenario`
  verb, and the flag parser refuses to read a verb name as a flag value — so
  `preflight --simulate --scenario scenario` failed with `--scenario needs a
  value`, leaving the default file referenceable only as `--scenario=scenario`.
  If you have a script that names the old default file, point it at the new one
  (an explicit `<slug>` argument was, and stays, unaffected).

- **`scenario check` now reports the `test` gate too, not just the
  `preflight --simulate` one.** The two demand different node sets on purpose —
  `--simulate` asks only for nodes the capture **reached**, `test` asks for
  **every** enabled non-pure node because it runs on the live instance with real
  credentials. Reporting only the looser one meant a scenario could be green and
  still be refused by `test`. `check` now says which gate you have passed, and
  names `--extend` as the way to close the difference. The docs that asserted the
  two rules were the same are corrected.

- **`scenario create --execution` pins unreached nodes to an empty run instead of
  asking you to invent output for them.** A pinnable node the capture never
  reached is written as `[{"data":{"main":[[]]}}]` — "this branch isn't
  exercised" — and listed under `_decanterScenario.notExercised`. That makes a
  capture-seeded scenario usable with `test` straight away, keeps the node pinned
  to zero items (so it can never touch the real world), and leaves the claim
  visible for review: if a branch *should* have run, give it real data.

- **The cold-start errors now name the non-interactive `init`, and `--mcp-token`
  is an accepted alias for `--token`.** A fresh clone has no `.env` (it is
  gitignored), so `N8N_HOST must be set …` is the first thing you — or a coding
  agent — read. It said what was wrong and pointed only at a path that needs
  someone at a prompt; a blind session diagnosed the problem in one command and
  then had to hand the job back to a human. Both messages now spell out
  `n8n-decanter init . --host <host-url> --token <mcp-token>`, `init --host` on
  its own names `--token` when it warns about missing credentials, and the token
  flag accepts either spelling.

### Fixed

- **The "install typescript" advice now pins `@^5`.** A bare
  `npm i -D typescript` installs **7.x**, whose compiler is the native rewrite
  and no longer exposes the programmatic API decanter's node-file typecheck
  drives — so following the old advice replaced a *skipped* check with a broken
  one. The skip message and `preflight`'s unlock now both say
  `npm i -D typescript@^5` and name the reason. `init`'s scaffold already pinned
  `^5`; this only ever bit projects `init` deliberately left alone.

- **A 403 from the public API now names the scope you are missing.** n8n answers
  a valid-but-under-scoped `N8N_API_KEY` with a bare 403 and says nothing about
  which of eight scopes is absent. Every REST surface — executions, data tables,
  backup — now gets a per-endpoint hint, including the trap that catches people
  out: `dataTable:read` does **not** cover `/columns` or `/rows`, which need
  `dataTableColumn:read` and `dataTableRow:read`. The data-table hints also say
  outright that decanter only ever **reads** them, so no write scope is needed.

- **`scenario create` prints the file's size, and warns before it lands in git.**
  A capture-seeded scenario is a verbatim copy of every item of every node; one
  from a busy production run can be tens of megabytes. Nothing measured it, and
  `scenarios/` is tracked — so the folder-wide auto-commit on the next `pull` or
  `push` swept it into history unasked. The success line now carries the size,
  and anything above 1 MB warns explicitly that it is about to be committed.

- **Three scenario messages pointed somewhere the thing you needed was not.**
  A pre-rename scenario (`_decanterMock`) was told to look in
  `_decanterScenario.fill` — a key not in the file; the message now names the key
  it actually found. A replay gap derives its node list from the **workflow
  graph**, so those nodes are by definition *not* in `fill`, yet it said "see the
  `_decanterScenario` block"; it now says they are **not** listed, and points at
  `--extend`. And a node deliberately written as `"Node": []` was reported as
  unfilled — it is now told apart from a node with no entry at all, with the
  spelling for "emits nothing".

- **The agent guard's 401 no longer reads as "this project was never set up".**
  It led with *"run `n8n-decanter init`"*, and a blind field-test round watched an
  agent conclude from it that there was no `.env` and no token at all — then send
  its user through a pointless `init`. The `.env` existed; the token had simply
  been rotated. The guard now leads with the cause (*"n8n rejected decanter's
  existing MCP credentials … they are configured but no longer valid"*), matching
  what the CLI already said, and offers `init` only as the OAuth alternative. It
  also maps **403** now, pointing at n8n → Settings → MCP.

- **A missing `typescript` is reported as a skipped check, not a failed one.**
  `preflight`'s node-file typecheck needs `typescript` in your project. A
  globally installed decanter ships none (it is a devDependency), and `init`
  leaves an existing `package.json` alone — so scaffolding into a project you
  already had produced a module-resolution stack trace surfacing as a *typecheck
  failure*, which reads like a type error in your own code. It is now an honest
  skip, named in the coverage block with the one-command fix
  (`npm i -D typescript`).

- **The scaffolded `AGENTS.md` tells agents that `.env` is unreadable by policy
  and that this is not evidence it is missing** — the reasoning trap behind the
  401 finding above.

- **`node run` no longer answers a branch index with the wrong branch's data.**
  `$('Node').all(1)`, `$items('Node', 1)` and `$input.all(1)` ask for a node's
  *second* output — an `IF`'s false branch, a `Switch`'s other case. A fixture
  pins **one** items array per node, so there is no honest answer, but the
  argument was accepted and **ignored**: you got output 0's items and the node
  looked like it worked, graded against a shape it will never see live. Worse
  than empty data, because nothing fails. These calls now refuse with a message
  naming the call and the two ways forward (pin that branch as its own fixture
  node, or run it for real with `test`) — the same signpost pattern `$vars` and
  `$secrets` already use. `n8n-globals.d.ts` declared the parameter and
  `docs/cli/node-run.md` listed the calls as fully covered, so both surfaces had
  promised something the emulation never did.

- **`pull` no longer destroys uncommitted local edits.** It committed the folder
  *after* overwriting it, so an uncommitted `.js` edit was gone and had never
  entered git — while the warning printed on that exact path told you to
  "recover via git". Pull now takes a **snapshot commit before it writes
  anything** (`watch` and the live mirror already did). If the snapshot cannot be
  made — no git repo, `commitOnPull: false`, a git error — the pull still runs,
  but the warning says the overwrite is **not** recoverable instead of promising
  a safety net that isn't there.

- **`pull`'s clobber warning now fires for a node it has never synced.** It was
  gated on the node already having a sync baseline, which is backwards on the
  read side: no baseline means the node isn't in `.decanter.json` yet, so the
  local file is precisely the one with no protection. The loss path this opened
  matches the scaffolded agent workflow exactly — an agent adds a Code node over
  the guard (the guard blocks `jsCode`, so the remote body is empty), writes the
  source into `code/<node>.js`, and a background mirror pull lands before the
  first push: fresh file replaced by the empty remote body, silently.

- **The live mirror stops refreshing when its safety commit fails.** It awaited
  the commit and discarded the result, but that call returns a failure (it never
  throws) for any git error — unset identity, a mid-merge tree, `index.lock`, a
  rejecting hook. The documented "a dirty tree is safety-committed before the
  pull" rail therefore degraded silently into an unrecoverable overwrite. It now
  skips the refresh and says why, matching `watch`.

- **Scenario gaps are now judged per branch, not per node.** A branching node
  (an `IF`, a `Switch`) emits on **one** output per run, but `preflight
  --simulate` and `scenario create --execution` read its *first* output for every
  outgoing edge. Two consequences, both wrong: a node on the branch the capture
  **never took** was reported as a gap you had to write pin data for, and a
  genuine gap's `inputSample` was filled from the **other** branch's items — so
  you coded against the wrong upstream shape. Untaken branches are exempt and
  neutralized, as documented.

- **An n8n whose MCP access is switched off now says so.** Turning MCP off is a
  one-click state in n8n (Settings → MCP) and it makes the server answer a valid
  token with `403 MCP access is disabled` — it never 404s. decanter recognised
  401 and 404 but not 403, so every command failed with a bare
  `403 Forbidden` and no next step. It now surfaces n8n's own reason plus the
  fix. The 404 message was reworded to match what 404 actually means (no MCP
  server at that address — wrong `N8N_HOST`, or an n8n too old to have one).

  Note the ordering trap, now documented in the troubleshooting FAQ: a missing
  or stale token still returns 401 while MCP is off, so the 401 can hide the 403.

## [0.9.0] - 2026-08-04

### Changed

- **The agent guard now refuses a `publish_workflow` that would take a broken
  draft live.** `publish` already checked, but the raw MCP tool went straight
  through the guard — so an agent could go live around the verb and ship exactly
  the breakage the check exists to catch. Both transports (`mcp connect` and
  `mcp serve`) run the same check on the same shared code.

  **Fail-closed:** if the check itself cannot run — n8n unreachable — the publish
  is refused too, and the message says the *check* failed rather than claiming
  the workflow is broken. A read that fails almost certainly means the publish
  would have failed anyway, and "couldn't verify, so we shipped it" is not a gate.

- **Dangling-reference checks now cover all four forms n8n rewrites on a rename**
  — `` $('X') `` (as before) plus `$node["X"]`, `$node.X` and `$items('X')`.
  Previously only the first was detected, so a rename could strand a `$node[…]`
  call site that nothing reported: `preflight`, `push`, `test` and `publish` all
  passed it, and it failed at run time instead. The rule is n8n's own — its
  rewriter handles exactly these four — so if n8n treats it as a reference, the
  guard now does too.

  **This can surface errors in workflows that passed before.** A `$node["Old"]`
  reference to a node that no longer exists is a hard compliance error, which
  `--force` does not bypass. The message quotes the reference **as written**, so
  it is clear which form triggered it. Computed references (`$(someVar)`, a
  template literal with `${…}`) are still left alone — a regex cannot resolve
  them, and n8n has the same limit.

- **Breaking: `n8n-decanter test <workflow>` no longer executes.** It used to
  fall back to the newest capture under `executions/` and run the workflow for
  real on your instance — a directory that is gitignored, so the same commit
  behaved differently for different people, and a bare verb had real side
  effects. Bare `test` is now a **static tier**: it reads the instance's draft,
  reports dangling `$('…')` references, and runs nothing. Pass
  `--execution <id>` or `--scenario <slug>` for the pinned run, which is
  otherwise unchanged. There is no deprecation shim — a `test` that still
  executed *sometimes* would keep exactly the ambiguity this removes.

  The pinned run now also does the static check first, so a draft already known
  to be broken is never fired at the instance.
- **`publish` refuses a draft carrying a dangling `$('…')` reference.**
  Previously nothing checked: the compliance guard runs on `push`, `preflight`
  and `backup` — not `publish` — so a task that only renamed nodes never hit a
  gate and the break went live. The check reads **the draft on the instance**
  (the read `publish` already makes), not your local folder: `workflow.json` is
  a snapshot, so grading it would pass a broken workflow on a stale mirror and
  block a legitimate publish from a fresh clone.

### Added

- **`init` now scaffolds a hook that catches stranded `$('…')` references right
  after a rename.** n8n's `renameNode` MCP op rewrites the node name and the
  connections only, so the references it leaves behind used to surface at the
  next `push` — arbitrarily far from the rename that caused them. On Claude Code
  a PostToolUse hook on `update_workflow` now reports them immediately, split
  into the two halves and in the order they must be repaired: other nodes'
  expression parameters in n8n first, then the code files here, then `push`.

  It scans for the old name instead of running `preflight`, deliberately: the
  hook fires before the background snapshot refresh, and until that lands the
  snapshot still carries the old name, so every reference still resolves and
  `preflight` would report clean. Silent when nothing references the renamed
  node. The checklist in the scaffolded `AGENTS.md` remains the contract for
  every agent — the hook is a reminder, not a replacement.

### Fixed

- **Corrected the rename guidance: n8n's `renameNode` MCP op does NOT rewrite
  `$('…')` references.** The scaffolded agent guide (and the 0.6.0 notes below)
  claimed n8n rewrites connections *and* `$('…')` references server-side on a
  rename. Verified against real n8n 2.30.7 and 2.33.3: the MCP op rewrites the
  node name and the **connections only**, then reports success with
  `validationWarnings: []` — every `$('Old Name')` ref is left dangling, both in
  Code-node source and in other nodes' expression parameters. The n8n *editor*
  does rewrite them, but in the browser before it saves, so "server-side" was
  wrong for that path too. No amount of pulling repairs this; `pull` faithfully
  mirrors what n8n stored.

  `init`'s `AGENTS.md`/`CLAUDE.md` now describe the real contract, including the
  repair order that matters: **fix other nodes' expression parameters over MCP
  first, then local code, then `push`.** The other order loses the code fix,
  because a forwarded MCP write schedules a background snapshot refresh whose
  pull overwrites unpushed `.js` edits.
- **A dangling-reference error now says which half it is and where to fix it.**
  The two compliance errors were near-identical and neither mentioned a rename,
  which led to `workflow.json` being hand-edited — turning the check green while
  n8n stayed broken.

## [0.8.0] - 2026-07-27

### Added

- **The interactive picker offers a `--force` retry when a `push` hits the drift
  guard.** Previously the error was printed and you were dropped back at the
  menu, having to leave the picker and re-run `push --force` by hand — even
  though the CLI had just told you `--force` would fix it. Now it asks:

  ```
  ✗ remote code changed since last sync — pull first (or repeat with --force to overwrite the draft)
  retry with --force and overwrite the remote draft? [y/N]
  ```

  The default is **No**: a bare `Enter`, or anything other than `y`/`yes`,
  returns to the menu exactly as before. Answering `y` re-runs the same menu row
  (flags included) with `--force`, overwriting the n8n **draft** only — the
  published version is untouched.

  **It only appears for failures `--force` can actually fix.** A layout
  compliance error never prompts, because forcing does not bypass it. And this
  is the interactive picker session only: piped and non-interactive runs never
  prompt — they print the `--force` hint and exit non-zero, unchanged.

- **`diff` — the new verb for "show me the actual changed lines".** It is the
  promoted half of `status --diff`: per-node unified line diffs of your local
  code against the n8n draft, `.ts` compiled first (bundling `shared/*`, so a
  helper edit shows every importing node). Nodes that are in sync are omitted
  entirely, and a clean tree says so in one line. Multi-ref like `pull`/`push`;
  no workflow on a terminal opens the picker.

  **It always exits 0.** `diff` is an inspection view, like `git diff` — the
  gate is `preflight`. See the migration note under Removed.

- **`preflight --viewer`** (with `--simulate`): leaves a browsable throwaway
  n8n running so you can open the replayed run in the UI — the interactive half
  of the old `simulate` verb, now explicit instead of implied by a TTY. It does
  **not** relax preflight's safety contract: the graded run stays headless with
  `--network-none`, and the viewer is a second, separate container. A workflow
  with a multi-batch loop reports `simulate` as **skipped** under `--viewer`
  ("a preview, not a pass/fail check"), never as a pass.

- **`preflight --no-typecheck`** skips the `types` check — the escape hatch the
  retired `check` verb had.

- **The agent guard now logs a startup line and an audit trail** (`mcp connect`
  and `mcp serve` alike, on stderr):

  ```
  guard: connected to <host> — forwarding all n8n MCP tools, blocking jsCode writes in update_workflow
  guard: forwarded search_workflows
  ```

  Previously the guard spoke **only** when it blocked something, so an empty log
  meant either "ran, blocked nothing" or "never started" — indistinguishable,
  and opposite in meaning. The startup line settles that; the per-call lines
  make the guard the one place that can answer *what did an agent actually do
  to my n8n instance?*, since every MCP call passes through it.

  **Tool names only — arguments are never logged**, so the log stays safe to
  attach to a bug report.

- **Every `preflight` finding can now carry `details[]`** — the full list behind
  the one-line message: *every* layout violation, *every* `tsc` error, the
  drifted node names, the viewer URL. Printed indented under the check line,
  and present in `--json`. This is how the information `check` printed in full
  survives its removal; without it, folding `check` into `preflight` would have
  truncated a 12-violation layout failure to its first line.

### Changed

- **The picker lists pulled workflows newest-synced first**, instead of the
  folder's alphabetical order — the workflow you last pulled or pushed is under
  the cursor when the picker opens. Unpulled remote rows keep their place after
  the local ones. The signal is each workflow folder's sync timestamp, so it is
  *local activity*, not committed history: right after a fresh `git clone`
  everything looks equally recent and the list falls back to alphabetical until
  your first pull or push. Scripted `list` output is deliberately unchanged.

- **The CLI banner's `n8n` wordmark now uses the brand orange, matching the
  website** (`#E18528`, derived from the site's accent color) rather than ANSI
  red. It degrades gracefully — a 256-color terminal gets the nearest orange, a
  16-color one keeps the old red — and piped output and `NO_COLOR` stay plain,
  exactly as before.

- **Breaking: `preflight`'s profiles are replaced by two orthogonal flags.**
  `--full` and the `Profile` model are gone. Depth is now `--simulate`
  (**additive** — appends the local-engine run of your code) and `--offline`
  (**subtractive** — drops the instance-reads tier), and they compose:

  ```
  preflight                       static + instance reads            (the default gate)
  preflight --simulate            + a local-engine run of your code
  preflight --offline             static only — no instance contact
  preflight --offline --simulate  static + local engine, no instance
  ```

  **Migration:** `--full` → `--simulate`. And read the next entry carefully —
  `--offline` still exists but means something narrower.

- **Breaking: `preflight --offline` no longer runs the local-engine replay.**
  It used to mean "static + engine, no instance"; it now means "static only".
  The flag name is unchanged, so **nothing will error** — an air-gapped CI job
  on `preflight --offline` simply stops running the engine and quietly loses
  that coverage. **Migration:** `preflight --offline --simulate` is the old
  `--offline`. (This narrowing is also what makes `--offline` fast enough for
  the per-edit hook: it now spawns no Docker container.)

- **Breaking: `preflight --json` replaces `profile` with `flags`.** Where the
  report carried `"profile": "default" | "full" | "offline"` it now carries
  `"flags": {"simulate": false, "offline": false}`. Agents key on this. Every
  other field is unchanged, and each entry in `checks[]` gains an optional
  `details: string[]`.

- **`preflight` with no workflow and an empty `"workflows"` config now checks
  every *pulled* workflow** instead of erroring with "no workflow ids" — the
  behaviour the `check` verb had, kept now that `preflight` absorbs it.

- **A workflow folder with an unreadable `.decanter.json` no longer fails your
  gate.** `check` scanned *folders*, so a corrupt state file anywhere under
  `workflows/` was a hard error for the whole run. `preflight` grades resolved
  *workflows*, and a folder whose state won't parse can't resolve to one — so
  it is named in a warning (`corrupt .decanter.json (…) — skipping this
  folder`) and skipped, while every healthy workflow is still graded. The fact
  is still reported; it just no longer blocks work on unrelated workflows.

- **`preflight --simulate` accepts multiple workflows.** The old `simulate`
  verb took exactly one; preflight loops, so a multi-ref run spins one engine
  container per workflow, serially.

- **The scaffolded template now runs `preflight --offline` where it ran
  `check`** — the PostToolUse verify hook, both `package.json` scripts, and the
  agent-facing prose in `AGENTS.md` / `CLAUDE.md`. *Existing sync dirs keep
  their files*: re-run `n8n-decanter init` to be offered the refresh, and note
  that init leaves locally-modified files alone, so a hand-edited hook or
  `package.json` still invokes a removed verb until you update it yourself.

- The scaffolded agent permission allowlist swaps its `check`/`status`/
  `simulate` rules for a `diff` pair (both the bare and `npx` shapes);
  `preflight --simulate` is already covered by the existing `preflight:*` rule.

- The interactive picker's action menu is now `preflight`, `preflight
  --simulate`, `diff`, `pull`, `push`, `watch`, `executions` — a menu row may
  carry flags, which is how the browsable local-engine run survives the fold.

- **The scaffolded agent contract now treats `push` as part of finishing the
  work, and reserves "ask the user first" for `publish`.** A push lands on the
  workflow's **draft** and never changes what is running; only `publish` /
  `push --publish` / `unpublish` do. The old rule gated both behind "only when
  the user asks", so an agent handed "build me an hourly job that tags orders"
  would build the structure in n8n, write and verify all the Code, and then
  **stop** — leaving every Code node empty on the instance and the real code in
  the repo, reporting "ready to push". Correct by the old rule, and not what
  anybody asked for. Agents are now told to push once offline checks pass, to
  say what landed, and to still ask first when the workflow is published/active
  or a teammate is editing it. Going live remains a deliberate, user-requested
  step. Affects `template/AGENTS.md.example` (copied into new sync dirs by
  `init`) and the `/docs/agents` surfaces. *(Surfaced by the Plan 35 blind field
  test, where the "failing" agent was following the old contract exactly.)*

- **The scaffolded agent contract now follows the `preflight → push → test →
  publish` flow.** `preflight` is local-only (it no longer runs on the instance),
  so `test` — which runs the workflow's **draft** — is only meaningful *after* a
  push. The old contract framed `test` as a pre-push runtime check and ended its
  loop at `preflight → push`; both are now reconciled to the new order. Affects
  `template/AGENTS.md.example` and the `/docs/agents` surfaces. *(Same surface
  the Plan 60 verb reorder changed — kept in lockstep so the blind field test
  grades agents against a contract that matches the tool.)*

- **Breaking: `preflight` no longer runs the instance-side `test` stage.** It
  ran `test_workflow` against n8n's **draft**, while every other stage graded
  your **local files** — so whenever a push was pending, one score described
  two different versions of the workflow, flagged only by a `-10` parity warn.
  A report could read *caution, 90/100* while its runtime evidence was about
  code you weren't shipping. `preflight` now grades local code only; the
  instance is read for sync facts and never executed.

  The documented flow is **`preflight` → `push` → `test` → `publish`**: verify
  local code, make it the draft, run what you actually pushed, then go live.
  Nothing was removed from the toolbox — the instance run moved to where it
  means something.

  **Migration:** a CI job that gates on a plain `preflight` no
  longer gets an instance run inside that gate — the draft is never executed by
  preflight. To keep instance-run coverage, add `n8n-decanter test` as its own
  step **after** your push step (`--require=test` users get a hard error with
  this guidance; default-profile users get this note).

- **Breaking: `preflight --require=test` is rejected**, with a message pointing
  at the new flow rather than a bare "unknown check". The `test` id is gone
  from `--require`, from `--json` `checks[]`, and from `coverage`.

- **`preflight` auto-fetches a capture only under `--simulate`** — the flag
  that adds the one stage which consumes a capture. Without it there is no
  runtime stage, so preflight no longer fetches, and a missing or stale capture
  is reported as `info` rather than `warn` — nothing would consume one
  (`--offline` never reaches the instance to fetch either way).

- The `parity` warn is reworded. It was a caveat about the runtime tier
  grading the wrong artifact; that's no longer possible, so it is now the plain
  next step: *"local code differs from the draft in N node(s) — push to make it
  the draft, then test"*.

- **The local-engine replay is the sole runtime stage** (`preflight --simulate`)
  and needs Docker. For runtime evidence without Docker, push and then run
  `test`.

- **Node-file type checking moved off TypeScript's legacy `node10` module
  resolution** to `moduleResolution: "bundler"` (with `module: "preserve"`), in
  the scaffolded `tsconfig.json`. This matches what push actually does — `.ts`
  nodes are compiled with esbuild in bundling mode — and keeps the documented
  extensionless import style working (`import { total } from
  "../../shared/money"`). It also unblocks TypeScript 6, which turns `node10`
  into a hard error (`TS5107`), and TypeScript 7, which removes it outright.
  `node16`/`nodenext` were **not** chosen: they reject extensionless relative
  imports (`TS2835`) and would force every node file to be rewritten with `.js`
  extensions. No change to which Node.js versions are supported. *Existing sync
  dirs keep their current `tsconfig.json`* — re-run `n8n-decanter init` to be
  offered the refresh; if you have hand-edited yours (or created it before
  template baselines existed), init reports it and leaves it alone, so apply
  the two-line change yourself when you move to TypeScript 6+.

### Removed

- **Breaking: the `check`, `status`, and `simulate` verbs.** All three were
  variations on "check my thing", and telling them apart was the single most
  confusing part of the surface. They fold into two:

  | You used to run | Now run |
  | --- | --- |
  | `check [workflow…]` | `preflight --offline [workflow…]` |
  | `check --no-typecheck` | `preflight --offline --no-typecheck` |
  | `status [workflow…]` | `preflight [workflow…]` (the scored summary) |
  | `status --diff` | `diff [workflow…]` (the changed lines) |
  | `simulate <workflow>` | `preflight <workflow> --offline --simulate` |
  | `simulate --network-none` | `preflight --simulate` (always network-none) |

  Each removed verb exits non-zero naming its replacement, so a stale script
  fails loudly rather than silently. **Note the `simulate` row:** the verb
  needed no credentials, and a bare `preflight --simulate` still runs the
  instance tier — add `--offline` for the credential-free equivalent.

  Nothing was lost with the verbs. The compliance guard still gates every push
  and watch save (only the standalone *view* is gone, and preflight's `layout`
  finding now lists every violation); the publish state, live-lags-draft note
  and snapshot-stale hint are preflight's `lifecycle` and `snapshot` findings.

- **Breaking: `status`'s CI exit codes.** `status` exited 1 on a code conflict
  or remote drift, and pipelines gated on that. `diff` always exits 0.
  **Migration:** gate on `preflight`, whose `drift` check **fails** on a
  CONFLICT and warns on remote drift (add `--fail-on=warn` to gate on the warn
  too).

- **`simulate --network-none`.** `preflight` always runs the graded engine
  replay with no network, so the flag had nothing left to turn off.

- **Breaking: the `preflight --quick` profile.** With the `test` stage gone it
  was byte-identical to the default profile, and rather than redefine it into a
  meaning users would have to learn and then unlearn, it is gone. Static-only
  checking is now `preflight --offline`; the local-engine replay is
  `preflight --simulate` (see the profile→flags entry above, which retired
  `--full` and the whole profile vocabulary in the same release).

  **Neither `--quick` nor `--full` is recognized any more — they are simply
  gone, not rejected with a migration.** The CLI ignores flags it does not
  know, so `preflight --full` now runs the *default* gate (no engine) and
  `preflight --quick` runs it too, both exiting 0. **If you have either in a CI
  job, update it in the same step as this upgrade** — nothing will tell you at
  runtime. `--full` → `--simulate`; `--quick` → `--offline`.
- **Breaking: `preflight --trigger <node>`.** It existed only to feed the
  removed instance `test` stage; since that stage's removal it parsed and did
  nothing. `test --trigger <node>` (the post-push instance run) keeps the flag
  — that is where trigger selection acts.

### Fixed

- **Renaming a `.ts` node in n8n no longer leaves it stuck on "push pending".**
  A `.ts` node that imports from `shared/` (or an opted-in npm package) is
  compiled with esbuild's bundler, and esbuild labels every bundled module with
  a `// <path>` comment. That label used the node's **own filename**, so it
  landed inside the compiled bytes — and inside the `@ts-n8n sha256:` marker.
  Rename the node in n8n, `pull` renames `compute.ts` → `ümläut-nödé.ts`, and
  the artifact changed even though **not one line of your source did**: `diff`
  reported a difference that was purely the comment line, and the node read
  "local changes — push pending" until you pushed a no-op. The entry label is
  now a fixed name, so a pure rename round-trip is byte-stable and comes back
  clean.

  **One-time effect when you upgrade:** because the compiled bytes changed, the
  first `diff`/`pull` after upgrading reports **"modified, not yet pushed"** for
  every `.ts` node **that has imports** — a comment-line difference only. One
  `push` per workflow clears it, and it is a plain push, not a conflict: the
  remote code is untouched, so the drift guard does not trip and `--force` is
  not needed. `.ts` nodes **without** imports compile through a different path
  that never embedded the name, and `.js` nodes are unaffected.

- **The scaffolded MCP guard now starts under a *local* install, not only a
  global one.** `init`'s `.mcp.json` / `opencode.json` spawned the guard as a
  bare `n8n-decanter mcp connect`, which only resolves when the CLI is on the
  agent's `PATH` — i.e. a **global** install. With decanter installed as a
  **local** project dependency the command silently failed to start, so the
  agent got no guarded route and fell back to whatever other n8n MCP it had,
  unguarded. The scaffolded command is now `npx --no-install n8n-decanter mcp
  connect`, which resolves the local `node_modules` bin **and** a global
  install; `--no-install` never downloads from npm, so a genuinely missing
  install fails loudly instead of silently. (Plan 58.)

- **The scaffolded agent permissions now cover `npx n8n-decanter …` — including
  the `push --force` denial.** The same local-install gap applies to the CLI
  calls an agent makes in a shell: under a local (devDependency) install a bare
  `n8n-decanter <verb>` is not on `PATH`, so the working form is
  `npx n8n-decanter <verb>`. The permission matcher keys on the command prefix,
  so that form previously matched **neither** the allow rules (every safe call
  would stop to ask) **nor the `push --force` deny rule** — meaning the
  force-push guard rail could be sidestepped simply by invoking through `npx`.
  Both lists now carry the `npx` forms (Claude Code `settings.json` and
  opencode), and the scaffolded `AGENTS.md` tells agents to add the prefix when
  the bare command is not found. Installing globally is **not** required — a
  per-sync-dir devDependency remains fully supported. (Plan 58.)

## [0.7.0] - 2026-07-24

### Added

- **`check` now warns when local work has not been registered with n8n** — a
  node whose `//@file:` placeholder has moved off what `.decanter.json` records
  (the shape of a `.js`→`.ts` conversion), or whose recorded file is gone from
  disk. It stays a *warning*, not an error: `push` reconciles the file map, and
  the compliance guard runs before that reconcile, so failing here would refuse
  the one command that fixes it.

- **`n8n-decanter --version` prints the installed version** (`-v` too), the way
  every CLI is expected to. It answers before any config load or verb dispatch,
  so it works from anywhere — including outside a sync dir. Passed *alongside* a
  verb it is a hard error naming the flag you meant, so a stray `--version`
  can't quietly swallow a command.

- **A first `init` points at n8n's official skills pack.** Setup now closes by
  naming [n8n-io/skills](https://github.com/n8n-io/skills) — the knowledge layer
  that makes agentic workflow building work — and printing the install commands
  for **Claude Code**, **Codex**, and **skills.sh**, with the agent it detects
  from your environment listed first and the activation step each one still
  needs. It prints; it does not install: that would mean spawning a third-party
  CLI to mutate agent state outside the sync dir, and a plugin installed
  mid-session isn't active until the agent reloads. Said once per sync dir (no
  re-init repeats it), on every path including piped and `--host`-driven runs,
  and it consumes no input — no existing script's stdin changes. *(Plan 55.)*

- **`init` can run non-interactively via `--host` / `--token` / `--api-key`.**
  Passing any of them drives setup purely from the flags plus any existing
  `.env` and issues **no prompt** — so a script or coding agent can bootstrap a
  sync dir without the interactive stdin dance (the field-test agents needed
  20+ tries to drive the old prompt path). `--host` is required in this mode
  (a scheme-less local host is normalized to `http://`, like a typed one) and
  wins over an existing `.env` value; `--token` sets `N8N_MCP_TOKEN` (headless
  OAuth is still terminal-only); `--api-key` sets the optional `N8N_API_KEY`.
  The flag-less path (interactive, or piped answers) is unchanged. *(Plan 35
  field-test finding.)*

- **`node run` now emulates `$jmespath`.** A Code node that calls
  `$jmespath(data, expr)` (or the `$jmesPath` alias) runs offline, matching
  n8n's result (backed by `jmespath@0.16.0`, the version n8n pins). It also
  fills in `$items()`/`$node` (views over the fixture's `nodes`), `$vars`/
  `$secrets` (new fixture fields), and `$nodeId`/`$nodeVersion`/`$webhookId`.

- **`node run` fixtures gained `vars` and `secrets`** to pin the instance-scoped
  `$vars`/`$secrets` when a node reads them.

### Changed

- **Breaking:** the scaffolded Claude Code settings moved from
  **`.claude/settings.local.json` to `.claude/settings.json`**, and `init` now
  migrates existing sync dirs. The file holds *project policy* — decanter's verb
  permissions plus the `verify.mjs` and `mcp-route-check.mjs` hooks — with
  nothing machine-specific in it; it was already being committed and tracked in
  the shared `.decanter-template.json`, so `local` was the wrong scope, and it
  squatted the one file Claude Code reserves for **your** own overrides. The
  local slot is now yours: permission lists merge across the two files and a
  `deny` beats an `allow`, so a local file can add to the policy but cannot
  unblock what the project denies. On re-init, an untouched copy is moved for
  you; a copy you edited is left exactly where it is and the new file is **not**
  written (both would register their hooks) — `init` says what to move, and
  `--force` resolves it by removing the old file. A `settings.local.json` that
  `init` never wrote is never touched. *(Plan 56.)*

- **Breaking: `backup restore` takes the backup as an argument, not a flag —
  `backup restore <workflow> [<backup>]`.** `--version <id>` and `--at <ts>`
  are gone. The argument is a **backup ref** resolved by shape, exactly like a
  `<workflow>` ref: paste a timestamp (or a prefix — a bare date is enough) or a
  `versionId` (short or full), whichever column of `backup list` you have to
  hand. `backup restore order-sync 2026-07-24` and `backup restore order-sync
  a1b2c3d4` both just work; a ref that matches nothing is an error, never a
  silent fall back to the latest. The retired flags fail loudly with the
  replacement. This also un-squats `--version`, which no CLI can spend on a
  verb-scoped meaning (see Added).

- **`check`'s success line now states its scope** —
  `OK (local layout — status compares with n8n)` instead of a bare `OK`. `check`
  is offline by definition, so green means "well-formed", never "live in n8n".
  The agent guide gained the matching rule, and the `.js`→`.ts` recipe now ends
  at `push` rather than `check` — it previously told you to stop one step short
  of the conversion actually reaching the instance. *(Surfaced by the Plan 35
  blind field test: three separate sessions authored code, read a green `check`
  as "done", and never pushed.)*

- **`scenario create` / `scenario check` with no workflow now open the picker on
  a terminal**, like every other ref-taking verb (`pull`, `push`, `backup …`, …).
  They previously hard-errored with a usage line even on a TTY, which made them
  the odd ones out. Piped / non-TTY runs are unchanged — still the usage error —
  so scripts and agent harnesses never block on a prompt. *(Surfaced by the Plan
  35 blind field test, where an agent tripped the inconsistency twice.)*

- **`node run` signposts instead of crashing on instance-scoped globals.** A
  global whose value lives on the running instance (`$vars`/`$secrets` when
  unpinned, `$evaluateExpression`) now throws a friendly message that names the
  global and points to `test` (or the fixture field) — never a bare
  `ReferenceError`. `docs/cli/node-run.md` documents the covered / partial /
  unsupported boundary.

### Fixed

- **The documented Claude Code skills-install commands are no longer
  copy-paste-broken.** `/plugin marketplace add` / `/plugin install` are
  in-session slash commands, but the docs and the scaffolded `AGENTS.md`
  presented them as shell commands. Both now show the in-session form and the
  real shell equivalents (`claude plugin marketplace add …` /
  `claude plugin install …`) separately, plus the post-install activation step
  each agent needs.

- **A `.js`→`.ts` conversion is no longer reverted by a pull that fires before
  the first TS push.** Re-pointing a node's `//@file:` placeholder to a `.ts`
  file and swapping the source is the sanctioned way to convert a node, but a
  `pull` landing in the window before the first TS `push` — notably the
  on-by-default live-mirror background refresh after a structure edit — rewrote
  the placeholder back to `.js` and left `.decanter.json` pointing at the
  deleted `.js` file, so the next push failed with `referenced node file
  missing`. Pull now honors the re-pointed placeholder exactly as push does
  (they share one reconcile step). *(Plan 35 field-test finding.)*

- **`init` no longer breaks local `http` instances.** A scheme-less host typed
  at the `n8n host:` prompt now defaults to `http://` for local addresses
  (`localhost`, loopback, private LAN ranges, `*.local`) and `https://`
  otherwise. Previously every scheme-less host got `https://`, so a local n8n
  (plain http) was written to `.env` as a TLS URL and every sync/guard call
  failed with `fetch failed`. A scheme you type is still kept as-is.

- **`n8n-globals.d.ts` no longer over-declares `$if`/`$min`/`$max`.** Those are
  n8n *expression-language* helpers (`{{ }}` only), not Code-node globals — they
  throw in a real Code node too — so declaring them wrongly type-checked broken
  code. The declared surface now matches what a Code node actually sees, and is
  single-sourced (init copies the one root file — no duplicate template copy).

- The scaffolded agent permission allowlist (`.claude/settings.json` — see the
  move under Changed) now
  pre-approves the read-only **`preflight`** gate, so an agent following the
  template's recommended `edit → check → preflight → push` loop no longer stalls
  on a permission prompt at the gate itself. Also dropped the obsolete
  `*.remote.js` deny rule — those artifacts were removed in the Plan 32 MCP pivot.

## [0.6.0] - 2026-07-23

### Added

- **`backup` — git-native, redeployable disaster recovery.** `n8n-decanter
  backup create <workflow>` captures the workflow's full REST export into a
  committed, versioned `workflows/<slug>/backups/<timestamp>.<versionId>.json`
  store — the fidelity MCP can't give (credential refs + `description` kept;
  `pinData`/`staticData` stripped; each Code node's `jsCode` stays a `//@file:`
  placeholder, so no code is duplicated). It **dedupes** on an unchanged
  `versionId` and **rolling-prunes** the working set to `backupLimit` (config,
  default 20; `0` keeps all). `backup restore <workflow> [--version <id> |
  --at <ts>]` re-inlines the Code from `code/` and REST-POSTs a **new,
  unpublished** workflow with **node ids preserved** — a real second version
  history that survives the instance being lost; it prints credential-rebind
  hints + the editor URL (publish is your next step). `backup list <workflow>`
  shows the retained set. REST-only: needs `N8N_API_KEY`. The backup file is
  **not** auto-committed (it carries credential refs and any embedded
  secrets) — review it, then `git add` deliberately.
- **Live `workflow.json` mirror — the review snapshot refreshes itself after
  an agent restructures a workflow through the guard.** When a structure edit
  is forwarded through `mcp connect` / `mcp serve` (a non-blocked
  `update_workflow`), decanter now schedules a debounced background `pull` of
  that workflow, so the read-only `workflow.json` (+ code files + state) stays
  fresh with **no manual `pull`**. On by default; set `"liveMirror": false` in
  `decanter.config.json` to disable (CI / deterministic setups). It is
  fire-and-forget (never blocks the agent's next tool call), git-gated
  (safety-commits before pulling; skips with no git), and tracked-only. This
  changes `mcp connect`/`serve` default behavior (additive and disable-able —
  not breaking).
- **`preflight` — the whole verification ladder as one scored, read-only
  gate.** `n8n-decanter preflight [workflow…]` runs every safe check there
  is — local static (`layout`, `types`) → instance read-only (`connect`,
  `access`, `parity`, `drift`, `snapshot`, `lifecycle`, `history`,
  `capture`) → pinned draft runs (`test`, `simulate`) — ordered fast→slow,
  streaming each result, and condenses them into a **score (0–100)** and a
  **verdict** (`ready` / `caution` / `not ready`, exit 0/1) with per-check
  remediation. Profiles are explicit and deterministic: `--quick` (static +
  sync), default (+ `test`), `--full` (+ `simulate`), `--offline` (static +
  `simulate`, no instance). It brings **executions into the gate** — auto-
  fetching the newest capture when `N8N_API_KEY` is set (`--no-fetch` opts
  out) and reading production run health (`history`, via MCP
  `search_executions` or the REST fallback). Coverage is first-class: every
  skip names its unlock, and `--require=<ids>` turns a skipped check into a
  hard fail; `--fail-on=warn` promotes a caution to exit 1; `--fail-fast`
  stops at the first failure. `--json` emits the full report (stable check
  ids + remediation strings — the agent contract). **`preflight` never
  mutates** in any profile: no push, publish, restore, or draft write —
  `test` runs in a never-mutate mode and `simulate` headless with
  `--network-none` forced on. The single gate to run before `push`/`publish`.
- **`test` — instance-side pinned test runs (the recommended runtime
  check).** `n8n-decanter test <workflow>` runs the workflow on your
  instance via MCP `test_workflow`: the trigger and network/credentialed
  nodes are pinned from a capture (`--execution`, default newest) or a
  committed scenario (`--scenario`), logic nodes execute for real on the
  instance-exact engine, and each node's output is diffed against the
  capture (exit 1 on divergence; `--trigger` picks the start node,
  `--json` emits the report). The run targets the **draft** — the live
  version is never affected. On a terminal, when local code differs from
  the draft, `test` offers to push it first (drift-guarded, draft-only)
  and afterwards to keep or restore the pre-test draft (n8n version
  history when available, byte-exact write-back below n8n 2.29);
  non-interactive runs never mutate and say when they tested the draft
  instead of local code. `simulate` stays the offline sibling —
  pre-push/CI/isolation/version-rehearsal — and its docs now recommend
  `test` first.
- **`mcp connect` — the stdio MCP guard, auto-wired by `init`.** The default
  way a coding agent reaches your instance's MCP server: the scaffolded
  `.mcp.json` (and `opencode.json`) carry a static, secret-free
  `n8n-instance` entry (`{"command":"n8n-decanter","args":["mcp","connect"]}`),
  so guarded instance access exists the moment `init` runs — nothing to
  start, no secret to manage (stdio pipes are private). Decanter holds the
  credentials; the same guard rule as `mcp serve` applies (see below).
  Structure and lifecycle acts — creating/renaming/archiving workflows,
  adding/renaming/wiring nodes — pass through; Code-node (`jsCode`) writes
  are blocked toward the file + `push` flow. Fail-closed on unparseable
  input; an unreachable instance answers the agent with a JSON-RPC error
  naming the host; logs go to stderr (stdout is protocol-only).
- **`mcp serve` — the same guard as a localhost HTTP proxy**, for agents
  configured by URL: decanter holds the credentials (the
  agent gets a per-session secret instead), every read and structure
  operation forwards untouched (SSE included), and exactly one thing is
  blocked — `update_workflow` calls that write Code-node source, via either
  a `jsCode` key or a `setNodeParameter` op whose path targets `jsCode`,
  which get an instructive "edit the file + push" tool error. Fail-closed on unparseable
  bodies, 127.0.0.1-only, body-size cap; the running endpoint + secret land
  in a gitignored `.decanter-proxy.json`. The template gains a
  `mcp-route-check.mjs` session hook that nudges agents whose MCP config
  still points at the instance directly, and the sync-dir `AGENTS.md`
  contract is now guard-first.

### Removed

- **Breaking: the structure/lifecycle verbs are gone — `rename`, `create`,
  `node create` (and its `--ts` flag), and `node rename`.** Those acts go
  through **n8n itself**: the n8n editor, or n8n's MCP tools reached through
  the new `mcp connect`/`mcp serve` guard (which is exactly what the
  official n8n skills drive). Decanter's job is the reconcile: the next
  `pull` re-caches a renamed workflow's name (folder stays put), renames a
  renamed node's local file, and lands a new Code node as a source file. A
  Code node added over MCP carries **no `jsCode`** (the guard blocks code in
  `addNode`) — it now lands as an **empty file** whose first `push` seeds
  the source, completing the guarded authoring loop. Two behaviors did not
  survive the removal: `$('…')` refs inside local `.ts` sources are no
  longer rewritten on a node rename (n8n never sees `.ts` — update them by
  hand after the pull), and validate-before-create is now the calling
  agent's discipline (`validate_workflow` first, as the n8n skills teach).
- **Breaking: the `delete` verb is gone.** Decanter no longer offers a hard
  delete; retiring a workflow is an n8n act (archive it over MCP or in the
  UI — reversible there, which is also where permanent deletion lives).
- **Breaking: the `duplicate` verb is gone.** MCP has no lossless full-JSON
  create, so a faithful clone required the public API — rather than keep the
  API dependency or ship a lossy SDK-code re-expression, the verb was
  dropped. Duplicate workflows from the n8n UI and `pull` the copy.
- **Breaking: `watch`'s browser-reload proxy is gone — `browserReload` and
  `proxyPort` config keys are no longer honored (silently ignored, not an
  error).** n8n 2.x reflects an MCP draft edit in the open editor natively
  (soft canvas re-render, skipped — with a warning — while the tab has
  unsaved edits), making decanter's injected `<script>`-reload proxy
  redundant and, on that exact dirty-tab path, worse than doing nothing (a
  hard reload would have clobbered the unsaved edits). `watch` now just
  prints the editor deep link with a note to keep the tab open; it updates
  live on every push.
- **Breaking: `simulate --pin` and per-node `fixtures/` are gone — folded into
  `scenario`.** The per-node `workflows/<folder>/fixtures/<node>.json`
  mechanism and its precedence over captures are removed outright; a scenario
  is now the only committed pin artifact and is always self-contained (no
  fixture-over-capture layering to reason about). `--pin`'s job — "make a
  clean capture reproducible" — is now `scenario create --execution <id>`. A
  leftover `fixtures/` dir is a **hard error** from `simulate`/`check` naming
  the replacement; there is no silent read-path or auto-migration for it
  (unlike a leftover `mocks/` dir, which auto-migrates to `scenarios/` on
  first touch — see the `scenario` namespace under Added).

### Fixed

- **Verb-first error hints.** Several CLI error/guidance messages suggested
  **verb-last** commands (`n8n-decanter <ref> simulate …`,
  `n8n-decanter <ref> executions`, `n8n-decanter <ref> scenario …`) that the
  verb-first grammar rejects when copy-pasted; every one now prints the
  verb-first form (`n8n-decanter simulate <workflow> …`,
  `n8n-decanter executions <workflow>`, `n8n-decanter scenario … <workflow>`).
- **Refresh-token race (OAuth):** two concurrent MCP calls — or `watch` plus
  a manual `push` sharing `.decanter-auth.json` — could both redeem the
  single-use refresh token, killing the session for the loser ("re-run
  init"). Concurrent calls now share one redemption, a lost cross-process
  race recovers by re-reading the winner's rotated auth file, and auth-file
  writes are atomic.
- **MCP client hardening:** a transient handshake failure no longer poisons
  every later call in the same run; a 200-with-HTML answer (captive
  portal/reverse proxy) gets a named error instead of a raw `SyntaxError`;
  body-read timeouts use the friendly timeout message; a rate-limit
  `Retry-After` is honored up to n8n's verified 5-minute window (with a
  visible "waiting Ns" warning) and capped there against bogus-huge
  headers; a dropped MCP session (404 with a session id) re-handshakes once
  transparently; a token-refresh response without a
  rotated refresh token keeps the old one; workflow lists that hit the
  200-row page cap warn about truncation.
- **`init` appends `.decanter-auth.json` to a pre-existing `.gitignore`**
  instead of only warning — the file holds the MCP refresh token.
- **Push verifies `.ts` nodes after the write** (marker hash vs. remote
  body — catches server-side normalization), and watch's single-node pushes
  run the same post-push verification as full pushes.

### Changed

- **`pull` with no argument now opens the picker on a fresh setup.** On a
  terminal, `n8n-decanter pull` (no ref) lists your workflows — **local and
  remote** (over MCP) — so you can pick one to pull without knowing its id or
  pre-listing it in `decanter.config.json`; picking a not-yet-local workflow
  pulls it fresh. Previously its no-ref picker showed only already-pulled
  workflows, so a first-ever `pull` errored with `no workflow ids`. Piped /
  non-interactive runs are unchanged (they pull the config `workflows` set).
- **The scaffolded MCP config is rebuilt around the guard + n8n's official
  docs MCP.** `init`'s `.mcp.json` (and `opencode.json`) now wire two
  servers: **`n8n-instance`** — the `mcp connect` guard (see Added) — and
  **`n8n-docs`**, n8n's first-party read-only docs MCP
  (`https://docs.n8n.io/~gitbook/mcp`, public, no auth), replacing the
  community `n8n-mcp` server. The docs server can't reach your instance, so
  it can't bypass the guard — live workflow access goes only through
  `n8n-instance`. The scaffolded Claude Code allowlist pre-approves
  `mcp__n8n-docs` plus the offline/read verbs `pull`, `scenario`, and
  `simulate`; instance-mutating verbs still prompt.
- **A body-equal push now re-registers a missing `@ts-n8n` marker** — when a
  `.ts` node's compiled code already matches the remote but the marker is
  gone (e.g. rewritten in the UI), push writes the node anyway so it is
  recognized as TS-managed again (previously skipped as "in sync").
- **Converting a `.ts` node back to `.js` is now supported symmetrically:**
  replace the file, re-point its `//@file:` placeholder, and push — the
  push clears the remote `@ts-n8n` marker even when the code is otherwise
  identical, so the node stops being TS-managed (previously the stale
  marker made the next pull resurrect the node as `.ts`).
- **`scenario create` strips the capture's embedded `workflowData`** — committed
  scenarios no longer duplicate every Code node's source in git; the compliance
  guard warns about legacy scenarios that still embed it, and it now also flags
  Python Code nodes honestly (their `pythonCode` stays inline in
  `workflow.json`; extraction is a planned feature).
- **Template refresh (from the MCP pivot):** the sync-dir `AGENTS.md`
  contract was rewritten around the MCP boundary (Code-node source = files +
  decanter push; structure = n8n/MCP; knowledge skills recommended) with
  matching `.cursor` rules, and `.env.example` is OAuth-first (MCP
  credentials primary, the API key optional with a minimal scope list).
- **`N8N_API_KEY` now powers only `executions` and `data-tables`** — the last
  lifecycle verbs left the REST API, so the recommended key scopes shrink to
  `workflow:list`, `execution:read`, `execution:list`, and the `dataTable:*`
  read scopes (`template/.env.example` was rewritten OAuth-first to match).

- **Breaking: the workflow code path now syncs over n8n's built-in MCP server —
  decanter is the Code-node code layer, n8n owns structure (Plan 32).**
  `pull`/`push`/`watch`/`status`/`publish`/`unpublish` ride
  `POST /mcp-server/http` instead of the public REST API. What that means in
  practice:
  - **Pushes are draft-first.** `push` writes only each Code node's `jsCode`
    (an atomic `update_workflow` batch with merge semantics) to the workflow's
    **draft**; the live version never changes until an explicit `publish` — or
    the new **`push --publish`**, which combines the two. The API-era
    "auto-publish on push to an active workflow" behavior is gone.
  - **`workflow.json` is now a read-only structure snapshot.** Pull refreshes
    it for review diffs and the offline tooling; nothing pushes it. The
    whole-workflow structural hashing, the structural drift guard, watch's
    structural-conflict prompt (`workflow.remote.json`), and the `.remote.js`
    conflict artifacts are all gone — the only drift guard left is the
    per-node code check (`--force` still overrides it), and remote structure
    changes never block a push (`status` prints a snapshot-stale hint instead).
  - **Structure acts live in n8n.** Renames, new nodes, wiring, and new
    workflows happen in the n8n editor or over n8n's MCP tools (through the
    guard) — n8n rewrites connections and `$('…')` references server-side,
    node ids stay stable, and the next `pull` makes local files follow.
  - **Requires n8n ≥ ~2.20 with MCP access enabled**, plus a per-workflow
    "Available in MCP" opt-in. The picker shows MCP-unavailable workflows as a
    third state (red `⊘`, sorted last) with enable guidance instead of a
    failing pull; `list --remote` marks them (`--json` adds `mcpAvailable`)
    and pull/push errors carry the same guidance.
  - **The public API key becomes optional.** Only the surfaces MCP cannot
    serve still use it: `executions` and `data-tables` fetches. The client
    retries n8n's MCP rate limiting (429) with backoff automatically.
- **Breaking: `init` is OAuth-first.** `init` now connects to the instance via
  the standard MCP OAuth flow — browser consent, then a refresh token stored
  in a new gitignored **`.decanter-auth.json`** (rotated on every refresh) —
  with a paste-a-token fallback (`N8N_MCP_TOKEN`, minted in n8n → Settings →
  MCP) for piped/headless runs. The public API key prompt is now optional.

### Added

- **New `scenario` namespace — named, committed pin-data sets, captured and/or
  schema-scaffolded.** A *gap* (a network node reached in the replay with no
  pinned data) used to be a dead end. `scenario create <workflow> ["<slug>"]
  [--execution <id>] [--scaffold]` writes a tracked, self-contained
  **scenario** `workflows/<folder>/scenarios/<slug>.json` (slug defaults to the
  execution id) and flags which nodes to fill: `--execution <id>` promotes a
  gitignored capture and flags each remaining gap; `--scaffold` calls n8n's
  read-only MCP tool `prepare_test_pin_data` and annotates every gap with its
  output **JSON Schema** (no data — the tool is a schema oracle only); the two
  compose, and a bare `--scaffold` with no capture builds a from-scratch set
  where every pinnable node is a fill entry. You (or your IDE agent) add the
  nodes' `runData` — **no API key, the CLI never calls a model or invents
  values** — and replay it with `simulate --scenario <slug>` /
  `test --scenario <slug>`. Each node's pins carry a **provenance**
  (`capture`/`authored`/`scaffolded`); a run on a scenario with any
  non-`capture` node is labeled "**synthetic pins — proves executability, not
  output correctness**" (no per-node diff asserted; `--json` reports gain
  `syntheticPins`/`provenance`), while a capture-only scenario keeps full
  per-node diff and exit-1-on-divergence semantics. `scenario check <workflow>
  ["<slug>"]` **structurally validates** a scenario (or all of them)
  **offline** — no Docker — with a node-named error if an item is malformed or
  a flagged node is left empty; `simulate --scenario`/`test --scenario` run the
  same check on load. n8n publishes no execution-data JSON Schema, so decanter
  checks the exact shape it replays. Committed → scenario-based replays are
  reproducible for teammates and CI; `scenario create` warns about PII and
  refuses to overwrite an existing scenario. A `mocks/` dir from an earlier
  unreleased build auto-migrates to `scenarios/` on first touch.
- **`simulate` previews multi-batch loops in the viewer.** In an interactive
  terminal, a genuine multi-batch loop (previously a hard error) now caps the
  loop to its first batch and opens that single iteration in the browsable
  viewer, clearly labeled *"iteration 1 of N — not a pass/fail check."* Headless
  / `--json` / `--network-none` runs (scripts, CI) still hard-error, so an exit
  code is never mistaken for a verified pass.

### Fixed

- **Value-taking flags no longer swallow a following verb.** Writing a
  value flag in its space-separated form without a value — e.g.
  `n8n-decanter --status pull` — used to consume the `pull` verb as the
  flag's value and then fail with a confusing "no verb" error. Such flags
  (`--status`, `--limit`, `--execution`, `--n8n-version`, `--scenario`,
  `--filter`, `--search`, `--sort`) now refuse to eat a known verb and report
  `--status needs a value (e.g. --status=success)` instead.

## [0.5.0] - 2026-07-21

### Changed

- **Breaking: verb-first grammar.** The verb now comes first —
  `n8n-decanter <verb> [workflow…]`. Verb-last (`n8n-decanter wf123 push`) is no
  longer accepted and errors with *unknown verb*. Because everything after the
  verb is an argument, a workflow named like a verb needs no special handling:
  `n8n-decanter status push` runs `status` on the workflow named `push`. Flags
  may still appear in any position.
- **Breaking: node operations moved under a `node` namespace.** `add` →
  `node create <workflow> "<Node name>"`, the two-name node rename →
  `node rename <workflow> "<old node>" "<new node>"`, and `run <node-file>` →
  `node run <node-file>`.
- New workflow folders are **kebab-case** (`Order Sync` → `workflows/order-sync/`)
  instead of keeping spaces and capitals. **Existing folders are left untouched**
  and still resolve as refs — no migration, no churn.
- A workflow folder **no longer follows a remote rename**. The folder is a stable
  local slug; the always-current display name lives in `.decanter.json` (see
  Added). Renaming a workflow (locally or on the server) never moves your folder.

### Added

- **`data-tables` verb** — a read-only fetch of n8n **data-table** schemas and
  rows (the built-in project-scoped tables, n8n ≥ 2.x) into a top-level,
  gitignored `data-tables/<table>/{meta,columns,rows}.json` dir, for developing
  and debugging against real table contents offline. `--filter '<json>'`,
  `--search`, and `--sort` pull only a slice of a large table server-side (the
  applied filter is recorded in each table's `meta.json`); `--limit`/`--all`
  control page size and exhaustion. It never writes a data table.
  `data-tables clean` removes the dir (offline). Gated by the new **`dataTables`**
  config key (default `true`); when off, the fetch refuses and the recommended
  key needn't carry the data-table read scopes (`dataTable:list`,
  `dataTable:read`, `dataTableColumn:read`, `dataTableRow:read`).
- `.decanter.json` now caches the workflow's display **`name`** (refreshed on
  every pull), so the picker, `list`, and ref-resolution show the real name even
  though the folder is a kebab slug — and keep working if `workflow.json` is
  missing or corrupt.
- **`list --json`** emits `[{ name, id, dir }]` for tooling (remote-only
  workflows under `--remote` have `dir: null`).
- **No-ref → picker.** A ref-taking verb given no workflow, on a terminal, opens
  the interactive picker to choose one and runs the verb on it. Piped/non-TTY
  runs keep the config-default / error behavior, so scripts and CI never block.
- **`simulate` now replays single-iteration loops.** A workflow whose only
  repeated node is a `splitInBatches` ("Loop Over Items") driver that ran a
  single batch — it runs twice (one batch pass + the final "done" pass) while
  every other node ran once — no longer hard-errors. The loop driver executes
  for real to reproduce the loop, and each node's one captured run pins exactly.

### Removed

- **Breaking: `rename --workflow` flag.** Workflow rename is now the single
  top-level form `rename <workflow> "<new name>"`; node rename lives under
  `node rename`.

## [0.4.5] - 2026-07-21

### Added

- **`simulate` in the interactive picker.** The verb menu for a pulled workflow
  now offers `simulate` alongside status/pull/push/watch/check/executions; it
  runs against the workflow's newest capture.
- **Open a simulation run in the n8n webapp.** In an interactive terminal,
  `simulate` prints a **URL** to the run in a kept-alive local n8n (plus the
  throwaway instance's login) — pure nodes' real output and the pinned nodes,
  node-by-node in the actual execution inspector. No flag, no extra step; a
  fresh viewer replaces the previous one each run (`docker rm -f
  decanter-sim-viewer` to stop it). Scripts, `--json`, and `--network-none`
  runs stay headless and print no URL, so CI is unaffected.

### Changed

- **`simulate` no longer requires `--execution`.** With the flag omitted it
  defaults to the **newest capture** in the workflow's `executions/` dir, so
  `n8n-decanter <ref> simulate` works right after an `executions` fetch (and
  lets the picker offer it). Pass `--execution <id>` to pick a specific one.

## [0.4.4] - 2026-07-21

### Changed

- **The generated `.claude/settings.local.json` pre-approves more safe verbs.**
  `rename`, `list`, `executions` (incl. `executions clean`), `completion`, and
  `help` — plus a bare `status` — now run without a permission prompt, matching
  the "offline, safe" and "reads remote, no writes" tiers documented in the
  sync-dir `AGENTS.md`. Mutating/destructive verbs (`push`, `pull`, `watch`,
  `publish`, `unpublish`, `create`, `duplicate`, `simulate`, `delete`) still
  prompt, and `delete --force` is now hard-denied alongside `push --force`.

## [0.4.3] - 2026-07-21

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
