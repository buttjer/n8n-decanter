# Plan 4 — Editor plugin to suppress spurious node-file diagnostics

**Priority:** P2
**Status:** Done (manual editor verification passed 2026-07-19; the first
failed attempt's root cause was the missed one-time *Use Workspace Version*
consent — see Task 5 resolution)
**Theme:** stop the editor's tsserver from flagging legal n8n node source
(top-level `return`/`await`) as errors, without touching files on disk.

## Source

- IDEAS: "js files throw IDE errors like TS1108 / cannot-redeclare" — the
  **TS1108 half** (the redeclare half is handled in
  [Plan 1](DONE-1-trustworthy-edit-loop.md) via `moduleDetection: "force"`).
- Related: PLAN.md "Type checking" wart (IDE tsservers show a spurious TS1108);
  `scripts/typecheck.mts`.

## Why

n8n Code node source is a **function body** (top-level `return` / `await`).
`npm run typecheck` handles this by wrapping each node file in an in-memory
`async function` (see `scripts/typecheck.mts`), so the CLI's typecheck is clean.
But the editor's TypeScript language server (VS Code's bundled tsserver, and the
same in JetBrains) reads the raw file on disk and reports errors the wrapper
would have prevented:

- **TS1108** — `A 'return' statement can only be used within a function body.`
- **TS1375 / TS1378** — top-level `await` is only allowed in a module / with a
  suitable `module` target. (Same root cause; surfaces on `await` lines.)

These are false positives for our data model: the code is legal n8n node source.
They cannot be turned off with a compiler option (there is no per-code disable),
and the tsconfig `moduleDetection` / `module` knobs do not remove TS1108
(verified empirically on TypeScript 5.6: 1108 fires in `.js` and `.ts` alike,
in script mode, CJS detection, and `moduleDetection: "force"`).

The **"cannot redeclare block-scoped variable"** half of the IDEAS entry is a
*separate* issue — cross-file global scope collision — already fixed by
`moduleDetection: "force"` (each file becomes its own module scope). That change
is staged in `template/tsconfig.json.example`; [Plan 1](DONE-1-trustworthy-edit-loop.md)
commits it. This plan is only about the 1108 / 1375 / 1378 grammar diagnostics.

**Goal:** editors show **no** false TS1108 / TS1375 / TS1378 on n8n node files,
while keeping full type checking (real type errors still surface, in the editor
and in `npm run typecheck`). No change to node file contents on disk — the
round-trip stays byte-identical (`.js`) and the disk-verbatim rule (PLAN.md)
holds.

## Non-goals

- Do not touch `scripts/typecheck.mts` behavior (CLI typecheck already correct).
- Do not write the plugin in TypeScript / `.mts` despite the CLI migration
  ([Plan 6](DONE-6-typescript-migration.md)): tsserver loads plugins via
  `require()` (CommonJS `.js`), and it ships in `template/` as sync-dir
  content — it is not CLI source and lives outside `tsconfig.cli.json`.
- Do not disable JS validation wholesale (`javascript.validate.enable: false`)
  — that would drop *all* editor diagnostics, real ones included.
- Do not add `// @ts-ignore` / `// @ts-nocheck` into node files — that pollutes
  the pushed source and is per-line/per-file toil.

## Tasks

### 1. Spike the load path first (de-risk before building)

VS Code's tsserver only loads a plugin named in tsconfig `"plugins"` if it can
**resolve the plugin package**. Confirm **Option A** (below) works before writing
the plugin: check that `typescript.tsserver.pluginPaths` accepts a
workspace-relative path and the bundled tsserver actually loads from it (watch
for the "Enable/Configure workspace plugins" trust prompt on first open). ~20
minutes. If relative paths don't resolve, switch to Option B before proceeding.

