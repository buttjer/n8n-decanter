# Plan 24 — Shared-code imports in `.js` nodes

**Priority:** P2 (valuable; reuses Plan 14's machinery, but changes the `.js`
sync contract — data-model + flow work)
**Status:** Not started — reworked, ready to execute
**Snapshot:** 2026-10-25T12:41Z @ 0cd61e2
**Theme:** Let a `.js` node `import` from `shared/` (and opted-in npm packages)
the same way `.ts` nodes already can (Plan 14) — bundled into the pushed node
at push time — so a plain-JS author can factor out shared helpers without
being forced to rename the file to `.ts`.
**Model:** Opus for the core (marker reconciliation, pull ladder, the clobber
edge); Sonnet for docs and tests.

> **Rework 2026-10-25 (against 0cd61e2, 216 commits after the last snapshot).**
> What changed and why:
>
> - **No `@js-n8n` marker.** [Plan 84](../done/84-generated-node-header.md)
>   put the node's **source path on line 1**. That path already says which
>   extension to recreate, which was the only reason for a second token. A
>   bundled `.js` node gets the same line-1 marker as a `.ts` node; pull
>   reads the extension off `sourcePath`. The legacy trailing form carries no
>   path, but only `.ts` ever wrote it, so trailing ⇒ `.ts` stays exact. One
>   token keeps `grep -r @ts-n8n` complete and keeps `splitMarker` unchanged.
>   This drops the whole `kind` field, `MARKER_PREFIX_JS`, and the five-surface
>   "never write `@js-n8n`" doc sweep.
> - **One "local body" helper, used everywhere.** Five call sites each decide
>   "compile or read raw" by extension today (`buildNodeCode`, `status.mts`
>   `localBody`, `pull.mts`, `run.mts`, `verifyRoundTrip`). They all switch to
>   one rule: **managed = `.ts`, or `.js` with a top-level import.**
> - **Verbs moved.** `check`/`status` became `preflight`/`diff`
>   ([Plan 59](../done/59-declutter-verify-verbs.md)); the docs list now
>   names `docs/cli/preflight.md` and `docs/cli/diff.md`. `backup`, `simulate`
>   and `test` call `buildNodeCode` and need no change of their own.
> - **`import type` is not JS.** The old acceptance line asked a `.js` node to
>   import "a `type`". esbuild's `js` loader rejects that syntax. Types in a
>   `.js` node come from JSDoc `import('…')` comments, which `scanNodeImports`
>   already skips (it skips comments) — so a JSDoc type import must **not**
>   flip a node to managed. Now an explicit test.
> - **The flip is announced once, not on every preflight.** A permanent
>   preflight warning on a node that is bundled on purpose is noise, and an
>   agent would try to "fix" it. Push announces the transition in both
>   directions; `diff` keeps saying "bundled" for such nodes.
> - Task 7 (editor parity) re-verified: still satisfied. `checkJs`/`allowJs`
>   are on, `scripts/typecheck.mts` wraps `/\.(ts|js)$/`, the ts-plugin
>   matches `.js` node files.

## Why

