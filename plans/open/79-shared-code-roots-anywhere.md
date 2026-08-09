# Plan 79 — Shared code lives anywhere in the sync dir (make the convention explicit, fix the guards it exposed)

**Status:** Not started
**Priority:** P1 (small, offline, clearly-right: one real gate bug, one broken
docs snippet, one glob, and the documentation of a capability that already
ships)
**Source:** User question 2026-08-09 — *"Ist es möglich den Pfad zum shared
Ordner zu verändern oder sogar mehrere zu haben?"* Verified against the code and
a live scratch sync dir; closes the `shared/`-only wording in `PLAN.md`'s
bundling note and in [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)'s
docs surfaces.
**Snapshot:** 2026-08-09T11:44Z @ 59079bb
**Theme:** Renaming `shared/` and having several shared roots **already works** —
nothing in the CLI hardcodes the name. Say so, and repair the three surfaces
that quietly assume the single canonical folder.
**Model:** Sonnet (well-specified breadth; Task 1 is the only one that needs
care)

`shared/` is a *scaffolding convention*, not a data-model element: the only rule
`push` enforces is that a relative import resolves **inside the sync dir**. So
any folder name, any number of folders, and per-workflow helper dirs all work
today — undocumented, and with `preflight`'s typecheck blind to every one of
them (including `shared/` itself). This plan documents the real rule and fixes
the gate, the wrong import depth in the docs, and the `shared/**`-only tsconfig
glob.

## Why

### What was verified (2026-08-09, scratch sync dir + repo read)

