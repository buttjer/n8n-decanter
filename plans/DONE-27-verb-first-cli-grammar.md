# Plan 27 — Verb-first CLI grammar, node namespace, kebab folders

**Priority:** P2 (high-value UX + consistency; a **breaking** grammar change
plus a small additive data-model field — a real design pass, one coordinated
release)
**Status:** Done (2026-07-21) — all tasks shipped: verb-first parser + `node`
namespace, no-ref → picker (incl. the executions hook), kebab/sticky folders,
`.decanter.json.name`, single-form `rename`, `list --json`, grouped usage,
completion, and the full docs sweep. Verified green across unit/e2e/proxy/
interactive + the Docker smoke matrix (2.30.7 / 2.31.0 / 2.31.4). The Non-goals
below remain deferred by design.
**Theme:** Make the CLI read the way people expect. **Verb comes first**
(`n8n-decanter <verb> <workflow…>`), node operations move under a **`node`
subcommand namespace** (`node create` / `node rename` / `node run`), a
ref-taking verb with **no ref drops into the picker** on a terminal, new
workflow folders become **kebab-case** while the **human-readable name is cached
in `.decanter.json`**, and the whole surface is documented with **one consistent
placeholder vocabulary** and **terse, grouped one-line descriptions**.
**Model:** Opus for the parser/grammar break + folder/name correctness
(ref-resolution, collision, round-trip); Sonnet for the docs sweep and test
rewrites.

## Why

Three papercuts, all user-raised (2026-07-21), that compound because they share
the same surface:

