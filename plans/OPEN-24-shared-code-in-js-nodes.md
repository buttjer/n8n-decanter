# Plan 24 — Shared-code imports in `.js` nodes

**Priority:** P2 (valuable; reuses Plan 14's machinery, but changes the `.js`
sync contract — data-model + flow work, so a real design pass)
**Status:** Not started
**Theme:** Let a `.js` node `import` from `shared/` (and opted-in npm packages)
the same way `.ts` nodes already can (Plan 14) — bundled into the pushed node
at push time — so a plain-JS author can factor out shared helpers without
being forced to rename the file to `.ts`.
**Model:** Opus for the core (marker/round-trip correctness, the pull clobber
edge); Sonnet for the docs + test tasks.

> **Post-Plan-32 review (2026-07-22):** the design survives the MCP pivot
> unchanged — its choke points (`buildNodeCode`, `compileTs`, `splitMarker`,
> the validate rules) live in the file layer and were carried over verbatim;
> the bundled body simply rides the same `{jsCode}`-only
> `updateNodeParameters` op as every push. **Adapted:** the pull clobber guard
> (Task 4), the e2e task, and one acceptance line — Plan 32 deleted the
> `.remote.js` conflict flow wholesale, so the guard now mirrors the current
> keep-local-and-warn branch instead of writing `.remote.js` artifacts. The
> e2e mock is now the dual REST+MCP one. Re-resolve inline file/line refs at
> execution time (pull/push/PLAN.md were rewritten in Plan 32).

> **Post-#107/#114 review (2026-07-23):** design still sound; three post-plan
> push behaviors must be absorbed and one task collapsed. (1) **#107's marker
> reconciliation in `collectOps` is extension-keyed and must become
> kind-aware** — today `missingMarker` = `.ts` file + markerless remote,
> `strayMarker` = `.js` file + marker-carrying remote; a legitimately
> `@js-n8n`-marked bundled `.js` node would trip `strayMarker` on every push
> (permanent draft churn, never "in sync") — Task 3 now redesigns the
> expectation around what `buildNodeCode` produced, not the extension.
> (2) **`verifyRoundTrip`** branches on `.ts` and byte-compares everything
> else against the raw local file — managed `.js` must take the marker-hash
> branch (Task 3). (3) **`status`/`run` route compiles by extension only** —
> the generalized `compile()` needs an explicit import-presence gate for
> `.js` at those call sites (Tasks 1/6). Task 7 (editor parity) is **already
> satisfied in the repo** — downgraded to a regression-test note. `simulate`
> (post-#114) and the new `test` verb consume the choke points indirectly via
> `buildNodeCode`, so bundled `.js` rides free there once Tasks 2/3 land.

## Why

- User ask: *"allow import/shared code also for js nodes."* Today an `import`
  in a `.js` node is a hard **error** — `lib/validate.mts` tells the user to
  "convert the node to `.ts` (imports are bundled on push) or inline the code."
  That forces a language switch on someone who just wants a shared helper in
  plain JS.
- Plan 14 already built the whole bundling apparatus and it is
  **language-agnostic**: `scanNodeImports` is a lexical scanner, and
  `checkNodeImports` / `findBundleContext` / the hoist→wrap→bundle→re-enter
  path in `lib/compile.mts` don't care whether the body is JS or TS (esbuild
  bundles both; only the entry loader differs). Extending it to `.js` is mostly
  wiring, plus one new marker and the pull/validate handling around it.

### The one thing that genuinely changes: the `.js` tier splits in two

`.js` is the **lossless tier** — local source is byte-identical to n8n's
`jsCode`, two-way. Bundling **cannot** be lossless: the helper must physically
appear in the pushed body. So the tiers become:

| Source | Imports? | Push | Sync direction | Marker |
|---|---|---|---|---|
| `.js` | none | verbatim | two-way (lossless) | — |
| `.js` | yes | esbuild bundle | **one-way (managed)** | `// @js-n8n sha256:…` |
| `.ts` | any | esbuild compile/bundle | one-way (managed) | `// @ts-n8n sha256:…` |

**Decision (user, 2026-07-21): auto on import.** Presence of a top-level
`import` in a `.js` file promotes it to bundled/one-way on the next push — no
new syntax, mirrors `.ts` exactly. The cost is that adding an import silently
flips a node from two-way to one-way; the mitigation is that `check` and
`status` must *surface* the flip (see Tasks 5, 6), so it is announced, not
silent. A no-import `.js` node is untouched — still verbatim, still lossless,
**byte-identical output, zero drift on CLI upgrade** (same guarantee Plan 14
gives no-import `.ts` nodes).

