# Plan 49 — Re-evaluate the TypeScript 7.x (native) major on each stable release

**Status:** Draft
**Priority:** P3
**Source:** backlog item (2026-07-20), standing watch item
**Snapshot:** 2026-07-26T00:00Z @ 5d288d4

Dependabot #5 tried to bump `typescript` 5.9.3 → 7.0.2; the 7.x line is
Microsoft's **native (Go) compiler rewrite**, shipped as per-platform binaries
(`@typescript/typescript-<os>-<cpu>`). It was declined
(`@dependabot ignore this major version`) because the native preview does **not**
expose the programmatic compiler API this repo builds on: `scripts/typecheck.mts`'s
custom `CompilerHost`
(`findConfigFile`/`sys`/`getParsedCommandLineOfConfigFile`/`createCompilerHost`/`createProgram`/`getPreEmitDiagnostics`/`DiagnosticCategory`)
and the TS language-service plugin exercised by `test/unit/ts-plugin.test.mts`
(`createLanguageService`/`LanguageService`/`LanguageServiceHost`/`ScriptSnapshot`/`ScriptTarget`/`ModuleKind`).

**Only adopt once a *stable* (non-preview/non-RC) TS release exposes those
APIs** — re-check whenever a new stable major lands, never on a preview. Until
then 5.x (and any transitional 6.x that keeps the JS API) is the supported line;
5.x patch/minor bumps still flow. Severity: low.

## Findings — TypeScript 6.0.3 (2026-07-26, Dependabot #167)

**6.x is the transitional JS-API line this plan anticipated: the entire
programmatic surface is intact.** Measured by installing 6.0.3 and running the
real code paths, not by reading release notes:

- `tsc -p tsconfig.cli.json` — clean.
- `scripts/typecheck.mts` — the custom `CompilerHost` path works end to end.
- `test/unit/ts-plugin.test.mts` — **10/10 pass**, including the suite that
  drives a real `createLanguageService`.

So **nothing in this plan's API-risk list applies to 6.x**; the watch item is
now specifically **TS 7 (native/Go)** and nothing earlier.

The only 6.0 breakage was unrelated to the API: `moduleResolution: node10`
became a hard error (`TS5107`). Fixed ahead of the bump by moving the node-file
tsconfig to `moduleResolution: "bundler"` + `module: "preserve"` — green on both
5.9.3 and 6.0.3, so it landed as an ordinary PR rather than inside Dependabot's
branch. Recorded because the choice is not free:

- `bundler` is the **semantically correct** mode — push compiles `.ts` nodes
  with esbuild `bundle: true` (`lib/compile.mts`), so a bundler really does
  resolve those specifiers.
- `node16`/`nodenext` were rejected: they fail the extensionless relative
  imports the template documents (`TS2835`), which would force a rewrite of
  every user's node files to carry `.js` extensions.

This removes TS 7's `node10` removal as a blocker in its own right — by the
time 7 lands, the setting is already gone.