- **Grammar is verb-*anywhere*** ([n8n-decanter.mts:157-160](../n8n-decanter.mts#L157-L160)):
  the first token matching a known verb wins, so `push wf123` and `wf123 push`
  are equal. That flexibility *creates* the foot-gun documented three times over
  — *"a workflow named like a verb must be addressed by id"*
  ([n8n-decanter.mts:88-90](../n8n-decanter.mts#L88-L90),
  [README.md:165](../README.md), [docs/cli/overview.md:51](../docs/cli/overview.md)).
  Verb-first (`positional[0]`) is what every other CLI does, and it makes the
  foot-gun **disappear for free**: with the verb pinned to slot 0, everything
  after it is unambiguously an argument, so `status push` just means *run
  `status` on the workflow named `push`*.
- **No ref is a dead end, not a doorway.** A bare verb (`n8n-decanter push`)
  today either processes every `config.workflows` entry or errors with *"no
  workflow ids"* ([n8n-decanter.mts:352-353](../n8n-decanter.mts#L352-L353)).
  The picker already exists ([lib/picker.mts](../lib/picker.mts)) and is exactly
  what a human wants here — but it only opens on a *bare* invocation. A verb with
  no ref, on a terminal, should show the list.
- **Folders aren't git-friendly and the docs can't name a token.** Workflow
  folders are `sanitizeFilename(wf.name)`
  ([lib/pull.mts:28](../lib/pull.mts#L28) → [util.mts:73](../lib/util.mts#L73)),
  which keeps **spaces and capitals** — `workflows/Order Sync/`. Only `code/*.js`
  node files are kebab. And the help/README/docs mix `<ref>`, `[ref...]`,
  `<id>`, `<node>`, `<node-file>`, `<name>` with no legend, so a reader can't
  tell a *workflow* id from an *execution* id from a *node* name — and the usage
  block is a dense multi-line wall ([n8n-decanter.mts:44-95](../n8n-decanter.mts#L44-L95)).

## Source

- User request (2026-07-21): verb-first; no-ref → picker; disambiguate
  `<ref>`/`<id>` in all docs; shorten + group the README/help descriptions;
  kebab-case workflow folders with the human name stored in `.decanter.json`;
  a `node` subcommand namespace for node operations.
- Decisions taken with the user before writing this plan (2026-07-21):
  1. **Verb-first is a hard break** — the verb is `positional[0]`; verb-last
     (`wf123 push`) stops parsing.
  2. **`node <verb>` subcommand namespace** — `add` → `node create`, the
     two-name node rename → `node rename`, `run` → `node run`. Parser
     special-cases `positional[0] === "node"` (real verb is `positional[1]`).
     This *dissolves* the `rename` overload: workflow rename stays top-level and
     single-form, node rename lives under `node`.
  3. **`rename` is one top-level form** — `rename <workflow> "<new name>"`. The
     `--workflow` flag is removed; there is no `--dir` / local-slug override.
  4. **`<workflow>`** is the one placeholder for a workflow argument — id ·
     name · unique name-prefix · **folder name** (all already resolvable).
  5. **No-ref behavior is TTY-split** — a ref-taking verb with no ref opens the
     picker on a terminal, and keeps today's `config.workflows` default (or
     error) when piped / non-TTY, so scripts and LLM harnesses never block.
  6. **Folders are a free local pick.** Since the folder basename is already an
     addressable ref ([lib/state.mts:117](../lib/state.mts#L117)), *any* folder
     name resolves — so **new** folders get a kebab slug, **existing** folders
     are left untouched (no forced migration, no churn), and folders are **not**
     auto-renamed when the workflow is renamed remotely. The always-current
     display name lives separately in `.decanter.json.name`.
  7. **The one required data-model change is `.decanter.json.name`** — patched
     from `wf.name` on the next pull; the picker/`list`/ref-resolution read it.
     No `localName`, no `rename --dir` — dropped as over-engineering for a
     single-user, free-pick slug.
- Related: [Plan 19](DONE-19-interactive-workflow-picker.md) (the picker this
  reuses), [Plan 11](DONE-11-cli-look-and-feel.md) (name resolution / `list` /
  completion this touches). Backlog note *"id-first data model"*
  ([BACKLOG.md](BACKLOG.md) L241) stays accurate — ids remain the identity;
  this plan changes *presentation and grammar*, not identity.

## Design decisions

- **The verb is `positional[0]`, full stop.** After flags are filtered out of
  the positionals (already done, [n8n-decanter.mts:155](../n8n-decanter.mts#L155)),
  `command = positional[0]`; drop `verbIndex` and the verb-anywhere `findIndex`.
  An unrecognized `positional[0]` errors with *"unknown verb: X"* + usage (never
  treated as a possible workflow).
- **`node` subcommand namespace.** When `positional[0] === "node"`, the real
  verb is `positional[1]` (`create` · `rename` · `run`) and the rest are its
  arguments. Workflow commands stay verb-first; the node namespace is a
  contained parser exception. Mapping from today: `add` → `node create`,
  `rename <workflow> "<old>" "<new>"` → `node rename <workflow> "<old>" "<new>"`,
  `run <node-file>` → `node run <node-file>`.
- **Placeholder vocabulary** (used verbatim in help, README, `/docs`):
  | Token | Means |
  | --- | --- |
  | `<workflow>` / `[workflow…]` | a workflow: id · name · unique name-prefix · folder name |
  | `<node>` | a node **name** (`node rename`, `node create`) |
  | `<node-file>` | a path to a node source file (`node run`) |
  | `<execution-id>` | an n8n execution id (numeric) — `simulate --execution`, `executions <execution-id>` |
  | `<name>` | a new literal name (`create`, `duplicate`, `rename`) |
- **Command grouping** (drives both `usage()` and the docs `## Commands`):
  - **Setup** — `init`, `completion`
  - **Sync** — `pull`, `push`, `watch`, `publish`, `unpublish`
  - **Workflow lifecycle** — `create`, `duplicate`, `delete`,
    `rename <workflow> "<new name>"`
  - **Inspect & test** — `status`, `check`, `executions [clean]`,
    `simulate [--pin]`, `list`
  - **Node** — `node create <workflow> "<Node name>" [--ts]`,
    `node rename <workflow> "<old node>" "<new node>"`,
    `node run <node-file>`
  - Bare `n8n-decanter` (picker) and `help` are noted above the groups, not in
    one. (`check` is offline but groups by *intent* under Inspect & test.)
- **No-ref → picker, TTY only.** For the pure ref verbs (pull, push, status,
  check, watch, publish, unpublish, delete, simulate) — **and `executions`,
  whose no-ref hook is separate** (it's not in `REF_VERBS`; see task 2) — with
  no workflow argument: on a TTY with a loaded config, open the picker to select
  **one** workflow, then run the verb on it (the verb is known, so the picker's
  verb menu is skipped). Non-TTY keeps the config-default / error path exactly
  as today. Multi-select for the `[workflow…]` batch verbs is a **follow-up**,
  not this plan.
- **Folders: kebab for new, sticky for existing, name cached in state.**
  - `.decanter.json` gains `name: string`, refreshed from `wf.name` on every
    pull. Picker / `list` / ref-resolution read it (no `workflow.json` parse;
    robust when it's missing/corrupt).
  - `ensureWorkflowDir`: an **existing** folder for the id is kept as-is (no
    rename — folders are a stable local pick). A **new** folder is
    `kebabCase(wf.name)`; if that slug is already taken by a *different*
    workflow, fall back to `${slug}-${id.slice(0,8)}` (the same suffix node
    files use, [lib/pull.mts:56](../lib/pull.mts#L56)) and **warn**. No
    interactive prompt — pull stays script-safe.
  - Consequence: the folder no longer follows a remote workflow rename; the
    current *"the folder follows on the next pull"* behavior
    ([lib/rename.mts:151](../lib/rename.mts#L151)) is retired. `renameWorkflow`
    updates `workflow.json` **and** `state.name` for immediate local
    consistency; the folder is left alone.

## Tasks

1. **Verb-first parser + `node` namespace (hard break).**
   [n8n-decanter.mts](../n8n-decanter.mts) `main()`: `command = positional[0]`;
   delete the verb-anywhere `verbIndex` logic; unknown `positional[0]` →
   *"unknown verb"* + usage, exit 1. Add the `node` dispatch: `positional[0] ===
   "node"` → sub-verb from `positional[1]` (`create`/`rename`/`run`), routed to
   the existing `addCodeNode` / `renameNode` / `runNode` handlers. `node run`
   stays in the pre-config offline block; `node create`/`node rename` stay
   offline (config, no credentials). Keep flags-anywhere. Bare-invocation picker
   gate still fires on *no positional at all*.
2. **No-ref → picker (TTY).** Factor the picker "choose one workflow" step out
   of `pickerLoop` so `dispatch` can call it. When a ref verb has no workflow
   argument, `process.stdin/stdout.isTTY`, and config is loaded → run the
   picker, take the chosen id as the single ref; otherwise fall through to
   today's `config.workflows` default / error. Add a single-select mode to
   `runPicker` (Enter on a pulled workflow resolves straight to `{ id }`, no
   verb menu). Piped/non-TTY path unchanged. **`executions` is not in
   `REF_VERBS`** — it also accepts a numeric `<execution-id>` and `clean`, so it
   resolves refs in its own `case`; give it the same no-ref picker hook
   explicitly (the picker still picks a *workflow*, leaving the exec-id / `clean`
   branches untouched).
3. **`.decanter.json` display name.** [lib/types.mts](../lib/types.mts)
   `DecanterState`: add `name?: string`. [lib/pull.mts](../lib/pull.mts): write
   `state.name = wf.name` every pull. [lib/state.mts](../lib/state.mts)
   `listWorkflowRefs`: prefer `state.name` for display (fall back to
   `workflow.json` → folder), and dedupe `state.name` + folder basename into
   `names` so `matchWorkflowRef` still resolves both.
4. **Kebab new folders, sticky existing.** [lib/pull.mts](../lib/pull.mts)
   `ensureWorkflowDir`: existing folder → return as-is (drop the
   rename-on-mismatch branch); new folder → `kebabCase(wf.name)` + `-<id8>`
   collision suffix + warn. [lib/rename.mts](../lib/rename.mts) `renameWorkflow`:
   update `state.name` alongside `workflow.json`; drop the "folder follows"
   message. Verify existing folders (spaces/caps) still resolve unchanged.
5. **`rename` simplification.** [n8n-decanter.mts](../n8n-decanter.mts) `rename`
   case: single form `rename <workflow> "<new name>"` → `renameWorkflow`; remove
   the `--workflow` flag and its plumbing (`workflowFlag`). The node-rename form
   moves to `node rename` (task 1).
6. **`list --json`.** [n8n-decanter.mts](../n8n-decanter.mts) `list` case: emit
   `[{ name, id, dir }]` under `--json` for agents; human format unchanged.
   Wire `--json` into the existing flag plumbing (already parsed).
7. **Shorten + group `usage()`** — one terse line per verb using the new
   vocabulary, laid out in the five groups from *Design decisions* (Setup ·
   Sync · Workflow lifecycle · Inspect & test · Node). Move the inline prose into
   the per-verb `/docs/cli/*` pages. Drop the "named like a verb" caveat
   (obsolete after task 1).
8. **Docs sweep (PR acceptance criterion).** Apply verb-first + `node` namespace
   + vocabulary + no-ref-picker + kebab-new-folders across
   [README.md](../README.md) (`## Commands` + feature bullets), every page under
   [docs/cli/](../docs/cli/) (rename `add.md`→`node-create` etc., `run.md`,
   `rename.md`) and the affected [docs/concepts/](../docs/concepts/) pages (esp.
   `sync-layout.md` for the folder + `.decanter.json.name` change), and
   [docs/cli/overview.md](../docs/cli/overview.md) (rewrite "Workflow refs" + the
   command block). Grep every verb across README/docs/CHANGELOG per the
   CLAUDE.md checklist. Update [PLAN.md](../PLAN.md) (grammar, folder naming,
   `.decanter.json` shape).
9. **Completion.** [n8n-decanter.mts](../n8n-decanter.mts) `__complete`: add
   `node` + its sub-verbs to the candidate set **and drop `--workflow`** (removed
   in task 5) from the completion flag list
   ([n8n-decanter.mts:208](../n8n-decanter.mts#L208)); confirm the scripts still
   make sense with verb-first (verbs in slot 0, workflow names/ids after).
10. **Test rewrites.** e2e ([test/e2e.mts](../test/e2e.mts)), proxy,
    interactive, and unit suites invoke verb-last and `add`/`run`/`rename …` in
    many places — sweep them to verb-first + `node` namespace. Add unit coverage
    for: verb-first parsing (incl. workflow-named-like-a-verb now resolving), the
    `node` sub-dispatch, kebab **new** folders + collision suffix + existing
    folders left untouched, `state.name` round-trip + resolution, and
    `list --json`. Add an interactive-suite case for no-ref → picker → verb.

## Acceptance / verification

- `n8n-decanter <verb> <workflow>` is the only workflow grammar; `n8n-decanter
  <workflow> <verb>` errors with *"unknown verb"*. A workflow literally named
  `push`/`status` is addressable with no special rule.
- `node create` / `node rename` / `node run` cover what `add` / node-`rename` /
  `run` did; workflow `rename <workflow> "<new name>"` has no `--workflow` flag.
- On a terminal, `n8n-decanter push` (no ref) opens the picker and runs `push`
  on the chosen workflow; piped/CI `n8n-decanter push` keeps the
  `config.workflows` default / error unchanged.
- A fresh pull writes `workflows/<kebab>/` and `.decanter.json.name`; an
  existing `workflows/Order Sync/` is **left as-is** on the next pull and simply
  gains `name` — and still resolves as a ref. Two new workflows that kebab to
  the same slug produce `<slug>/` + `<slug>-<id8>/` with a warning.
- Every workflow is resolvable by id, name, unique prefix, and folder name;
  `list --json` emits valid JSON.
- Help, README, and all `/docs` use one placeholder vocabulary, one terse
  grouped line per verb, and no "named like a verb" caveat. `npm test` +
  `npm run typecheck` green. The `/verify` skill (CLI-surface smoke) run against
  the new grammar.

## Non-goals

- **Multi-select in the picker** for the batch (`[workflow…]`) verbs — the
  natural follow-up to task 2, not shipped here.
- **Node-level picker** for `node run`/`node create`/`node rename`/`simulate
  --pin` (pick a workflow *then* a node) — larger; future.
- **Migrating existing folders to kebab** — deliberately not done; existing
  folders resolve as-is and a hand-rename resolves too.
- Changing workflow **identity** — ids stay authoritative; this is presentation
  + grammar only.
- The folder-hierarchy work ([Plan 8](BLOCKED-8-folder-hierarchy-in-sync-layout.md))
  — independent; kebab-casing the leaf folder doesn't touch n8n folder mirroring.

## Rollout

- **One coordinated breaking release.** Grammar + node namespace land together
  so users adjust once. Bump per CLAUDE.md (0.x breaking → **minor**).
- **CHANGELOG** — three **Breaking:** entries under `[Unreleased]`:
  1. Verb-first grammar (verb-last removed).
  2. `node` subcommand namespace — `add` → `node create`, `run` → `node run`,
     node rename → `node rename <workflow> "<old>" "<new>"`.
  3. `rename --workflow` removed — workflow rename is `rename <workflow>
     "<new name>"`.
  Plus **Changed:** new workflow folders are kebab-case (existing folders
  unchanged, still resolve); **Added:** `.decanter.json.name` (cached display
  name), `list --json`, no-ref picker on a terminal.
- **No migration step.** Existing folders keep working; the only on-disk change
  on upgrade is the additive `name` field appearing on the next pull.

## Notes

- **PLAN.md implications:** the data-model section gains `.decanter.json.name`;
  the folder-naming rule becomes *kebab for new, stable/sticky thereafter* (no
  longer "the folder follows the workflow name"); the grammar description
  becomes verb-first with a `node` subcommand namespace — update in the same PR.
- Caching `wf.name` in `.decanter.json` also hardens `list`/picker against a
  missing or corrupt `workflow.json` (today [listWorkflowRefs](../lib/state.mts#L112)
  swallows a parse failure and falls back to the folder name — now it has a
  cached name).
- The collision suffix mirrors the node-file strategy (`-<id8>`) so the two
  layers stay consistent.