## Source

- [Plan 0](BACKLOG.md): graduate a new item — "Shared-code imports in `.js`
  nodes" (mirror of the Plan 14 item for the lossless tier).
- [Plan 14](DONE-14-bundle-shared-code-into-ts-pushes.md) — this plan reuses
  its compiler, guard, and marker design wholesale; that plan's Non-goal "No
  bundling for `.js` nodes — lossless round-trip is their contract" is the line
  this plan deliberately revises (imports opt a `.js` node *out* of the
  lossless contract; no-import `.js` keeps it).
- **PLAN.md** (rewritten in Plan 32) — the guard rules still list "imports in
  `.js` nodes" as a violation, and the shared-bundling note still scopes
  bundling to `.ts` nodes (plans/14). This plan updates both to the two-tier
  `.js` split above (raise with the user per CLAUDE.md — done via the
  promotion-trigger decision).

## Design decision — reuse Plan 14, add a second marker

The compile path already works for a JS body; the only genuinely new design
piece is **how a bundled `.js` node identifies itself on the remote**, because
a fresh pull (no local sources) must recreate the correct file *extension* from
`jsCode` alone — its only signal is the marker line.

- **Two markers, not one.** `// @ts-n8n sha256:…` → recreate as `.ts`;
  `// @js-n8n sha256:…` → recreate as `.js`. Reusing `@ts-n8n` for bundled JS
  is wrong: `resolveNodeFile` derives the extension from the marker and would
  **rename the user's `code/foo.js` to `foo.ts` on the next pull**, silently
  converting their JS to TS. A distinct `@js-n8n` marker keeps the extension
  stable and makes the pushed artifact self-describing in the n8n UI.
- **Marker *presence* = managed (one-way); marker *kind* = extension.** These
  are orthogonal. `splitMarker` returns `{ body, marker, markerHash, kind }`
  where `kind ∈ {"ts","js",null}`; pull maps `kind` → extension and
  `markerHash !== null` → the managed branch.
- **The local file extension is authoritative for *how* to compile** (`.js` →
  esbuild `loader: "js"`, `.ts` → `"ts"`). The marker only tells a bare pull
  which extension to recreate.

## Tasks

1. **`lib/compile.mts`** — generalize `compileTs(file, log)` →
   `compile(file, log)` that picks the esbuild loader from the file extension
   (`.ts` → `"ts"`, `.js` → `"js"`). The bundle path (entry + `build`) is
   already loader-agnostic; only the `stdin.loader` and the no-import fast path
   need the extension. No-import `.js` never routes here (pushed verbatim by
   `buildNodeCode`); the no-import `.ts` `transform` fast path is unchanged
   (byte-identical). Keep `compileTs` as a thin re-export or update the
   direct call sites (`push.mts` via `buildNodeCode`, `pull.mts`,
   `status.mts`, `run.mts`); `simulate` (post-#114) and the `test` verb
   consume the choke point indirectly through `buildNodeCode`
   (`lib/simulate.mts`, `lib/testrun.mts`), so they stay consistent for
   free. **Gating:** `status`/`run` route by extension today (`.ts` →
   compile, else raw) — an import-having `.js` must route through `compile`
   there too, while a no-import `.js` must NOT touch esbuild (byte-identity
   contract); state the import-presence gate explicitly at both call sites
   rather than assuming it falls out (see Task 6).
2. **`lib/util.mts`** — generalize the marker helpers:
   - `splitMarker` matches `// @(ts|js)-n8n sha256:<hex>` and returns `kind`.
     Callers that read only `body` (`push.mts` drift/record, `status.mts`,
     `run.mts`, `lib/testrun.mts` — so the `test` verb's stale-code checks
     handle bundled `.js` automatically) are unaffected. Two callers are
     NOT mere body readers and are this plan's explicit rework targets:
     `pull.mts` derives the recreate-extension from `markerHash` (Task 4),
     and `validate.mts` reads `.marker` with a `@ts`-worded error (Task 5).
   - `withMarker(compiledJs, kind: "ts" | "js")` emits the matching prefix.
   - Add a `MARKER_PREFIX_JS` alongside `MARKER_PREFIX` (or a
     `markerPrefix(kind)` helper).
3. **`lib/push.mts` — `buildNodeCode` + the #107 marker reconciliation.**
   - `buildNodeCode`: for `.js`, scan imports — none → today's verbatim path,
     byte-identical (`{ jsCode: source, hash }`); some →
     `withMarker(await compile(filePath, log), "js")`. `.ts` becomes
     `withMarker(await compile(filePath, log), "ts")`. `codeDrift` (via
     `collectOps`) and `recordSync` hash `splitMarker(...).body` — correct for
     both markers and for markerless (verbatim) JS.
   - **Make `collectOps`' marker reconciliation kind-aware (NEW — #107 added
     it *after* this plan was written).** `collectOps` today keys the
     force-a-write decision on the *file extension*: `missingMarker =
     file.endsWith(".ts") && remote markerHash === null`, `strayMarker =
     file.endsWith(".js") && remote markerHash !== null`. A bundled `.js`
     node legitimately carries a `@js-n8n` marker on the remote while its
     local file ends `.js` — under the extension rule it would trip
     `strayMarker` on **every** push, never reach the "already in sync"
     continue, and the "clearing" write would re-emit the marker
     (`buildNodeCode` produces it): permanent draft churn. **Redesign: derive
     the expected marker state from what `buildNodeCode` just produced, not
     the extension** — `missingMarker` = built body has a marker & remote
     lacks it (covers `.ts` *and* import-having `.js` registering);
     `strayMarker` = built body is markerless & remote has any marker (covers
     de-managing back to verbatim); plus a **kind-mismatch** case (remote
     `@ts-n8n` vs built `@js-n8n`, or vice versa) that forces a rewrite. This
     is the exact `@js-n8n` mirror of the shipped
     "re-register/clear the `@ts-n8n` marker on a body-equal push" behavior.
   - **`verifyRoundTrip` (post-write check) branches on `.ts`** (marker-hash
     compare) and byte-compares the raw *local file* against the remote body
     for everything else — a bundled `.js` node's local source never equals
     its bundled remote body, so it would emit a spurious "remote code does
     not match … byte-exactly" warning. Managed (import-having) `.js` must
     take the marker-hash branch, exactly like `.ts`.