**No code path hardcodes `shared/`.** The single constraint lives in
`checkNodeImports` ([lib/compile.mts:146-152](../../lib/compile.mts#L146-L152)):
a `./`/`../` specifier must resolve at or under `ctx.syncRoot` (the dir holding
`decanter.config.json`). Everything else about the folder is convention. Proven
by driving the real CLI against a scratch sync dir whose node file imported from
three differently-named roots at once:

| Shape | Import from `workflows/wf1/code/compute.ts` | Result |
| --- | --- | --- |
| Renamed root | `../../../helpers/strings` | ✅ bundles, `node run` executes |
| Second, nested root | `../../../domain/money/total` | ✅ bundles |
| Per-workflow helper dir | `../local/tag` | ✅ bundles; `preflight` says `layout compliant` |
| Escape the sync dir | `../../../../outside/x` | ✗ hard layout error, as designed |

The per-workflow case passes the compliance guard because the orphan/stray scan
only reads the folder root and `code/`
([lib/validate.mts:291-300](../../lib/validate.mts#L291-L300)) — sibling subdirs
are explicitly reserved for artifacts, so a helper dir next to `code/` never
trips it.

`shared/` therefore appears in exactly four places, none of them load-bearing:
`template/shared/example-helpers.ts` (what `init` scaffolds), the tsconfig
`include` globs, the `Edit(shared/**)` agent allowlist entry
([template/.claude/settings.json.example:6](../../template/.claude/settings.json.example)),
and prose.

### The three things that are actually wrong

**1. `preflight`'s `types` tier silently drops every diagnostic in shared code —
and `shared/` is affected exactly as much as a renamed folder.** `preflight`
calls `runTypecheckResult(configDir, [ctx.dir])`
([lib/preflight.mts:308](../../lib/preflight.mts#L308)), and
`scripts/typecheck.mts` filters reported diagnostics to those scope dirs
([scripts/typecheck.mts:52-57](../../scripts/typecheck.mts#L52-L57)). A shared
helper lives outside every workflow dir, so its errors are compiled and then
thrown away. Reproduced:

```
$ node scripts/typecheck.mts                       # unscoped
shared/strings.ts(2,9): error TS2322: Type 'string' is not assignable to type 'number'.
1 error(s)

$ n8n-decanter preflight wf1 --offline             # scoped to the workflow dir
  ✓ types     node files typecheck clean
```

`push` calls `runTypecheck(config.configDir, log)` **unscoped**
([n8n-decanter.mts:589](../../n8n-decanter.mts#L589)), so it *does* catch it.
That is the worst shape of the bug: **the gate passes and the action then
fails** — `preflight` exists precisely so that doesn't happen.

`runTypecheckPerDir` ([lib/validate.mts:378-402](../../lib/validate.mts#L378-L402))
has the same hole from the other side: it buckets file-less diagnostics as
"shared" and attributes them to every workflow, but a diagnostic **with** a path
that matches no workflow dir lands in neither `mine` nor `shared` and is
dropped.

**2. The documented import path is broken.** Both
[docs/concepts/typescript-nodes.md:56](../../docs/concepts/typescript-nodes.md)
and [template/AGENTS.md.example:357](../../template/AGENTS.md.example) show:

```ts
import { total, type OrderLine } from "../../shared/money";
```

From `workflows/<slug>/code/<node>.ts` that resolves to
`workflows/shared/money` — copy-paste it and push fails with
`Could not resolve "../../shared/money"` (verified). The correct depth is
`../../../shared/money`; the two-level form is a leftover from the pre-`code/`
flat layout retired in [Plan 27](../done/27-verb-first-grammar.md). The e2e and
smoke suites already use the three-level form, which is why no test caught it.

**3. The tsconfig `include` is a `shared/**`-only glob.** A helper folder under
any other name is still typechecked *if some node file imports it* (imports pull
it into the program), but an **unreferenced** file in it is never checked at all,
and the editor's tsserver doesn't own it. Same glob in
[tsconfig.json](../../tsconfig.json) and
[template/tsconfig.json.example](../../template/tsconfig.json.example).

### Two asymmetries that are correct but undocumented

- **Auto-commit is pathspec-scoped to the workflow folder**
  ([lib/git.mts:44](../../lib/git.mts#L44)) — a top-level shared edit is *not*
  auto-committed by pull/push, while a per-workflow helper dir *is* (it's inside
  the pathspec). Both behaviors are right; the user has to be told.
- **`watch` observes only the workflow dir and its `code/`**
  ([lib/watch.mts:116-126](../../lib/watch.mts#L116-L126)) — editing a shared
  helper does not re-push its importers. This is Plan 14's stated non-goal and
  still holds; it just isn't written down anywhere a user reads.

## Design decision — convention, not configuration

**No new `decanter.config.json` key** (no `sharedDirs`, no `sharedRoot`).

esbuild resolves *anything* inside the sync root whether or not a config key
names it, so such a key could never be authoritative — it would be a second
source of truth that silently disagrees with what `push` actually bundles, and
the only way to make it authoritative would be to add a **new restriction**
(reject imports outside the listed roots) that nobody asked for and that would
break the per-workflow shape that works today.

Config keys are for choices the CLI must make. "Where do my helpers live" is not
one: the import specifier already says it, per file. The deliverable is that the
rule is **stated** ("inside the sync dir") instead of implied ("`shared/`").

The one place a set of roots would genuinely buy something is a future
`watch` that re-pushes importers on a helper edit — and even there the roots
should be *derived* from the import graph (`scanNodeImports` already yields the
specifiers), not configured. Filed as a draft, out of scope here.

## Tasks

1. **Fix the `types` blind spot (the only real bug).**
   - `scripts/typecheck.mts` — in `inScope`, a file that is **not** a node file
     (`isNodeFile()` is already defined at line 73, keyed on the
     `.decanter.json` sibling) and lives inside the tsconfig project dir is
     **always in scope**. Scoping exists to stop one workflow inheriting
     another workflow's *node* errors; shared code is common infrastructure and
     belongs to everyone. This mirrors the existing "file-less diagnostics are
     reported unconditionally" rule right above it.
   - `lib/validate.mts` `runTypecheckPerDir` — a path-prefixed line whose
     resolved path matches **no** entry in `dirs` joins the `shared` bucket
     (attributed to every workflow) instead of being dropped. Two lines: widen
     the `shared` filter, or compute it as "not owned by any dir".
   - Sanity-check the `--require=`/`--fail-on=` and `--json` shapes still make
     sense when the same shared diagnostic appears under several workflows.

2. **Fix the broken import depth.** `../../shared/money` → `../../../shared/money`
   in [docs/concepts/typescript-nodes.md](../../docs/concepts/typescript-nodes.md)
   and [template/AGENTS.md.example](../../template/AGENTS.md.example). Grep the
   whole corpus for other pre-`code/` two-level examples
   (`grep -rn '\.\./\.\./shared' docs template README.md`) — this is the same
   class of copy-paste-broken snippet `npm run check:docs` catches for verb-last
   commands, so consider extending that script with a cheap relative-import
   depth assertion for fenced `import … from "../..*"` lines in node-file
   examples.

3. **Widen the tsconfig `include`.** In [tsconfig.json](../../tsconfig.json) and
   [template/tsconfig.json.example](../../template/tsconfig.json.example),
   replace the `shared/**` + `workflows/**` pair with a project-wide
   `**/*.ts` / `**/*.js` include so *any* helper folder is owned by the project
   with no edit. Extend `exclude` to cover what the wider glob would now sweep
   in: `node_modules`, `decanter-ts-plugin`, `**/*.remote.js`, `dist`, plus the
   per-workflow artifact dirs (`**/backups/**`, `**/executions/**`). Verify the
   repo's own `npm run typecheck` and `npm test` are unaffected, and that
   `scripts/typecheck.mts`'s node-file wrapper still only wraps real node files
   (it keys on `.decanter.json`, so a widened include is safe by construction).
   Existing sync dirs keep their scaffolded tsconfig — call that out in the
   changelog with the one-line fix.

4. **Document the actual rule (the core deliverable).**
   - [docs/concepts/typescript-nodes.md](../../docs/concepts/typescript-nodes.md),
     "Shared code and npm packages": lead with the real boundary — *shared code
     may live in **any folder inside the sync dir**, in any number of folders;
     `shared/` is simply what `init` scaffolds*. Show the three working shapes
     (one root, several roots, a per-workflow helper dir next to `code/`) and
     the one hard error (escaping the sync dir, with the exact message). State
     the two asymmetries from **Why**: auto-commit pathspec and `watch`.
   - [docs/concepts/sync-layout.md](../../docs/concepts/sync-layout.md): the
     layout tree shows `workflows/` only — add the sync-dir-level view with
     `shared/` marked *convention, rename or multiply freely*, and a pointer to
     the section above.
   - [README.md](../../README.md): the "Shared code and small libraries" feature
     bullet and the comparison-table row both say `shared/` — widen to "shared
     code anywhere in the sync dir (`shared/` by default)".
   - [docs/cli/push.md](../../docs/cli/push.md) and
     [docs/cli/diff.md](../../docs/cli/diff.md): same wording widening
     ("imports from `shared/`" → "imports from your shared code").
   - `CHANGELOG.md` `[Unreleased]`: **Fixed** — `preflight`'s `types` check now
     reports type errors in shared helper files instead of passing green while
     `push` fails on them; **Fixed** — the documented shared-import path was one
     level short for the `code/` layout; **Changed** — the scaffolded
     `tsconfig.json` covers the whole sync dir, so helper folders other than
     `shared/` are typechecked without editing `include`.

5. **Template & agent surfaces.**
   - [template/AGENTS.md.example](../../template/AGENTS.md.example), the
     "Shared code (`shared/`)" block: retitle to state the rule, keep `shared/`
     as the default, and add the line an agent needs — *a helper folder under
     another name works; add it to your editor/agent allowlist if you use one*.
   - [template/.claude/settings.json.example](../../template/.claude/settings.json.example):
     `Edit(shared/**)` stays (it's the scaffolded default), but the AGENTS.md
     text above must name it as the thing to extend. Per the root `AGENTS.md`
     agent-tooling rule the substance goes in `AGENTS.md.example`, with
     `CLAUDE.md.example` / the cursor rule staying pointers.

6. **Tests.**
   - Unit: `runTypecheckPerDir` attributes a diagnostic in a non-workflow file
     to **every** workflow in the run, and still attributes a node-file
     diagnostic to its own dir only.
   - e2e (`test/e2e.mts`, extending the existing
     `bundle: shared/ value import …` step): a node importing from a
     **non-`shared`** folder pushes a bundled body; a type error introduced in
     that helper makes `preflight --offline` report `types` **failed** (the
     regression this plan exists for); a second helper root and a per-workflow
     helper dir both bundle in one node; the sync-dir escape still errors.
   - `npm run check:docs` green (plus the new import-depth assertion if Task 2
     adopts it).

## Acceptance / verification

- `preflight` fails the `types` check on a type error in a shared helper —
  under `shared/` and under any other folder name — and the message names the
  real file and line. No workflow can be graded `ready` on code that `push` will
  reject.
- A node file importing from two differently-named helper roots **and** a
  per-workflow helper dir pushes one self-contained body; `node run` executes
  it offline.
- An import escaping the sync dir still fails with the existing
  `resolves outside the sync dir` layout error.
- The import snippets in `/docs` and `template/AGENTS.md.example` resolve
  when copy-pasted into a freshly `init`ed sync dir.
- A freshly scaffolded sync dir typechecks a helper folder named something
  other than `shared/` without editing `tsconfig.json`.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Non-goals

- **No config key** — see the design decision above.
- **No new restriction.** The sync-dir boundary is the whole rule and stays the
  whole rule; nothing gains an allowlist of permitted helper roots.
- **No `watch` on shared roots.** Unchanged from
  [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)'s non-goal — a
  helper edit still syncs on the next save/push of an importing node. Filed
  separately.
- **No rename of the scaffolded folder.** `init` keeps scaffolding `shared/`;
  this plan makes it a *default*, not a *requirement*.
- **No change to bundling semantics** — each importing node still carries its
  own copy, byte-for-byte as today.

## Notes

- **`PLAN.md` implication:** the data-model section's bundling note scopes
  shared imports to "`shared/*` helpers". Reword to the sync-dir rule so the
  design document stops implying a fixed folder. No data-model change — this
  plan documents and repairs existing behavior.
- **[Plan 24](24-shared-code-in-js-nodes.md) inherits all of it.** Bundled `.js`
  nodes will use the same `checkNodeImports` path, so every fix here applies
  unchanged; Plan 24's Task 6 (`status` reflects a shared edit) and its
  `shared/`-worded docs tasks should pick up this plan's wording. Its "No
  `watch`ing of `shared/`" non-goal is the same deferral restated above.
- **Why the docs bug survived:** `test/e2e.mts:1750` and
  `test/smoke-n8n.mts:347` both use the correct three-level path, so the suites
  proved bundling works while the documented snippet stayed broken — the exact
  gap `npm run check:docs` was built for (Plan 40), one class wider.
- **Follow-up draft to file:** `watch` re-pushes importers on a helper edit,
  with the watched set **derived from the import graph** (`scanNodeImports` +
  the resolved relative targets), not configured.
