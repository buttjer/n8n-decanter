# Plan 14 — Bundle `shared/` code into TS pushes

| | |
|---|---|
| **Priority** | P2 |
| **Status** | Done (2026-07-19 — implemented + offline-tested 2026-07-18; the live smoke ran via [Plan 15](../done/15-docker-n8n-smoke-suite.md) against n8n 2.30.7, caught a real sandbox incompatibility, and passes after the mechanism revision below) |

## Live-smoke outcome (2026-07-19) — mechanism revised

The Docker smoke suite proved the original artifact did **not** run in n8n's
task-runner sandbox: `__n8n_node.default is not a function`. Bisection
showed the sandbox **neuters getter property descriptors**
(`Object.defineProperty` with `get` reads back undefined) — and esbuild
lowers module exports (`__export`/`__toCommonJS`) and CJS interop
(`__toESM`/`__copyProps`) to exactly such getters. Passing in `run` and unit
tests proved nothing: plain Node honors getters. Fix (lib/compile.mts):

- entry emits **no `export`** — the wrapper arrow is assigned onto a free
  shim identifier (`__n8n_node.default = …`), so esbuild generates no export
  machinery at all; ESM imports (shared/) inline into the iife scope
  getter-free;
- esbuild's `__copyProps` helper is **rewritten post-bundle to eager data
  assignment** (snapshot-at-require — normal CJS semantics), fixing npm
  CJS-package interop;
- a residual `__export(` in a bundle (lazily-wrapped module: import cycle /
  top-level await in shared code) triggers a compile-time warning naming the
  restructure.

Verified end-to-end by the smoke suite: shared helper + npm package compute
through a real webhook execution, in both all-items and each-item modes.
**Theme:** Make `import`s from `shared/` actually work in `.ts` nodes — types
*and* values — by bundling them into the compiled node at push time, without
touching the `.js` lossless contract, the marker semantics, or the one-way
`.ts` model.

## Why

The user's actual goal (2026-07-18): *"enable developers to add small
libraries and maintain shared code and types between multiple code nodes."*
Bundling is the right lever for both halves: n8n's native alternative
(`NODE_FUNCTION_ALLOW_EXTERNAL`) is self-hosted-only, needs packages
installed on the n8n host, and doesn't exist on n8n Cloud — a bundled node
is self-contained and runs anywhere.

Beyond that, the docs oversell what works today. PLAN.md's shared-code caveat claims
type-only imports from `shared/` are safe in `.ts` nodes and only *value*
imports break at runtime. **Both halves are wrong** (verified 2026-07-18):

- esbuild refuses **any** top-level `import` — even a pure `import type` —
  in a file that also has a top-level `return`: *"Top-level return cannot be
  used inside an ECMAScript module"*. Since a Code-node body effectively
  always ends in `return`, a `.ts` node with any import fails `push` at
  compile time. Nothing broken ever reaches n8n; nothing works either.
- The typecheck wrapper (`scripts/typecheck.mts`) has the same blind spot:
  wrapping `import …` inside `async function __n8nNode() { … }` yields
  TS1232 ("import declaration can only be used at the top level").

So the *only* working shared-types path today is JSDoc `@typedef` imports in
`.js` nodes (comments are invisible to both tools). `.ts` nodes — the tier
sold as "TypeScript-first" — can import nothing at all, and `shared/` (shipped
by the template since day one) is dead weight for them. This plan makes
`import { helper, type Line } from "../../shared/money.ts"` compile into a
self-contained node body, which is strictly more than the backlog item asked
for: it unlocks type imports for `.ts` nodes as a side effect.

## Source

- [Plan 0](../draft/): "Bundle shared code into TS pushes" (graduated here).
- PLAN.md implementation note "`shared/` caveat — types yes, runtime helpers
  not yet" — this plan **corrects** that note (it is factually wrong, see
  Why) and closes its "needs `bundle: true`" pointer.

## Design decision — the compile mechanism (spiked, verified)

The naive route is impossible: esbuild's `build`/`transform` APIs hard-error
on `import` + top-level `return` in one file (direct-entry bundling was tried
and rejected in the spike). The working mechanism is **hoist → wrap → bundle
→ re-enter**:

1. **Split** the node source into its leading top-level `import` block and
   the body (with the TypeScript parser — already a dependency; not regex).
2. **Synthesize an in-memory entry** (esbuild `stdin`, no temp files):

   ```ts
   <imports>
   export default async () => {
   <body>
   };
   ```

3. **Bundle**: `build({ stdin, bundle: true, format: "iife", globalName:
   "__n8n_node", platform: "neutral", target: "node18", write: false,
   resolveDir: <the node's code/ dir>, absWorkingDir: <sync root> })`.
   `absWorkingDir` pins the `// shared/money.ts` module-header comments to
   sync-root-relative paths → output is machine-independent → sync hashes
   are stable across collaborators.
