# Plan 4 — Editor plugin to suppress spurious node-file diagnostics

**Priority:** P2
**Status:** Not started
**Theme:** stop the editor's tsserver from flagging legal n8n node source
(top-level `return`/`await`) as errors, without touching files on disk.

## Source

- IDEAS: "js files throw IDE errors like TS1108 / cannot-redeclare" — the
  **TS1108 half** (the redeclare half is handled in
  [Plan 1](1-trustworthy-edit-loop.md) via `moduleDetection: "force"`).
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
is staged in `template/tsconfig.json.example`; [Plan 1](1-trustworthy-edit-loop.md)
commits it. This plan is only about the 1108 / 1375 / 1378 grammar diagnostics.

**Goal:** editors show **no** false TS1108 / TS1375 / TS1378 on n8n node files,
while keeping full type checking (real type errors still surface, in the editor
and in `npm run typecheck`). No change to node file contents on disk — the
round-trip stays byte-identical (`.js`) and the disk-verbatim rule (PLAN.md)
holds.

## Non-goals

- Do not touch `scripts/typecheck.mts` behavior (CLI typecheck already correct).
- Do not write the plugin in TypeScript / `.mts` despite the CLI migration
  ([Plan 6](6-typescript-migration.md)): tsserver loads plugins via
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

### 2. Write the language-service plugin

A TS language-service plugin decorates the language service and filters
diagnostics by code, scoped to the files we choose. It runs **only** in the
editor's tsserver — `tsc` and our wrapper script are unaffected.

Recognition rule mirrors `isNodeFile` in `scripts/typecheck.mts` (keep identical
so the two definitions don't drift): extension `.ts`/`.js`, not `*.d.ts`, not
`*.remote.js`, and a `.decanter.json` sibling exists.

`decanter-ts-plugin/index.js` (CommonJS, no deps beyond the host's `typescript`):

```js
function init({ typescript: ts }) {
  const FILTERED = new Set([1108, 1375, 1378]);

  function create(info) {
    const ls = info.languageService;

    // Sibling .decanter.json check via the host's filesystem.
    const fileExists = (p) =>
      info.languageServiceHost.fileExists
        ? info.languageServiceHost.fileExists(p)
        : ts.sys.fileExists(p);
    function isNodeFile(fileName) {
      if (fileName.endsWith(".d.ts") || fileName.endsWith(".remote.js")) return false;
      if (!/\.(ts|js)$/.test(fileName)) return false;
      const dir = fileName.slice(0, fileName.lastIndexOf("/"));
      return fileExists(dir + "/.decanter.json");
    }

    const proxy = Object.create(null);
    for (const k of Object.keys(ls)) {
      proxy[k] = (...args) => ls[k].apply(ls, args);
    }
    const filterFor = (fileName, diags) =>
      isNodeFile(fileName) ? diags.filter((d) => !FILTERED.has(d.code)) : diags;

    proxy.getSemanticDiagnostics = (fileName) =>
      filterFor(fileName, ls.getSemanticDiagnostics(fileName));
    proxy.getSyntacticDiagnostics = (fileName) =>
      filterFor(fileName, ls.getSyntacticDiagnostics(fileName));

    return proxy;
  }

  return { create };
}
module.exports = init;
```

Filter **both** `getSemanticDiagnostics` and `getSyntacticDiagnostics`: grammar
errors like 1108 surface through different channels depending on TS
version/code path, and covering both is cheap and safe. (Spike sub-item: confirm
which channel actually carries 1108 in the target TS versions so we don't
over-broaden.)

### 3. Distribution — pick the load path

**Option A (recommended): self-contained folder + `pluginPaths`.** Ship the
plugin as a checked-in folder in the sync dir and point VS Code at it — no npm
publish, no install step, fully offline, versioned with the sync dir.

- `template/decanter-ts-plugin/index.js.example` → `decanter-ts-plugin/index.js`
- `template/decanter-ts-plugin/package.json.example` → `{ "name":
  "decanter-ts-plugin", "main": "index.js" }`
- `template/tsconfig.json.example`: add
  `"plugins": [{ "name": "decanter-ts-plugin" }]`
- `template/.vscode/settings.json.example` → `.vscode/settings.json` with
  `"typescript.tsserver.pluginPaths": ["./decanter-ts-plugin"]`

**Option B (fallback): publish as an npm package.** Publish `decanter-ts-plugin`
(or ship it inside `n8n-decanter` and reference by subpath), add it to
`template/package.json.example` `devDependencies`, same `"plugins"` entry. Loads
automatically from `node_modules` but requires `npm install` in the sync dir and
a publish/release pipeline. Prefer A: the sync dir is a data/config dir, not
necessarily an npm project.

### 4. Template `.example` mechanics (already verified)

`copyTemplate` in `lib/init.mts` walks recursively and strips a trailing
`.example` per file, so nested files must each carry `.example`
(`index.js.example`, `settings.json.example`) and directory names must **not**
end in `.example`. Materialization to `decanter-ts-plugin/index.js` and
`.vscode/settings.json` works as intended. Keep the full real filename before
`.example` per the CLAUDE.md convention.

## Acceptance / verification

- **Unit test** of the recognition + filter logic: import the plugin's
  `isNodeFile` / filter helper (or a small extracted module) and assert 1108 is
  stripped for a file with a `.decanter.json` sibling and preserved for one
  without. The e2e suite is CLI-driven and cannot exercise tsserver, so keep the
  plugin core testable in isolation.
- **e2e:** extend the `init` assertions so the new template files materialize
  (`decanter-ts-plugin/index.js`, `.vscode/settings.json`, tsconfig gains the
  `plugins` entry).
- **Manual (the real proof):** open a synced node file with a top-level
  `return`/`await` in VS Code; confirm 1108/1375/1378 are gone while a genuine
  type error (e.g. `const n: number = "x"`) still shows. Use the `verify` skill /
  document the manual step.

## Rollout order

1. Spike Option A load path (Task 1). If it fails, switch to Option B.
2. Write the plugin + unit test (Task 2).
3. Add template files + extend init e2e assertions (Tasks 3–4).
4. Manual editor verification.
5. Docs (see Notes); propose PLAN.md/IDEAS.md updates to the user.

## Notes

- **CHANGELOG.md** `[Unreleased] / Added`: editor plugin that suppresses false
  top-level-`return`/`await` errors on node files (user-facing template change).
- **PLAN.md** "Type checking": replace the "Known wart: IDE tsservers show a
  spurious TS1108" note with a description of the plugin. **Also fix the stale
  claim** that checkJs `.js` tolerates top-level `return` — it does not on
  current TypeScript (1108 fires in `.js` too); the wrapper, not the file type,
  is what makes typecheck pass. Ask the user before rewriting PLAN.md (per
  CLAUDE.md).
- **IDEAS.md**: check off the entry once implemented + tested + documented (both
  halves: 1108 via this plugin, redeclare via `moduleDetection: "force"` in
  Plan 1).