**Spike result (2026-07-18): Option A is impossible as written.**
`typescript.tsserver.pluginPaths` is a **machine-scoped** setting (verified in
VS Code's `typescript-language-features` package.json: `"scope": "machine"`) —
workspace `.vscode/settings.json` values are ignored for security, so a sync
dir cannot point the bundled tsserver at a checked-in plugin folder. Also,
tsserver rejects non-bare plugin names (`parsePackageName(...).rest` check:
"only package name is allowed plugin name"), ruling out a relative-path
`"plugins"` entry. tsserver resolves tsconfig-listed plugins from its **peer
`node_modules`** (`tsserver.js/../../..`) plus `pluginProbeLocations` — so the
plugin loads when the *workspace* TypeScript (the template's existing
`typescript` devDependency) runs tsserver and the plugin is reachable from the
sync dir's `node_modules`. That yields **Option A′** below (chosen): a `file:`
devDependency on a checked-in plugin folder + `typescript.tsdk` (which *is*
workspace-settable, behind a one-time "Use workspace version" consent). Still
no npm publish, fully offline, versioned with the sync dir; the one added
requirement is `npm install` in the sync dir — already implied by the
template's `package.json` shipping `typescript`.

### 2. Write the language-service plugin

A TS language-service plugin decorates the language service and filters
diagnostics by code, scoped to the files we choose. It runs **only** in the
editor's tsserver — `tsc` and our wrapper script are unaffected.

Recognition rule mirrors `isNodeFile` in `scripts/typecheck.mts` (keep identical
so the two definitions don't drift): extension `.ts`/`.js`, not `*.d.ts`, not
`*.remote.js`, and a `.decanter.json` sibling exists **directly, or — `code/`
layout — in the parent of the file's `code/` dir**. (An earlier sketch here
checked only the direct sibling; that would have missed every real node file,
which all live in `code/`.)

Implementation: `template/decanter-ts-plugin/index.js.example` (CommonJS, no
deps beyond the host's `typescript`). Shape: `init({ typescript }) → { create }`;
`create(info)` returns a proxy of `info.languageService` whose
`getSemanticDiagnostics` / `getSyntacticDiagnostics` drop codes 1108/1375/1378
for recognized node files, everything else delegating untouched. The
`.decanter.json` probe uses `info.languageServiceHost.fileExists`, falling back
to `ts.sys.fileExists`.

Filter **both** `getSemanticDiagnostics` and `getSyntacticDiagnostics`: grammar
errors like 1108 surface through different channels depending on TS
version/code path, and covering both is cheap and safe. (Spike sub-item
resolved: on TS 5.x, 1108 and 1378 arrive via **semantic** diagnostics — they
are grammar errors raised in the checker — as asserted by the real-language-
service unit test, which would flag a channel move in a future TS version.)

### 3. Distribution — pick the load path

**Option A′ (chosen): checked-in folder + `file:` dep + workspace TS.** The
original Option A (`pluginPaths` via `.vscode/settings.json`) is dead — the
setting is machine-scoped (see Task 1 spike result). A′ keeps its virtues (no
npm publish, offline, versioned with the sync dir) at the cost of the `npm
install` the template already implies:

- `template/decanter-ts-plugin/index.js.example` → `decanter-ts-plugin/index.js`
- `template/decanter-ts-plugin/package.json.example` → `{ "name":
  "decanter-ts-plugin", "private": true, "version": "0.0.0",
  "main": "index.js" }`
- `template/package.json.example`: `devDependencies` gains
  `"decanter-ts-plugin": "file:./decanter-ts-plugin"` — `npm install` symlinks
  the checked-in folder into `node_modules`, where tsserver's package
  resolution finds it.
- `template/tsconfig.json.example`: add
  `"plugins": [{ "name": "decanter-ts-plugin" }]` (editor-only; `tsc` and
  `scripts/typecheck.mts` ignore `plugins`).
- `template/.vscode/settings.json.example` → `.vscode/settings.json` with
  `"typescript.tsdk": "node_modules/typescript/lib"` — makes VS Code offer the
  workspace TypeScript (whose peer `node_modules` is the sync dir's, so the
  plugin resolves). One-time user consent: "TypeScript: Select TypeScript
  Version" → *Use Workspace Version*. JetBrains IDEs use the project's
  TypeScript from `node_modules` by default and load tsconfig plugins from
  there without extra config.

**Option B (fallback, not needed): publish as an npm package.** Publish
`decanter-ts-plugin` (or ship it inside `n8n-decanter` and reference by
subpath), add it to `template/package.json.example` `devDependencies`, same
`"plugins"` entry. Requires a publish/release pipeline; A′ avoids that.

### 4. Template `.example` mechanics (already verified)

`copyTemplate` in `lib/init.mts` walks recursively and strips a trailing
`.example` per file, so nested files must each carry `.example`
(`index.js.example`, `settings.json.example`) and directory names must **not**
end in `.example`. Materialization to `decanter-ts-plugin/index.js` and
`.vscode/settings.json` works as intended. Keep the full real filename before
`.example` per the CLAUDE.md convention.

### 5. Field report — first manual verification failed (2026-07-19)

User ran `init --force` into an **existing project** and still sees TS1108
on node files. `--force` does overwrite template files (only `.env` is
protected, see `copyTemplate` in `lib/init.mts`), so the plugin folder, the
tsconfig `plugins` entry, and `.vscode/settings.json` should all be on disk —
the failure is most likely in the **load path**, not materialization. Debug
checklist, in suspicion order:

1. **Workspace-root nuance (prime suspect for "existing project"):** VS Code
   reads `.vscode/settings.json` only at the **workspace root**. If the sync
   dir is a subfolder of the opened project, the template's
   `typescript.tsdk` is inert → the *built-in* tsserver runs → it resolves
   tsconfig plugins from its own peer `node_modules`, never the sync dir's.
   Even picking "Use Workspace Version" then offers the *root* project's
   TypeScript, whose peer `node_modules` also lacks the plugin.
2. **`npm install` re-run in the sync dir after init?** The plugin is a
   `file:` devDependency — without an install there is no
   `node_modules/decanter-ts-plugin`, and tsserver skips unresolvable
   `plugins` entries silently.
3. **Workspace TS actually selected?** "TypeScript: Select TypeScript
   Version" must show *Use Workspace Version* (one-time consent; the
   status-bar TS version should match the sync dir's `typescript`).
4. **Evidence:** "TypeScript: Open TS Server Log" — grep for
   `decanter-ts-plugin` (loaded vs. resolution error), and confirm the
   governing tsconfig for a node file is the sync dir's (nearest config
   above `code/`), not a parent project's tsconfig/jsconfig.

If 1 confirms, the fix is docs and/or tooling (to decide, not pre-empt):
recommend opening the sync dir as its own workspace / multi-root folder;
document setting `typescript.tsdk` at the real workspace root; or teach
`check` to detect the nesting and print the hint.

**Resolution (2026-07-19): suspect 3.** The sync dir *was* the workspace
root (1 ruled out) and `node_modules/decanter-ts-plugin` was installed
(2 ruled out) — the one-time *Use Workspace Version* consent had simply
never been clicked, so the bundled tsserver was still running. Selecting
the workspace version (TS 5.9.3) removed TS1108 immediately, and genuine
errors still surface (TS2588 in `.js`, TS6133 in `.ts`), confirming the
plugin filters only the three grammar codes. No code, template, or docs
change needed — the consent step was already documented (template
`AGENTS.md` "Writing Code node code", CHANGELOG 0.2.0); the failure was
the step being easy to skip, which the docs already warn about as loudly
as a README can.

## Acceptance / verification

- **Unit test** (`test/unit/ts-plugin.test.mts`): loads the plugin from its
  template `.example` file (copied to a temp dir as `index.js`, `require`d via
  `createRequire`) and exercises it two ways: (a) recognition/delegation against
  a stubbed language service — `code/`-layout and flat-sibling files filtered,
  no-sibling / `.d.ts` / `.remote.js` / Windows-separator cases, non-diagnostic
  methods delegate; (b) against a **real** `ts.createLanguageService` over
  in-memory node files — proves 1108/1378 actually fire un-proxied (pinning
  which channel carries them) and disappear proxied while a genuine type error
  survives. The e2e suite is CLI-driven and cannot exercise tsserver, so the
  plugin core stays testable in isolation.
- **e2e:** already covered with no edit — the `init` step walks the entire
  `template/` tree and asserts every file materializes (name `.example`-stripped,
  content byte-identical), which includes `decanter-ts-plugin/*`,
  `.vscode/settings.json`, and the updated tsconfig/package.json.
- **Manual (the real proof — passed 2026-07-19, see Task 5 resolution):**
  open a synced node file with a
  top-level `return`/`await` in VS Code; accept *Use Workspace Version* when
  prompted (after `npm install`); confirm 1108/1375/1378 are gone while a
  genuine type error (e.g. `const n: number = "x"`) still shows.

## Rollout order

1. ~~Spike Option A load path (Task 1).~~ Done — A impossible (machine-scoped
   setting), A′ chosen.
2. Write the plugin + unit test (Task 2).
3. Add template files (Task 3–4; e2e needs no edit, see Acceptance).
4. Docs (see Notes); propose PLAN.md updates to the user.
5. ~~Manual editor verification → flip Status to Done.~~ Passed 2026-07-19
   (second attempt; see Task 5 resolution).

## Notes

- **CHANGELOG.md** `[Unreleased] / Added`: editor plugin that suppresses false
  top-level-`return`/`await` errors on node files (user-facing template change).
- **PLAN.md** "Type checking": replace the "Known wart: IDE tsservers show a
  spurious TS1108" note with a description of the plugin. **Also fix the stale
  claim** that checkJs `.js` tolerates top-level `return` — it does not on
  current TypeScript (1108 fires in `.js` too); the wrapper, not the file type,
  is what makes typecheck pass. Ask the user before rewriting PLAN.md (per
  CLAUDE.md).
- Flip this plan's **Status** to `Done` once implemented + tested + documented
  (both halves: 1108 via this plugin, redeclare via `moduleDetection: "force"`
  in Plan 1).