4. **Re-enter**: append the footer `return __n8n_node.default();`. The
   artifact is again a legal function body — statements followed by a
   top-level `return` — so the n8n contract, the marker append, and
   `run`'s `AsyncFunction` execution all hold unchanged.

The spike executed the artifact through `run`'s exact mechanism: n8n globals
(`$input`, `$json`, …) stay free identifiers and reach the wrapped body
through the closure; an `await`ing body works because the wrapper arrow is
`async` and n8n awaits a returned promise.

**Fast path — zero churn**: a node with no imports compiles through today's
`transform` call, **byte-identical output**. Existing `.ts` nodes see no
hash change, no "push pending" wave, no `status --diff` noise on upgrade.
Bundling only ever activates for files that could not compile at all before,
so nothing that works today changes shape.

Rules that keep it sane (all guard/compile errors, not silent behavior):

- **Imports only at the top of the file**, before the first statement. This
  keeps the hoist a pure split and keeps typecheck line-mapping an
  insert-only transform (diagnostics stay on real lines). Mid-file imports
  are a compliance error.
- **Relative imports resolve inside the sync dir** (containment against
  `configDir`); escapes above it error.
- **npm packages are opt-in, per package** (user goal 2026-07-18: "small
  libraries"): a bare specifier bundles only when its package name is listed
  in `decanter.config.json`'s **`"bundleDependencies": ["zod", …]`** —
  installed in the sync dir like any dep, inlined like `shared/`. An
  unlisted bare import errors, naming the key: a stray `import lodash` must
  not silently add 70 KB to a workflow. Scoped names (`@scope/pkg`) and
  subpath imports (`pkg/sub`) match on the package name. Pure-JS libraries
  work; the compiled-size warning is the guard against oversized graphs, and
  the lockfile is the guard against per-machine hash drift (a collaborator
  with different installed versions sees honest "push pending" drift, not
  corruption).
- **`node:*` builtins error** always — they can't be inlined, and whether the
  instance lets Code nodes `require` builtins (`NODE_FUNCTION_ALLOW_BUILTIN`)
  is a runtime policy invisible offline. Same for native addons (a library
  that ships `.node` binaries fails at bundle time with esbuild's resolution
  error).
- **`.js` nodes never bundle** — the lossless byte-identical round-trip is
  the tier's whole point. JSDoc `@typedef` stays their shared-types story.

### Interactions (why this is a plan, not a grab-bag fix)

- **Sync hashes / drift guard**: editing `shared/money.ts` changes the
  compiled output of every importing node → `status` reports them all as
  "local changes — push pending". That is *correct* (their behavior changed)
  and is the mechanism by which shared edits propagate: push re-compiles.
- **`status --diff`** (Plan 3 B) diffs compiled JS, so a shared edit shows up
  inlined in each importing node's diff — the sync-root-relative
  `// shared/…` module headers label the hunks. Readable, verified.
- **Marker** (`// @ts-n8n sha256:…`): unchanged — appended after the footer,
  hash covers the whole artifact, pull's marker detection untouched.
- **Line numbers in n8n runtime errors** shift (shared modules land above the
  body). Same accepted-cost class as the existing "comments stripped, lines
  shift" esbuild decision in PLAN.md; source maps stay off.
- **esbuild version bumps** may reshape bundle output → one-time "push
  pending" flap, re-baselined by the next push. Same exposure as today's
  `transform` output, just broader; note it, don't fight it.
- **watch does not watch `shared/`** — a shared edit syncs on the next save
  of an importing node, or an explicit `push`. Extending watch to `shared/`
  (re-pushing every importer on a helper save) is a deliberate follow-up
  decision, not a default (see Non-goals).

## Tasks

1. **`lib/compile.mts`** — `compileTs(file, { configDir })`:
   - Parse with `ts.createSourceFile`; collect leading top-level
     `ImportDeclaration`s; error on imports after the first statement, on
     bare/builtin specifiers, and on escapes above `configDir`.
   - No imports → today's `transform` path, byte-identical.
   - Imports → stdin entry, `build` per Design decision, append the
     re-enter footer.
   - Warn above a compiled-size threshold (100 KB) — a canary for
     accidentally huge shared graphs.
   - Callers (`push.mts` `buildNodeCode`, `status.mts` `localBody`,
     `run.mts`) pass `configDir` through — they already funnel into this one
     choke point, which is what keeps push/status/run/watch consistent for
     free.
2. **Compliance guard** (`lib/validate.mts`) — the *lexical* subset offline
   and sync: imports-at-top and relative-only for `.ts` node files (`check`
   stays credential- and esbuild-free; resolution/containment failures
   surface at compile time with the file and specifier named).
3. **`scripts/typecheck.mts`** — wrap after the import block instead of at
   position 0: prefix insertion line becomes per-file, diagnostic line
   mapping adjusts by insertion point (insert-only, no reordering). Shared
   files themselves are modules, not node files — `isNodeFile` already
   excludes them; make sure the *program* includes them (task 4's tsconfig
   `include`), or every import dies as TS2307 like in the spike.
4. **Template + root tsconfig** (`tsconfig.json`, `template/tsconfig.json`,
   kept in step): add `shared/**/*.ts` to `include` and
   `allowImportingTsExtensions: true` (both are `noEmit`), so editors and
   `check` resolve `../../shared/money.ts` imports. Verify the
   `decanter-ts-plugin` (Plan 4) still suppresses TS1108/1375/1378 on node
   files that are now genuine modules.
5. **Template content**: a real example helper in `template/shared/`
   (currently only `.gitkeep`), and rewrite the `shared/` guidance in
   `template/AGENTS.md.example` — including the corrected `.js`-vs-`.ts`
   story and the imports-at-top / relative-only rules.
6. **Tests**:
   - Unit (`test/unit/compile.test.mts`): fast-path byte-identity with
     today's output; bundle determinism (two runs, two cwds → identical
     artifact); footer execution via `AsyncFunction` with fake globals;
     guard errors (mid-file import, bare specifier, `node:` builtin,
     `../../..` escape).
   - e2e: convert a node to `.ts` with a `shared/` value import → push →
     mock remote contains the inlined helper + marker; pull → in sync, no
     `.remote.js`; edit the shared file → `status` flags every importer,
     `status --diff` shows the inlined change; `run` executes the importing
     node offline.