4. **`lib/pull.mts`** — the managed branch handles both kinds:
   - Replace `tsManaged` with `managed = markerHash !== null` and derive
     `ext` from `kind` (`"js"` → `.js`, `"ts"` → `.ts`); the compile-and-compare
     in the managed branch calls `compile(filePath)` (loader from the *local*
     extension).
   - **New clobber guard (symmetric to the existing `.ts` branch, in its
     post-Plan-32 shape):** a local `.js` that *has imports* is managed; if
     the remote carries **no** marker, pull must **not** overwrite it via the
     verbatim branch — keep the local file, warn ("local `<file>` has imports
     but the remote code has no `@js-n8n` marker — keeping your source; the
     next push overwrites the remote code") and re-baseline `lastPushedHash`,
     exactly as the "local `.ts` exists but remote has no marker" branch does
     today. (Plan 32 removed the `.remote.js` artifact flow — git is the
     recovery net.) Detect managed-JS by scanning the local file's imports
     (pull already reads local sources in the managed branch).
   - **Missing-local-file sub-case (kind=js).** Pull's existing
     marker-present-but-no-local-file branch warns "TS-managed on remote but
     no local `<file>` — pull cannot reconstruct `.ts` source; add the file".
     For a `@js-n8n` remote this message is `.ts`-worded *and* the bundled
     remote body genuinely can't be un-bundled into source — so the same
     "cannot reconstruct source; add the file" guard must fire for `kind=js`
     (naming `.js`), never silently write the bundled body as a `.js` source
     file (that would push back verbatim + markerless, de-managing the node).
5. **`lib/validate.mts`** — `.js` node files:
   - Remove the hard "`.js` has an import → convert to `.ts`" error; instead run
     the **same** lexical import rules as `.ts` (`checkNodeImports` via
     `findBundleContext`: relative-inside-sync-dir, `bundleDependencies` opt-in
     for bare specifiers, no `node:` builtins / native addons) and the
     "import below the first statement" warning.
   - Keep the on-disk marker error for **both** markers (a source file must
     never contain a marker line — it's a push artifact).
   - **Surface the contract flip:** a `.js` node with imports is one-way and
     bundled — emit an info/warning naming it (so the two-way→one-way change is
     announced, per the promotion decision). Shared with `check`.
6. **`lib/status.mts`** — a `.js` node with imports compiles like a `.ts` node
   (its localBody = bundled output), so editing a `shared/*` file marks every
   importing `.js` node "push pending" and `status --diff` shows the inlined
   change — verify this falls out of routing managed `.js` through `compile`.
   Include the one-way/bundled note in the status line for such nodes.
7. **Editor parity — ALREADY SATISFIED (2026-07-23); regression-test only.**
   Verified against the current repo: both `tsconfig.json` and
   `template/tsconfig.json.example` already set `allowJs: true` **and**
   `checkJs: true` (deliberate — `.js` nodes are JSDoc-typed, PLAN.md) and
   already glob `shared/**/*.js` + `workflows/**/*.js` into the program;
   `scripts/typecheck.mts`'s in-memory async-function wrapper keys off
   imports-at-top (regex `/\.(ts|js)$/`), so it already wraps importing `.js`
   node files with correct line-mapping; and `template/decanter-ts-plugin`
   already matches `.js` node files and filters TS1108/1375/1378. So this task
   is **not implementation** — it is one regression test: an importing `.js`
   node resolves its helper in-editor, its top-level `return` isn't flagged,
   and JSDoc `@typedef` imports keep working. *(The plan formerly said "keep
   `checkJs` off" — that directly contradicts the repo's intentional
   `checkJs: true`; dropped. The template file is `tsconfig.json.example`,
   not `tsconfig.json`.)*
8. **Template + docs (PR acceptance criteria):**
   - **`README.md` (the mandatory third surface, easily forgotten — rewritten
     by #110/Plan 38):** the "TypeScript or typed JS" + "Shared code and small
     libraries" feature bullets and the comparison-table row all scope shared
     imports to `.ts` nodes today — widen them to `.ts`/`.js`.
   - **The `@ts-n8n`-only "never write a marker line" agent invariant is
     stated across five scaffold/docs surfaces and each goes stale once
     `@js-n8n` exists** (an agent following them verbatim would think a
     `@js-n8n` line is legal to write): `docs/agents/overview.md`,
     `template/AGENTS.md.example` (two spots), `template/CLAUDE.md.example`,
     and `template/.cursor/rules/n8n-decanter.mdc.example`. Broaden each to
     "never write a `// @ts-n8n` **or** `// @js-n8n` marker line".
   - `template/AGENTS.md.example`: the `shared/` guidance already documents
     `.ts` imports — extend the `.js`-vs-`.ts` story to "plain `.js` nodes can
     import too now; an import makes the node bundled + one-way".
   - `docs/concepts/typescript-nodes.md` — both the **tier-table header** line
     ("**No imports** — a `.js` node is pushed verbatim" is now conditional)
     **and the `.ts`↔`.js` conversion section** (added by #107): the `@js-n8n`
     marker introduces a third state to that story
     (js-with-imports ↔ js-plain ↔ ts). Plus `docs/cli/push.md`,
     `docs/cli/pull.md`, `docs/cli/status.md`, `docs/cli/check.md`,
     `docs/concepts/sync-layout.md`, `docs/concepts/configuration.md`
     (`bundleDependencies` desc: "npm packages `.ts`/`.js` nodes may import").
   - **CHANGELOG** (`[Unreleased]`): Added — value/type imports from `shared/`
     and opted-in npm packages in `.js` nodes (bundled on push); Changed — a
     `.js` node with imports is one-way/bundled, no longer lossless (the
     no-import `.js` contract is unchanged). Not **Breaking**: files that now
     bundle were hard errors before, so nothing previously pushable changes.
   - **PLAN.md**: replace "`.js` nodes never bundle (lossless tier)" with the
     two-tier `.js` split and the `@js-n8n` marker; note the pull clobber
     guard.
9. **Tests:**
   - Unit (`test/unit/`): `splitMarker`/`withMarker` round-trip for **both**
     kinds; `compile` bundles a `.js` entry deterministically (two cwds →
     identical artifact) and executes via `AsyncFunction` with fake globals;
     `validate` accepts a legal `.js` import and rejects the illegal set
     (mid-file import, bare specifier without opt-in, `node:` builtin,
     sync-dir escape) with the same messages as `.ts`. **Rewrite the pinned
     negative assertion** `test/unit/validate.test.mts` (the one matching
     `/\.js nodes run verbatim in n8n.*convert the node to \.ts/`) — Task 5
     removes that error, so this test must flip to the new
     lexical-rules + promotion-warning expectations.
   - **`collectOps`/`verifyRoundTrip` kind-awareness (Task 3):** unit-assert a
     `@js-n8n`-marked bundled `.js` node whose remote body already matches is
     reported **in sync** (no `strayMarker` churn), a body-equal `.ts`→`.js`
     de-manage clears the marker, and a kind-mismatch (remote `@ts-n8n` vs
     built `@js-n8n`) forces a rewrite.
   - e2e (against the Plan 32 dual REST+MCP mock — assert the
     `update_workflow` op payload, not a PUT body): add an `import` from
     `shared/` to a `.js` node → `push` → the mock's draft contains the
     inlined helper + `@js-n8n` marker; `pull` → in sync, **file stays
     `.js`**; edit the shared file → `status` flags the importer,
     `status --diff` shows the inlined change; the markerless-remote clobber
     guard keeps the local file and warns instead of overwriting; `node run`
     executes the importing `.js` node offline. Add a `test`-verb e2e line: a
     `@js-n8n`-marked node reports the correct body-hash with no false "code
     changed since push".
   - Live smoke (`test/smoke-n8n.mts`, opt-in): a bundled `.js` node executes
     in the real task-runner sandbox — the same getter-neutering trap Plan 14
     hit (`__copyProps` / no-`export` entry) applies identically here, so this
     smoke is the guardrail that the JS path clears it too.

## Acceptance / verification

- A `.js` node importing `{ helper }` (and a `type`) from `shared/` pushes a
  self-contained body carrying a `// @js-n8n sha256:…` marker, round-trips
  in-sync (pull leaves it `.js`, no `.remote.js`), and executes under
  `node run` offline and in the live smoke.
- A `@js-n8n`-marked bundled `.js` node whose remote body is unchanged reads as
  **in sync** — no per-push marker churn from `collectOps`, no spurious
  `verifyRoundTrip` byte-mismatch warning.
- A no-import `.js` node's pushed `jsCode` is **byte-identical** to today's
  (pinned by test) — no marker, no drift on CLI upgrade.
- Editing a shared helper marks every importing `.js` node push-pending with a
  readable `--diff`; pushing re-syncs them.
- A local `.js`-with-imports is **never** clobbered by a markerless remote pull
  — pull keeps the file and warns (no `.remote.js` artifacts since Plan 32;
  the next push overwrites the remote).
- Mid-file imports, un-opted-in bare specifiers, builtins, and sync-dir escapes
  fail with the same named-file/named-specifier errors as `.ts`; `check`
  catches the lexical subset offline and announces the two-way→one-way flip.
- `npm test` + `npm run typecheck` green.

## Non-goals

- **No change to the no-import `.js` contract** — verbatim, two-way, lossless,
  byte-identical output.
- **No auto-conversion of extension** — a `.js` node stays `.js` (that's the
  whole point vs "just rename to `.ts`"); the `@js-n8n` marker keeps the
  extension stable across a bare pull.
- **No new import capabilities beyond `.ts`** — identical rules (imports at the
  top only, relative imports stay inside the sync dir, bare specifiers need a
  `bundleDependencies` opt-in, no `node:` builtins or native addons).
- **No `watch`ing of `shared/`** — same deferral as Plan 14; a shared edit
  syncs on the next save/push of an importing node.
- **No minification / source maps** — deterministic, diffable output (same as
  Plan 14).

## Notes

- **Why this over "just use `.ts`":** functionally the bundled output of a
  `.js`-with-imports node and the equivalent `.ts` node is near-identical
  (esbuild, `loader` js vs ts). The value is purely ergonomic — a plain-JS
  author keeps the `.js` extension and mental model while gaining shared code,
  instead of being told to adopt TypeScript for a one-line helper import. That
  ergonomic ask is exactly the user's request.
- **Sandbox trap is shared, not re-litigated:** the getter-neutering
  discovery (Plan 14's live-smoke outcome — no-`export` entry, `__copyProps`
  rewrite, `__export(` warning) lives in `compile.mts` and applies to the JS
  path unchanged; task 9's smoke re-verifies it rather than re-deriving it.
- **Accepted costs carried over from Plan 14:** n8n runtime error line numbers
  shift (shared modules land above the body); esbuild version bumps may reshape
  bundle output → one-time push-pending flap re-baselined by the next push.
- **Cross-links:** [Plan 14](DONE-14-bundle-shared-code-into-ts-pushes.md)
  (the compiler/guard/marker this reuses),
  [Plan 4](DONE-4-editor-node-diagnostics.md) (ts-plugin must keep suppressing
  on module-shaped `.js` node files — task 7),
  [Plan 3](DONE-3-local-run-and-diff-fidelity.md) (`status --diff` readability
  of the bundled `.js` output).
