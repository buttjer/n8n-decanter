# Plan: TS language-service plugin to suppress spurious node-file diagnostics in the editor

**Priority:** High
**Status:** Not started
**Closes:** IDEAS.md entry — "js files throw IDE errors like TS1108 / cannot-redeclare"
**Related:** PLAN.md "Type checking" wart (IDE tsservers show a spurious TS1108); `scripts/typecheck.mjs`

## Problem

n8n Code node source is a **function body** (top-level `return` / `await`).
`npm run typecheck` handles this by wrapping each node file in an in-memory
`async function` (see `scripts/typecheck.mjs`), so the CLI's typecheck is clean.
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

Note: the **"cannot redeclare block-scoped variable"** half of the IDEAS entry
is a *separate* issue — cross-file global scope collision — and is already fixed
by `moduleDetection: "force"` (each file becomes its own module scope). That
change is currently staged in `template/tsconfig.json.example`; **keep it**.
This plan is only about the 1108 / 1375 / 1378 grammar diagnostics.

## Goal

Editors show **no** false TS1108 / TS1375 / TS1378 on n8n node files, while
keeping full type checking (real type errors still surface, in the editor and in
`npm run typecheck`). No change to node file contents on disk — the round-trip
must stay byte-identical (`.js`) and the disk-verbatim rule (PLAN.md) must hold.

### Non-goals

- Do not touch `scripts/typecheck.mjs` behavior (CLI typecheck already correct).
- Do not disable JS validation wholesale (`javascript.validate.enable: false`)
  — that would drop *all* editor diagnostics, real ones included.
- Do not add `// @ts-ignore` / `// @ts-nocheck` into node files — that pollutes
  the pushed source and is per-line/per-file toil.

## Approach: a TypeScript language-service plugin

A TS language-service plugin can decorate the language service and filter
diagnostics by code, scoped to the files we choose. It runs **only** in the
editor's tsserver — `tsc` and our wrapper script are unaffected.

### Recognition rule (reuse the CLI's)

A file is an n8n node file iff (mirror `isNodeFile` in `scripts/typecheck.mjs`):

- extension is `.ts` or `.js`, and
- it is **not** `*.d.ts` and **not** `*.remote.js`, and
- a `.decanter.json` sibling exists in the same directory.

Keeping this identical to the CLI avoids two different definitions of "node
file" drifting apart.

### Plugin sketch

`decanter-ts-plugin/index.js` (CommonJS, no deps beyond the `typescript` the
host injects):

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
errors like 1108 are surfaced through different channels depending on TS
version/code path, and covering both is cheap and safe. (Spike item below:
confirm which channel actually carries 1108 in the target TS versions so we
don't over-broaden.)

## Distribution — the load-path decision

VS Code's tsserver only loads a plugin named in tsconfig `"plugins"` if it can
**resolve the plugin package**. Two viable ways to make it resolvable in a user's
sync dir; pick one:

### Option A (recommended): self-contained folder + `pluginPaths`

Ship the plugin as a checked-in folder in the sync dir and point VS Code at it —
no npm publish, no install step, fully offline, versioned with the sync dir.

- `template/decanter-ts-plugin/index.js.example` → materializes as
  `decanter-ts-plugin/index.js`
- `template/decanter-ts-plugin/package.json.example` → `{ "name":
  "decanter-ts-plugin", "main": "index.js" }`
- `template/tsconfig.json.example`: add
  `"plugins": [{ "name": "decanter-ts-plugin" }]`
- `template/.vscode/settings.json.example` → materializes as
  `.vscode/settings.json` with
  `"typescript.tsserver.pluginPaths": ["./decanter-ts-plugin"]`
  (adds the folder to the plugin probe locations so the tsconfig-named plugin
  resolves without being in `node_modules`).

**Spike / main risk:** confirm `pluginPaths` accepts a workspace-relative path
and that the bundled tsserver actually loads the plugin from it (watch for the
"Enable/Configure workspace plugins" trust prompt VS Code shows the first time).
If relative paths don't resolve, fall back to Option B or document the one-time
trust click. This is the one unknown to de-risk first — do a 20-minute spike
before building the rest.

### Option B: publish as an npm package, install into the sync dir

- Publish `decanter-ts-plugin` (or a scoped name) to npm, or ship it inside the
  `n8n-decanter` package and reference by subpath.
- Add it to `template/package.json.example` `devDependencies`.
- `template/tsconfig.json.example`: same `"plugins"` entry.
- Loads automatically from `node_modules` (VS Code's standard workspace-plugin
  path — this is how `typescript-plugin-css-modules` et al. work), but requires
  `npm install` in the sync dir and a publish/release pipeline.

Prefer A: the sync dir is a data/config dir, not necessarily an npm project, and
requiring `npm install` there is friction. B is the fallback if A's load path
proves unreliable.

## Template `.example` mechanics (already verified)

`copyTemplate` in `lib/init.mjs` walks directories recursively and strips a
trailing `.example` per file. So nested files must each carry `.example`
(`index.js.example`, `settings.json.example`), and directory names must **not**
end in `.example`. Materialization to `decanter-ts-plugin/index.js` and
`.vscode/settings.json` works as intended. Keep the full real filename before
`.example` per the CLAUDE.md convention.

## Testing

- The e2e suite (`test/e2e.mjs`) is CLI-driven and cannot exercise tsserver, so
  automated coverage of the editor behavior isn't feasible there. Add instead:
  - A **unit test of the recognition + filter logic** (import the plugin's
    `isNodeFile` / filter helper, or a small extracted module, and assert 1108
    is stripped for a file with a `.decanter.json` sibling and preserved for one
    without). Keep the plugin's core testable in isolation.
  - Extend the existing `init` e2e assertions to check that the new template
    files materialize (`decanter-ts-plugin/index.js`, `.vscode/settings.json`,
    tsconfig gains the `plugins` entry).
- **Manual verification** (the real proof): open a synced `.ts`/`.js` node file
  with a top-level `return`/`await` in VS Code and confirm 1108/1375/1378 are
  gone while a genuine type error (e.g. `const n: number = "x"`) still shows.
  Use the `verify` skill / document the manual step.

## Docs to update (same change)

- **CHANGELOG.md** `[Unreleased] / Added`: editor plugin that suppresses false
  top-level-`return`/`await` errors on node files (user-facing template change).
- **PLAN.md** "Type checking": replace the "Known wart: IDE tsservers show a
  spurious TS1108" note with a description of the plugin. **Also fix the stale
  claim** that checkJs `.js` tolerates top-level `return` — it does not on
  current TypeScript (1108 fires in `.js` too); the wrapper, not the file type,
  is what makes typecheck pass. Ask the user before rewriting PLAN.md (per
  CLAUDE.md).
- **IDEAS.md**: check off the entry once implemented + tested + documented
  (both halves: 1108 via the plugin, redeclare via `moduleDetection: "force"`).

## Rollout order

1. Spike Option A load path (pluginPaths + relative folder + trust prompt). If
   it fails, switch to Option B before proceeding.
2. Write the plugin + a unit test of recognition/filtering.
3. Add template files (`decanter-ts-plugin/*`, `.vscode/settings.json`,
   tsconfig `plugins`), extend init e2e assertions.
4. Manual editor verification.
5. CHANGELOG; propose PLAN.md/IDEAS.md updates to the user.