- User ask: *"allow import/shared code also for js nodes."* Today an `import`
  in a `.js` node is a hard **error** (`lib/validate.mts`, "convert the node to
  `.ts` … or inline the code"). That forces a language switch on someone who
  just wants a shared helper in plain JS.
- Plan 14's bundler is language-agnostic: `scanNodeImports` is lexical, and
  `checkNodeImports` / `findBundleContext` / the hoist→wrap→bundle path in
  `lib/compile.mts` don't care whether the body is JS or TS. Only the esbuild
  `loader` differs.

### The `.js` tier splits in two (operator-confirmed, 2026-10-25)

| Source | Top-level import? | Push | Sync | Line-1 marker |
|---|---|---|---|---|
| `.js` | no | verbatim | two-way (lossless) | — |
| `.js` | yes | esbuild bundle | **one-way (managed)** | yes, path ends `.js` |
| `.ts` | any | esbuild compile/bundle | one-way (managed) | yes, path ends `.ts` |

- **Opt-in is per node, by writing an import.** Removing the import makes the
  node lossless again on its next push (the marker is cleared).
- A no-import `.js` node is untouched: **byte-identical output, zero drift on
  CLI upgrade.**
- Not **Breaking**: every file that now bundles was a hard error before.

## Design

- **Managed predicate** — new `isManagedSource(filePath)` (in `lib/compile.mts`,
  next to `scanNodeImports`): `.ts` → true; `.js` → `scanNodeImports(src)
  .specifiers.length > 0`. Comments, JSDoc `import('…')`, dynamic `import()`
  and `import.meta` never count (the scanner already stops at them).
- **Marker** — unchanged format and parser. New helper
  `markerExtension(split): ".js" | ".ts" | null` in `lib/util.mts`: null when
  there is no marker; leading → extension of `sourcePath` (`.ts` when the path
  is null or ends in neither); trailing → `.ts`.
- **Compile** — `compileTs` → `compileNode(file, log, opts)`; loader from the
  extension for both the bundle `stdin.loader` and the no-import `transform`
  (the no-import branch is only reachable for `.ts`, kept byte-identical).
- **Local body** — one exported `localBody(dir, file, log)` (move it from
  `lib/status.mts` into `lib/compile.mts` or `lib/push.mts`): managed →
  `compileNode`, else raw file. `buildNodeCode` = `localBody` + `withMarker`
  when managed, verbatim otherwise.

## Tasks

1. **`lib/compile.mts`** — add `isManagedSource`; rename `compileTs` →
   `compileNode` with extension-picked loader; update every import
   (`push`, `pull`, `status`, `run`, comments in `diff.mts`).
2. **`lib/util.mts`** — add `markerExtension`. Update the doc comments that say
   "TS-managed" / "compiled TS push" so they say "managed".
3. **`lib/push.mts`**
   - `buildNodeCode`: branch on `isManagedSource`, not `.ts`. The `sourcePath`
     on the marker is the real file path, so a `.js` node's line 1 ends `.js`.
   - **`collectOps` marker reconciliation — key on the build, not the
     extension.** Today: `missingMarker = file.endsWith(".ts") && remote has
     none`, `strayMarker = file.endsWith(".js") && remote has one`. Under that
     rule a bundled `.js` node trips `strayMarker` on every push (permanent
     draft churn). New rule, with `built = splitMarker(jsCode)`:
     - `missingMarker` = built has a marker, remote has none (registers `.ts`
       *and* newly importing `.js`);
     - `strayMarker` = built has none, remote has one (de-managing: import
       removed, or `.ts` → plain `.js`);
     - `wrongExtension` = both have one and `markerExtension(remote) !==
       path.extname(ns.file)` (a `.ts` ↔ importing-`.js` conversion with an
       equal body — without the write, the next pull would rename the file
       back).
     Keep Plan 84's rule intact: a **legacy trailing marker on a `.ts` node**
     is neither missing, stray nor wrong-extension → still `continue`. A
     trailing marker with a `.js` file *is* wrong-extension (it implies `.ts`)
     and correctly forces one write.
   - **Announce the flip** when a write registers or clears management on a
     `.js` file: `<node>: <file> now imports — bundled on push, one-way from
     here (pull no longer overwrites it)` / `<node>: <file> has no imports any
     more — pushed verbatim, two-way again`. Print on the normal push log,
     once per transition (the condition is `missingMarker`/`strayMarker` on a
     `.js` file, which is only true on the push that flips it).
   - **`verifyRoundTrip`**: take the marker-hash branch whenever the local
     file is managed (`isManagedSource`), else byte-compare raw — today it
     keys on `.ts` and would warn "does not match byte-exactly" on every
     bundled `.js` push.
4. **`lib/pull.mts`** — the managed ladder handles both extensions.
   - `managed = markerHash !== null`; the wanted extension passed to
     `resolveNodeFile` is `markerExtension(split)`, not a hard `.ts`.
   - Managed branch: compare `localBody(...)` (not `compileTs`) against the
     remote body. A local `.js` whose import was removed but not pushed then
     reads "local modified, not yet pushed" — kept, not clobbered.
   - Missing local file: keep the "cannot reconstruct source; add the file"
     warning, worded by extension ("managed on remote" instead of
     "TS-managed"). Never write the bundled body as a `.js` source — that would
     push back markerless and silently de-manage the node.
   - **Clobber guard (new).** The `else` (markerless remote) branch overwrites
     `.js` with the remote body. If the local `.js` exists and
     `isManagedSource` is true, do what the `.ts`-but-no-marker branch does
     instead: keep the file, warn (`local <file> imports shared code but the
     remote code is not a decanter bundle — keeping your source; the next push
     overwrites the remote code`), re-baseline `lastPushedHash`, `continue`.
     Not added to `clobbered`. Place it before the `.ts` sibling check.
5. **`lib/validate.mts`** — for `.js` node files, drop the "has an import →
   convert to `.ts`" error and run the exact `.ts` block (blocking/advisory
   from `checkNodeImports`, "import below the first statement" warning). Merge
   the two branches into one keyed on `/\.(ts|js)$/`. The on-disk marker error
   stays as it is (wording already covers `.js`). No standing "one-way"
   warning (see rework note).
6. **`lib/status.mts` / `lib/run.mts`** — use the shared `localBody`
   (`status`) and `isManagedSource` (`run.mts:326`, today `.ts` → compile,
   else raw `splitMarker(...).body`). A no-import `.js` must never touch
   esbuild. `diff`'s per-node line says "bundled" for a managed `.js` node.
   Editing a `shared/*` file then marks each importing `.js` node
   push-pending, and `diff` shows the inlined change.
7. **Editor parity — already satisfied; regression test only** (re-verified
   2026-10-25): an importing `.js` node resolves its helper, its top-level
   `return` is not flagged, JSDoc `import('…')` types keep working.
