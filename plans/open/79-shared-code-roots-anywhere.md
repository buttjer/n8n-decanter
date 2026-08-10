# Plan 79 — Shared code lives anywhere in the sync dir

**Status:** In progress — PR 1 (Tasks 1–6, the P1 core incl. the task-4
realpath fix and its typecheck-scope sibling) merged 2026-08-10 (#248); PR 2
(Task 7, the warnings split) built 2026-08-10 — **merge gated on the blind
field-test round** (Decision 4; the round needs this branch's build to run
against)
**Priority:** P1 (Tasks 1–5, one PR) / P2 (Task 7 — the warnings split, its own PR with its own decision record)
**Source:** User question 2026-08-09 — *"Ist es möglich den Pfad zum shared
Ordner zu verändern oder sogar mehrere zu haben?"* — plus the follow-up *"wie
verhält sich das bei 2 gleichnamigen Dateien aus 2 Ordnern?"*. Drafted
evidence-first; **validated and re-scoped 2026-08-10** (see Why / Decisions).
**Snapshot:** 2026-08-10T11:25Z @ d65a28d
**Theme:** `shared/` is a scaffolding convention, not a data-model element —
document the real rule (imports stay inside the sync dir), fix the two real
bugs the investigation surfaced, and split the contested import-rule downgrade
into its own gated PR.
**Model:** Sonnet for Tasks 1–5 (well-specified breadth); Opus for Task 7
(design + decision record)

Renaming `shared/`, several shared roots, and per-workflow helper dirs all
**work today** — the only enforced rule is that a relative import resolves
inside the sync dir. What is actually broken sits around that fact:
`preflight`'s types tier is blind to every shared file (grades green on code
`push` rejects), the documented import snippet doesn't resolve, module labels
are machine-dependent under a symlinked project path, and the term the rule is
stated in ("sync dir") is used 19× in `/docs` and defined nowhere. Fix those
now (P1). Downgrade only the two *path-shaped* import rules to warnings in a
separate, field-test-gated PR (P2); the builtin block stays; the rename is
dropped.

## Why — findings, all verified 2026-08-10

Every finding was independently reproduced in a 12-agent validation pass (the
in-file repro script executed end-to-end, all ~28 code citations checked
against `d65a28d`, counts re-measured, the F7 determinism and F7c symlink
claims re-measured from scratch), followed by a 4-lens worth assessment
(field-test empirics, product value, risk, opportunity cost). **The draft
revision of this file (git history, pre-2026-08-10) carries the full
one-command repro script and the evidence essays** — collapsed here per the
draft's own graduation rule. The durable facts:

| # | Finding | Status |
| --- | --- | --- |
| F0 | A renamed root, a second nested root, and a per-workflow helper dir all bundle — in one node, at once; escaping the sync dir is a hard layout error (F0b) | verified |
| F1 | `preflight`'s `types` tier drops every diagnostic in shared code; `push` (unscoped) catches it — **the gate lies** | verified |
| F2 | The `../../shared/money` snippet in the docs is one level short for the `code/` layout — copy-paste fails | verified |
| F3 | The tsconfig `include` globs `shared/**` only; other helper roots are typechecked only when imported | verified (read) |
| F4 | Two same-named helpers under the **same** binding: esbuild silently lets the last one win; only the typecheck (TS2300) catches it | verified |
| F5 | Aliased, they bundle side by side; esbuild renames the clash `total` → `total2`; module labels are sync-root-relative | verified |
| F6 | "sync dir" appears 19× in `/docs`, is defined nowhere, and `docs/concepts/sync-layout.md` — the page whose job it is — never uses the term | verified |
| F7 | An out-of-root **relative** import compiles byte-identically at two unrelated checkout depths — the boundary does not protect hash determinism | verified, **with a caveat: only for symlink-free project paths** (see Task 4) |
| F7b | The sync dir has nothing to do with git — `loadConfig` never consults it; a gitignored dir inside the sync dir passes the guard | verified |
| F7c | A symlinked/`file:` package resolving **outside** the repo yields machine-dependent module labels (esbuild realpaths it) — the one genuinely unstable case, and nothing checks it | verified |

Mechanism facts the tasks depend on (all citations verified at `d65a28d`):

