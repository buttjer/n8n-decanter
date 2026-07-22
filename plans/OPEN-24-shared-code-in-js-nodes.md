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
   (byte-identical). Keep `compileTs` as a thin re-export or update the call
   sites (`push.mts`, `pull.mts`, `status.mts`, `run.mts`,
   simulation) — they already funnel through this one choke point, which is
   what keeps push/status/run/pull/simulate consistent for free.
2. **`lib/util.mts`** — generalize the marker helpers:
   - `splitMarker` matches `// @(ts|js)-n8n sha256:<hex>` and returns `kind`.
     Every current caller that only reads `body`/`markerHash`
     (`push.mts` drift/record, `validate.mts`) is unaffected.
   - `withMarker(compiledJs, kind: "ts" | "js")` emits the matching prefix.
   - Add a `MARKER_PREFIX_JS` alongside `MARKER_PREFIX` (or a
     `markerPrefix(kind)` helper).
3. **`lib/push.mts` `buildNodeCode`** — for `.js`, scan imports:
   - none → today's verbatim path, byte-identical (`{ jsCode: source, hash }`);
   - some → `withMarker(await compile(filePath, log), "js")`.
   `.ts` becomes `withMarker(await compile(filePath, log), "ts")`. The drift
   check (`codeDrift` via `collectOps`) and `recordSync` already hash
   `splitMarker(...).body` — correct for both markers and for markerless
   (verbatim) JS.
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
7. **Editor parity (`scripts/typecheck.mts` + tsconfig + ts-plugin)** —
   *secondary; can land in a follow-up if it balloons.* For a `.js` node that
   imports to resolve its helper in-editor and not flag its top-level `return`:
   - `tsconfig.json` / `template/tsconfig.json`: `allowJs: true` so `.js` node
     files (and their imports) enter the program; keep `checkJs` off (no type
     errors on plain JS).
   - `scripts/typecheck.mts`: the after-import async-function wrapper (Plan 14
     task 3) already keys off imports-at-top, not extension — confirm it wraps
     `.js` node files too and that line-mapping holds.
   - `decanter-ts-plugin`: confirm it still suppresses TS1108/1375/1378 on a
     `.js` node file that is now a module.
   - JSDoc `@typedef` imports in `.js` keep working (comments are invisible to
     both tools) — this task only *adds* value-import resolution.
8. **Template + docs (PR acceptance criteria):**
   - `template/AGENTS.md.example`: the `shared/` guidance already documents
     `.ts` imports — extend the `.js`-vs-`.ts` story to "plain `.js` nodes can
     import too now; an import makes the node bundled + one-way".
   - `docs/concepts/typescript-nodes.md` (the tier table — the header line
     "**No imports** — a `.js` node is pushed verbatim" is now conditional),
     `docs/cli/push.md`, `docs/cli/pull.md`, `docs/cli/status.md`,
     `docs/cli/check.md`, `docs/concepts/sync-layout.md`,
     `docs/concepts/configuration.md` (`bundleDependencies` desc:
     "npm packages `.ts`/`.js` nodes may import").
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
     sync-dir escape) with the same messages as `.ts`.
   - e2e (against the Plan 32 dual REST+MCP mock — assert the
     `update_workflow` op payload, not a PUT body): add an `import` from
     `shared/` to a `.js` node → `push` → the mock's draft contains the
     inlined helper + `@js-n8n` marker; `pull` → in sync, **file stays
     `.js`**; edit the shared file → `status` flags the importer,
     `status --diff` shows the inlined change; the markerless-remote clobber
     guard keeps the local file and warns instead of overwriting; `run`
     executes the importing `.js` node offline.
   - Live smoke (`test/smoke-n8n.mts`, opt-in): a bundled `.js` node executes
     in the real task-runner sandbox — the same getter-neutering trap Plan 14
     hit (`__copyProps` / no-`export` entry) applies identically here, so this
     smoke is the guardrail that the JS path clears it too.

## Acceptance / verification

- A `.js` node importing `{ helper }` (and a `type`) from `shared/` pushes a
  self-contained body carrying a `// @js-n8n sha256:…` marker, round-trips
  in-sync (pull leaves it `.js`, no `.remote.js`), and executes under `run`
  offline and in the live smoke.
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
