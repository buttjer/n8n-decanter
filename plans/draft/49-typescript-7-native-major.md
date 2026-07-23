# Plan 49 — Re-evaluate the TypeScript 7.x (native) major on each stable release

**Status:** Draft
**Priority:** P3
**Source:** backlog item (2026-07-20), standing watch item
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

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