- The single boundary rule lives in `checkNodeImports`
  ([lib/compile.mts:146-152](../../lib/compile.mts#L146-L152)): a `./`/`../`
  specifier must resolve at or under `ctx.syncRoot` (the dir holding
  `decanter.config.json`, found by upward search —
  [lib/config.mts:58-64](../../lib/config.mts#L58-L64),
  [lib/compile.mts:108-128](../../lib/compile.mts#L108-L128)). Bare specifiers
  are screened for **builtins first** ([lib/compile.mts:144](../../lib/compile.mts#L144)
  — including unprefixed `fs`/`crypto`) and then for `bundleDependencies`
  membership; **never for where they resolve** (that is F7c's hole).
- All four import-rule complaints funnel through one `errors.push` in the
  compliance guard ([lib/validate.mts:71](../../lib/validate.mts#L71)) and one
  pre-esbuild throw in `compileTs`
  ([lib/compile.mts:184-187](../../lib/compile.mts#L184-L187)).
- `preflight` scopes the typecheck to the workflow dir
  ([lib/preflight.mts:308](../../lib/preflight.mts#L308),
  [scripts/typecheck.mts:52-57](../../scripts/typecheck.mts#L52-L57)); `push`
  runs it unscoped ([n8n-decanter.mts:589](../../n8n-decanter.mts#L589)). That
  asymmetry is F1. `runTypecheckPerDir`
  ([lib/validate.mts:401-425](../../lib/validate.mts#L401-L425)) additionally
  drops a path-carrying diagnostic that matches no workflow dir.
- `absWorkingDir` is the sync root
  ([lib/compile.mts:216-217](../../lib/compile.mts#L216-L217)), which is what
  makes module labels machine-independent — **but nothing realpaths
  `syncRoot`**, so a symlink in the project path leaks machine-specific labels
  into the bytes (measured: two depth-copies hashed differently via a `/tmp`
  symlink alias, identically via the realpath). Task 4 closes this.
- esbuild is **silent** about a builtin import: no error, no warning, a
  `__require("node:fs")` shim ships and fails at runtime on the instance —
  the worst place. Verified, and the reason rule 1 keeps blocking (Decision 1).
- `preflight` **discards `compileTs` warnings**
  ([lib/status.mts:113-118](../../lib/status.mts#L113-L118)) and its `parity`
  check reads only `n.state` — a compile-time warning cannot surface in
  `preflight` and is not gateable by `--fail-on=warn` without new plumbing.
  This killed the old Task 7 as specced (see Deferred).
- Two docs asymmetries, correct but undocumented: auto-commit is
  pathspec-scoped to the workflow folder
  ([lib/git.mts:44](../../lib/git.mts#L44)); `watch` observes only the
  workflow dir and its `code/`
  ([lib/watch.mts:116-126](../../lib/watch.mts#L116-L126)).
- Field-test empirics (all archived rounds, measured 2026-08-10): **the four
  import rules fired zero times; no blind agent ever wrote an import in a node
  file; no scenario exercises shared code.** `preflight` is the single
  most-exercised verb in the archives, and agents provably follow
  `template/AGENTS.md.example` near-verbatim — which is why F1 and F2 are the
  high-value fixes and the behavioral changes carry no empirical urgency.

## Decisions (maintainer, 2026-08-10 — supersede the 2026-08-09 in-draft decisions)

1. **The import-rule downgrade is split, not blanket.** Rules 2 (relative
   import leaving the sync dir) and 3 (absolute path) become warnings — F7
   measured their determinism rationale away, and esbuild fails loudly where
   it matters. **Rule 1 (Node builtins) stays a hard error**: nobody is
   unblocked by downgrading it (there is no legitimate `import fs` in a
   bundled Code node), its failure is invisible at build time and surfaces at
   runtime on the instance, `watch` saves run no typecheck, and every publish
   gate checks only dangling refs — nothing else stands between a warned-past
   shim and production. Every other agent-facing guard in this repo fails
   closed for the same reason. **Rule 4 (unlisted packages) is decided in Task
   6's PR** — its real question is the `bundleDependencies` consent model
   (silent inlining below the size warning), not strictness.
2. **The rename is dropped; the term stays "sync dir" and gets defined.** F6's
   own analysis says the confusion's root is the *missing definition*, not the
   name. One well-linked definition captures the user value at ~5 % of the
   churn; "project root" collides with the npm/tsconfig/repo meanings (in the
   monorepo shape this plan blesses, the decanter root is precisely *not* the
   repo root); and two-term coexistence would be permanent anyway (CHANGELOG,
   `plans/done/`, field-test archives, every already-initialized sync dir).
   For the record: the true rename scope was **~87 sites, not 79** — the
   draft's 49-count silently excluded 8 occurrences in live plans
   (`open/24`, `open/30`, `blocked/8`, `draft/72`, `draft/73`).
3. **The metafile warning (old Task 7) is deferred** — see Deferred.
4. **Task 7 is gated on a blind field-test round against a warnings build.**
   The archives show agents recover from *blocking* errors in one hop; there
   is zero data on whether they heed warnings. The repo owns the
   infrastructure to measure exactly that (`test/field-test/`) — run one round
   before the downgrade merges, and let the result inform rule 4's decision.

Carried over unchanged from 2026-08-09: **no config key** (no `sharedDirs` —
esbuild resolves anything inside the sync root whether or not a key names it,
so a key could never be authoritative), and **git is not a dependency** of the
import rule (auto-commit is already switchable off via `commitOnPush` /
`commitOnPull`).

## Tasks

### PR 1 — the P1 core (one PR; docs land with the code, per the AGENTS.md same-PR rule)

1. **Fix the `types` blind spot (F1 — the most important bug).**
   - `scripts/typecheck.mts` — in `inScope`, a file that is **not** a node
     file (`isNodeFile()` at [scripts/typecheck.mts:73](../../scripts/typecheck.mts#L73),
     keyed on the `.decanter.json` sibling) and lives inside the tsconfig
     project dir is **always in scope**. Scoping exists to stop one workflow
     inheriting another workflow's *node* errors; shared code is common
     infrastructure. (Validated: `push` already fails on these today — this
     makes `preflight` converge on what `push` does, including for
     per-workflow helper dirs of *other* workflows, which is the fix working,
     not a leak.)
   - `lib/validate.mts` `runTypecheckPerDir` — a path-prefixed diagnostic
     whose resolved path matches **no** entry in `dirs` joins the `shared`
     bucket (attributed to every workflow) instead of being dropped.
   - Sanity-check `--require=`/`--fail-on=` and `--json` shapes when the same
     shared diagnostic appears under several workflows.
2. **Fix the broken import depth (F2).** `../../shared/money` →
   `../../../shared/money` in
   [docs/concepts/typescript-nodes.md](../../docs/concepts/typescript-nodes.md)
   and [template/AGENTS.md.example](../../template/AGENTS.md.example) (the two
   verified sites; a corpus grep found no others). Consider extending
   `npm run check:docs` with a relative-import depth assertion for fenced
   node-file examples — same class of copy-paste-broken snippet it already
   catches for verb-last commands.
3. **Widen the tsconfig `include` (F3).** In
   [tsconfig.json](../../tsconfig.json) and
   [template/tsconfig.json.example](../../template/tsconfig.json.example),
   replace the `shared/**` + `workflows/**` pair with a project-wide
   `**/*.ts` / `**/*.js` include; extend `exclude` (`node_modules`,
   `decanter-ts-plugin`, `**/*.remote.js`, `dist`, `**/backups/**`,
   `**/executions/**`). Existing sync dirs keep their scaffolded tsconfig —
   the changelog entry carries the one-line fix.
4. **Realpath the sync root (new — from validation).** `findBundleContext` /
   `compileTs` pass `syncRoot` un-realpath'd as `absWorkingDir`, so a
   symlinked project path (e.g. macOS `/tmp` → `/private/tmp`) yields
   machine-specific module labels and divergent hashes for every
   import-having node — exactly the ping-pong F7c describes, from a different
   door. `fs.realpathSync` at the boundary; no label changes for anyone whose
   path is already symlink-free.
5. **Document the actual rule (the core deliverable).** Organising idea:
   **rule vs. default** — `code/` is a rule
   ([lib/validate.mts:47](../../lib/validate.mts#L47)); `shared/` is a default
   with tooling attached (`init` scaffold, tsconfig glob, the
   `Edit(shared/**)` allowlist entry in
   [template/.claude/settings.json.example](../../template/.claude/settings.json.example)).
   - **Define the sync dir first (F6).**
     [docs/concepts/sync-layout.md](../../docs/concepts/sync-layout.md) opens
     one level too low: raise its tree to start at the sync dir and state the
     definition plainly — *the directory holding `decanter.config.json`;
     every verb finds it by searching upward, and it is the boundary imports
     may not cross* — explicitly **not** "your git root" (F7b). Audit the
     other 18 uses of the term for a first-mention link. One owning page, no
     glossary.
   - [docs/concepts/typescript-nodes.md](../../docs/concepts/typescript-nodes.md),
     "Shared code and npm packages": lead with the real boundary — *any
     folder inside the sync dir, any number of them; `shared/` is what `init`
     scaffolds*. Show the three working shapes, the two asymmetries
     (auto-commit pathspec, `watch`), and the F4/F5 same-name rule:
     **different folders never collide; identical binding names do** (aliased
     → side by side; unaliased → silent last-wins, caught only by the
     typecheck — also name the three unprotected paths: `node run`,
     `preflight --no-typecheck`, and a missing `typescript` install, where
     the typecheck is a logged skip). Document the npm route
     (`npm i file:../packages/x` + `bundleDependencies`) with the realpath
     caveat for targets outside the repo.
   - **[docs/cli/preflight.md](../../docs/cli/preflight.md)** — the canonical
     "what the compliance guard catches" list four other pages link to; it
     currently mentions none of the four import rules. Add them. *(Missing
     from the draft's surface list — found in validation.)*
   - [README.md](../../README.md) "Shared code and small libraries" bullet +
     comparison-table row, [docs/cli/push.md](../../docs/cli/push.md),
     [docs/cli/diff.md](../../docs/cli/diff.md): widen the `shared/` wording
     to "shared code anywhere in the sync dir (`shared/` by default)".
   - [template/AGENTS.md.example](../../template/AGENTS.md.example) "Shared
     code (`shared/`)" block: state the rule, keep `shared/` as the default,
     add the agent-facing line (*a helper folder under another name works;
     extend your editor/agent allowlist if you use one*). Per the root
     `AGENTS.md` agent-tooling rule the substance goes here; `CLAUDE.md.example`
     / the cursor rule stay pointers.
   - **Note:** the "compile errors" sentences
     (docs/concepts/typescript-nodes.md:70-72,
     template/AGENTS.md.example:305-307) stay accurate under the split —
     builtins and unlisted packages still error after PR 1 and (for rule 1)
     after Task 7 too. Task 7's PR rewords only what it changes.
   - `CHANGELOG.md` `[Unreleased]`, four entries: **Fixed** — `preflight`'s
     `types` check now reports type errors in shared helper files instead of
     passing green while `push` fails on them; **Fixed** — the documented
     shared-import path was one level short for the `code/` layout;
     **Fixed** — compiled module labels (and therefore sync hashes) are now
     stable when the sync dir is reached through a symlinked path;
     **Changed** — the scaffolded `tsconfig.json` covers the whole sync dir
     (existing sync dirs: widen `include` to `**/*.ts` / `**/*.js` to match).
6. **Tests (PR 1).**
   - Unit: `runTypecheckPerDir` attributes a non-workflow-file diagnostic to
     every workflow and a node-file diagnostic to its own dir only; a
     symlinked-path compile produces realpath'd labels.
   - e2e (extending the `bundle: shared/ value import` step): a node importing
     from a non-`shared` folder pushes a bundled body; a type error in that
     helper makes `preflight --offline` fail `types` (the F1 regression); two
     same-named helpers under aliased bindings bundle side by side with
     distinct labels.
   - `npm run check:docs` green (plus the depth assertion if Task 2 adopts it).

### PR 2 — Task 7: the warnings split (P2 — own PR, own decision record, field-test-gated)

> **Decision record (2026-08-10, built as `feat/plan-79-warnings-split`).**
> Rules 2 (out-of-sync-dir relative) + 3 (absolute path) → **advisory**
> (`ImportCheck.advisory`); rule 1 (builtins) stays **blocking** per
> Decision 1. **Rule 4 (un-opted-in packages) stays blocking pending the
> field-test round** — the round's data decides whether the
> `bundleDependencies` consent model can go advisory too; until then the
> conservative default holds. **De-dup:** the guard tier owns the printed
> line on every path that can reach a push (`buildNodeCode` passes
> `quietImportWarnings` from `push`, `backup`, and `test`'s
> local-differs hash compare — `test`'s push-local flow lands in
> `pushWorkflow`, whose `assertCompliant` prints it once); `compileTs`
> keeps emitting for `node run`, `diff`, and `simulate`, which run no guard
> tier. `--fail-on=warn` is preflight-only; push/watch have no strict knob
> for the advisory rules — that is the deliberate shape, recorded here.

7. **Downgrade rules 2 + 3 to warnings; keep rule 1 blocking; decide rule 4.**
   - Mechanics: with two severity classes, `checkNodeImports`' flat `string[]`
     return **does** need to distinguish blocking from warning complaints (the
     draft's "no severity needed" argument held only for the blanket flip).
     Still small: two lists or a tagged entry, consumed at
     [lib/validate.mts:71](../../lib/validate.mts#L71) and the
     [lib/compile.mts:184-187](../../lib/compile.mts#L184-L187) throw.
   - **De-dup decision (from validation):** after the flip, a push would print
     a downgraded violation twice — once via `assertCompliant`'s warning loop,
     once via `compileTs`' log — because `collectOps` compiles every tracked
     node ([lib/push.mts:110](../../lib/push.mts#L110)). Decide one channel
     (suppress the compile-time repeat for complaints the guard already
     reported is the obvious shape). Do **not** scope `folder.warnings` to the
     saved file in `watch` — that would suppress the folder-wide warnings
     #243 deliberately surfaces; a `warningsByFile` follow-up stays its own PR.
   - `--fail-on=warn` is the strict knob and is **preflight-only** — the
     decision record must own explicitly that push/watch have no strict mode
     for the downgraded rules.
   - **Prerequisite: one blind field-test round against a warnings build**
     (Decision 4), archived and graded like any round; its result feeds rule
     4's disposition.
   - **Re-derive the test-flip list for the split.** The draft's list was
     blanket-derived and is wrong for it: the builtin/unlisted assertions
     (`test/unit/compile.test.mts:158-164`,
     `test/unit/validate.test.mts:334-340`, `test/e2e.mts:1821-1836`) now
     **stay**; only out-of-root/absolute-path assertions flip. Two
     corrections that survive any variant: e2e has **three** exit-code
     asserts in that step (1829/1832/1836), not four — `:1837` is an
     `assert.match(/bundleDependencies/)` text check that survives; and
     `test/unit/validate.test.mts:327-331` (the `.js`-with-an-import error)
     is [Plan 24](24-shared-code-in-js-nodes.md)'s separate rule — leave it
     alone.
   - Doc + design-doc edits **in the same PR**, scoped to what changes:
     out-of-root/absolute wording in the Task 5 surfaces;
     `PLAN.md:555-562`'s *Errors* list moves only the out-of-root/absolute
     halves of "bundling violations in `.ts` nodes" to the *Warnings* list at
     `:564`; and the stale scoping sentence "shared `shared/*` helpers … are
     inlined" is in **`AGENTS.md:535`** (the draft's Note 1 pointed at
     PLAN.md's data-model section, where no such sentence exists — corrected
     in validation). `CHANGELOG.md`: **Changed** — imports leaving the sync
     dir and absolute-path imports now warn instead of blocking a push, with
     `preflight --fail-on=warn` as the strict variant.

## Deferred

- **Metafile warning for bare specifiers resolving outside the repo (old
  Task 7).** The mechanism is verified and cheap (`metafile: true`; inputs
  starting `../` whose importing edge carries a bare `original`), but as
  specced the warning is **invisible in `preflight`** (compile-time warnings
  are discarded — [lib/status.mts:113-118](../../lib/status.mts#L113-L118))
  and it **false-positives on the sanctioned route**: npm installs
  `file:../packages/x` as a symlink, esbuild realpaths it, and "same repo" is
  undecidable from inside the check once git is out (Decision, 2026-08-09).
  Revisit when (a) warning-visibility plumbing (`NodeSync.warnings` →
  preflight) is priced in, (b) the wording exempts the in-repo `file:` case,
  and (c) a multi-machine team actually exists — the field archives show zero
  precursor behavior. Until then the Task 5 docs caveat carries the value.
- **`syncRoot` identifier rename** (11 lines / 13 tokens, confined to
  `lib/compile.mts` + `test/unit/compile.test.mts`) — harmless someday-polish,
  worthless alone.

## Non-goals

- **No prose rename.** "sync dir" stays the term (Decision 2).
- **No config key** — see Decisions.
- **No new restriction.** The sync-dir boundary is the whole rule; nothing
  gains an allowlist of permitted helper roots.
- **No `watch` on shared roots.** Unchanged from
  [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)'s non-goal — a
  helper edit still syncs on the next save/push of an importing node. (The
  follow-up idea stands unfiled: derive the watched set from the import graph,
  never from config.)
- **No rename of the scaffolded folder.** `init` keeps scaffolding `shared/`;
  this plan makes it a *default*, not a *requirement*.
- **No change to bundling semantics** — each importing node still carries its
  own copy, byte-for-byte (Task 4's realpath only stabilizes labels that were
  machine-dependent, which is a bug fix, not a semantics change).
- **No F4 guard.** Silent last-wins under an unaliased duplicate binding is
  documented (Task 5), not guarded: TypeScript already names it precisely
  (TS2300), the typecheck tier keeps blocking `push`, and detecting it in
  `checkNodeImports` would need a real binding parser. Revisit only if a
  field-test round shows an agent walking into it.

## Acceptance / verification

PR 1:

- `preflight` fails the `types` check on a type error in a shared helper —
  under `shared/` and under any other folder name — naming the real file and
  line. No workflow is graded `ready` on code `push` will reject.
- The import snippets in `/docs` and `template/AGENTS.md.example` resolve when
  copy-pasted into a freshly `init`ed sync dir.
- A freshly scaffolded sync dir typechecks a helper folder named something
  other than `shared/` without editing `tsconfig.json`.
- Compiled bytes are identical whether the sync dir is reached via a symlinked
  or a real path.
- A node importing from two differently-named helper roots **and** a
  per-workflow helper dir pushes one self-contained body; `node run` executes
  it offline. Two same-named helpers under aliased bindings appear as two
  distinctly labelled modules in the pushed artifact.
- A reader landing on any page using "sync dir" reaches its definition in one
  click; `docs/concepts/sync-layout.md` states it;
  `docs/cli/preflight.md`'s guard list names the import rules.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

PR 2 (Task 7):

- An import escaping the sync dir, and an absolute-path import, **warn** and
  do not block; when the target is genuinely absent, bundling still fails
  loudly with esbuild's `Could not resolve`. A builtin import still errors.
- Each downgraded violation prints **once** per push (the de-dup decision).
- `preflight --fail-on=warn` exits non-zero on the downgraded rules; the
  decision record states that push/watch have no strict knob.
- A blind field-test round against the warnings build is archived + graded
  before merge; rule 4's disposition is recorded with it.
- `PLAN.md`'s guard lists and `AGENTS.md:535` match the shipped behavior.

## Notes

- **Validation record (2026-08-10).** 12-agent reproduction/citation/count/
  measurement pass + 4-lens worth panel, this session. Substantive corrections
  folded in above: the builtin screen on bare specifiers (the draft's "and
  nothing else" was wrong); `log?.warn` sits ~48 lines below the compile-mts
  hunk, not two; the e2e step has three exit-code asserts, not four; the
  rename scope was ~87 sites, not 79; the stale bundling-scope sentence lives
  in `AGENTS.md:535`, not PLAN.md; `docs/cli/preflight.md` was missing from
  the doc surfaces; the F7 determinism claim needs Task 4's realpath to be
  unconditionally true; the old Task 7 warning was invisible in preflight as
  specced.
- **[Plan 24](24-shared-code-in-js-nodes.md) inherits the split, not the
  blanket.** Bundled `.js` nodes will use the same `checkNodeImports` path.
  Under the split, Plan 24's "fail with the same messages as `.ts`" stays
  true for builtins/unlisted packages and becomes warn-shaped for
  out-of-root/absolute — its executor re-derives at execution time per the
  snapshot-drift rule; its `shared/`-worded docs tasks pick up Task 5's
  wording.
- **PLAN.md duty:** Task 5 rewords nothing in PLAN.md (the rule-vs-default
  framing is docs-level); Task 7's PR owns the PLAN.md guard-list move and
  the AGENTS.md:535 reword. If Task 7 never ships, neither sentence is stale.