7. **Docs**: CHANGELOG (Added: value+type imports from `shared/` in `.ts`
   nodes; Fixed: importing anything in a `.ts` node no longer fails the
   compile outright). README `shared/` mention. **PLAN.md**: replace the
   wrong caveat note with the verified semantics and record the compile
   mechanism (raise with the user per CLAUDE.md — the note is factually
   wrong today independent of this plan).

## Acceptance / verification

- A `.ts` node importing `{ helper, type Line }` from `shared/` pushes a
  self-contained body that runs in n8n (mock-verified; one live-instance
  smoke in the next live session), round-trips in-sync, and executes under
  `run` offline.
- A no-import `.ts` node's compiled output is **byte-identical** to today's
  (pinned by unit test) — upgrading the CLI causes zero drift noise.
- Editing a shared helper makes `status` report every importing node as push
  pending, with a readable `--diff`; pushing re-syncs them.
- Mid-file imports, bare specifiers, builtins, and sync-dir escapes each fail
  with a named-file, named-specifier error; `check` catches the lexical
  subset offline.
- `npm test` + `npm run typecheck` green; the template's editor story
  (ts-plugin) verified against a node file that imports.

## Non-goals

- No bundling for `.js` nodes — lossless round-trip is their contract.
- No implicit npm bundling (only `bundleDependencies`-listed packages) and no
  `node:` builtins or native addons (explicit errors, see rules).
- No minification, no source maps (deterministic, diffable output wins).
- No `watch`ing of `shared/` in this plan — "save a helper, re-push all
  importers" is a separate decision with its own blast radius; backlog
  candidate once this lands.
- No change to pull: `.ts` stays one-way, `.remote.js` conflict surfacing
  unchanged (conflict files just contain bundled code now).

## Notes

- **Compression/minification of oversized bundles: dropped (user decision
  2026-07-18).** The 100 KB warning is hygiene, not a wall — the real
  ceiling is n8n's HTTP payload limit (`N8N_PAYLOAD_SIZE_MAX`, default
  16 MB, per instance) for the whole workflow JSON. Self-decompressing
  nodes were rejected outright (zlib unavailable, eval-dependent, kills
  diffability); an opt-in minify knob was considered and not backlogged.

- **Spike (2026-07-18, session scratchpad `bundle-spike/`)**: direct-entry
  bundling rejected by esbuild; hoist→wrap→bundle(iife)→footer verified
  end-to-end including execution with free-identifier globals and correct
  results; `transform` confirmed to reject even pure `import type` +
  top-level `return`; typecheck wrapper confirmed to emit TS1232 on wrapped
  imports (plus TS2307 because `shared/` isn't in the program — task 4).
- **Cross-links**: [Plan 3](../done/3-local-run-and-diff-fidelity.md)
  (`status --diff` readability of bundled output),
  [Plan 4](../done/4-editor-node-diagnostics.md) (ts-plugin must keep
  suppressing on module-shaped node files),
  [Plan 7](../done/7-engine-true-simulation-suite.md) (simulation reuses the
  same compile choke point), [Plan 11](../done/11-cli-look-and-feel.md) (diff
  styling).
- **CHANGELOG**: Added + Fixed entries per task 7; the guard's new rules are
  user-facing (Changed) only if they can reject previously-pushable files —
  they can't (those files failed to compile anyway), so no Breaking flag.
- **Ordering**: independent of Plan 3 C and Plan 13's release; safe to land
  before or after either. The live-instance smoke rides the already-planned
  live session (Plans 4/12 verification, Plan 3 C spike).