8. **Docs, template, changelog, PLAN.md** (acceptance criteria):
   - `README.md`: the "TypeScript or typed JS" and "Shared code and small
     libraries" bullets and the comparison-table row scope shared imports to
     `.ts` — widen to `.ts` and `.js`.
   - `docs/concepts/typescript-nodes.md`: the tier table, the "no imports — a
     `.js` node is pushed verbatim" line, and the `.ts` ↔ `.js` conversion
     section (now three states: plain `.js` ↔ importing `.js` ↔ `.ts`).
   - `docs/cli/preflight.md` (the `.js` import bullet becomes "same bundling
     rules as `.ts`"), `docs/cli/push.md`, `docs/cli/pull.md`,
     `docs/cli/diff.md`, `docs/concepts/sync-layout.md`,
     `docs/concepts/configuration.md` (`bundleDependencies`: "npm packages
     `.ts`/`.js` nodes may import").
   - `template/AGENTS.md.example` (and its CLAUDE/Cursor siblings where they
     say imports are `.ts`-only): plain `.js` nodes can import too; an import
     makes the node bundled and one-way. The "never write a marker line"
     invariant needs no change — the token is the same.
   - `CHANGELOG.md` `[Unreleased]`: **Added** — imports from `shared/` and
     opted-in npm packages in `.js` nodes, bundled on push. **Changed** — a
     `.js` node with an import is one-way; removing the import makes it
     lossless again.
   - `PLAN.md`: replace "`.js` never bundles (lossless tier)" with the
     two-tier split, the managed predicate, `markerExtension`, the
     build-keyed reconciliation and the pull clobber guard. Revise Plan 14's
     non-goal reference.
9. **Tests**
   - Unit: `isManagedSource` (import → true; JSDoc `import('…')` only, dynamic
     `import()`, comments → false); `markerExtension` for leading `.js`,
     leading `.ts`, trailing, none; `compileNode` bundles a `.js` entry
     deterministically (two cwds → identical bytes) and runs via
     `AsyncFunction` with fake globals; a **no-import `.js` `buildNodeCode`
     output is byte-identical to the file** (pinned).
   - Unit, validate: **flip the pinned assertion**
     `test/unit/validate.test.mts:343` (`/\.js nodes run verbatim in n8n.*
     convert the node to \.ts/`) to "legal `.js` import passes"; the illegal
     set (mid-file import, un-opted bare specifier, `node:` builtin, sync-dir
     escape) gives the same messages as `.ts`.
   - Unit, push: bundled `.js` with matching remote → in sync, no op; legacy
     trailing-marker `.ts` body-equal → still no op (Plan 84 regression);
     import removed, body-equal → one op clearing the marker; `.ts` → importing
     `.js` body-equal → one op (`wrongExtension`); `verifyRoundTrip` silent
     for a bundled `.js` push.
   - Unit, pull: leading marker with a `.js` path recreates/keeps `.js`;
     markerless remote + importing local `.js` → kept, warned, not in
     `clobbered`; marker on remote + missing local `.js` → warning, no file
     written.
   - e2e (`test/e2e.mts`, dual mock — assert the `update_workflow` op): add an
     import to a `.js` node → push → draft holds the inlined helper and a
     line-1 marker ending `code/<node>.js`; flip message printed once; pull →
     in sync, file stays `.js`; edit the shared file → `diff` flags the node;
     `node run` executes it offline; `test` reports no false "code changed
     since push"; remove the import → push clears the marker.
   - Live smoke (`test/smoke-n8n.mts`, opt-in, run before merge): a bundled
     `.js` node executes in the real task-runner sandbox (Plan 14's
     getter-neutering trap applies identically).

## Acceptance

- A `.js` node importing a helper from `shared/` pushes a self-contained body
  with a line-1 marker whose path ends `.js`; pull leaves it `.js` and in
  sync; it runs under `node run` and in the live smoke.
- A bundled `.js` node with an unchanged remote is **in sync**: no
  reconciliation churn, no `verifyRoundTrip` warning.
- A no-import `.js` node's pushed `jsCode` is byte-identical to today's
  (pinned).
- Removing the import makes the next push clear the marker; the node is
  lossless again.
- Pull never clobbers an importing local `.js` from a markerless remote.
- Illegal imports fail with the same messages as `.ts`, offline in
  `preflight`; the two-way → one-way flip is announced by the push that
  makes it.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Non-goals

- No change to the no-import `.js` contract.
- No auto-conversion of extension — a `.js` node stays `.js`.
- No import capabilities beyond `.ts` (same rules, same checker).
- No new marker token.
- No `watch`ing of `shared/` (same deferral as Plan 14).
- No minification or source maps.

## Notes

- **Why not "just use `.ts`":** the bundled output is near-identical; the value
  is ergonomic — a plain-JS author keeps `.js` and JSDoc.
- **Accepted costs carried over from Plan 14:** runtime error line numbers
  shift (shared modules land above the body); an esbuild bump may reshape
  bundles → one push-pending flap, re-baselined by the next push.
- Cross-links: [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)
  (compiler, guard), [Plan 84](../done/84-generated-node-header.md) (line-1
  marker with `sourcePath`), [Plan 4](../done/4-editor-node-diagnostics.md)
  (ts-plugin), [Plan 3](../done/3-local-run-and-diff-fidelity.md) (`diff`
  readability of bundles).
