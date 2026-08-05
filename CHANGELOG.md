# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Added

- **`scenario create <workflow> "<slug>" --extend`** — top an **existing**
  scenario up with the pinnable nodes it is missing, keeping every value already
  authored. Previously `scenario create` refused an existing file outright, so a
  scenario `test` rejected could only be fixed by hand-editing raw JSON for nodes
  the tool had never named. Also covers the ordinary case of a workflow that
  gained a node after its scenario was written.

### Changed

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

### Fixed

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
