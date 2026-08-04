# Plan 72 — Rename `template/` → `stub/` and `*.example` → `*.stub`

**Status:** Draft
**Priority:** P3
**Source:** maintainer request, 2026-08-04 — `.example` reads as "optional
sample" while these files are the canonical scaffold. Legacy compatibility is
explicitly a non-concern.
**Snapshot:** 2026-08-04T13:33Z @ 1955c62

Rename the scaffold directory `template/` to `stub/` and its `X.example` files
to `X.stub`, so the name says "scaffold source" instead of "sample you may
copy". Mechanically cheap and invisible to existing sync dirs — the manifest
keys the *materialized* names — but the directory half moves away from the
ecosystem-standard name, so the plan carries a smaller **suffix-only variant**
and a recommendation.

## Why

`.example` has a settled meaning in the wild (`.env.example`, `config.example.json`):
*a sample — copy it, adapt it, it is not the real file*. Decanter's template files
are the opposite: they are the canonical artifacts, copied verbatim by `init`,
hash-tracked in `.decanter-template.json`, and offered as updates on re-init
(`lib/init.mts`, the dpkg-conffile-style refresh). The suffix exists only to keep
local tooling from picking the files up — `template/package.json` would look like a
nested package, `template/tsconfig.json` would be found by editors, `.claude/hooks/*.mjs`
would be linted. Any inert suffix does that job; `.example` additionally misleads.

## Assessment — is this conventional?

Split the question in two; the answers differ.

**The suffix trick: yes, standard.** Neutralizing scaffold files with a suffix so
the host repo's tooling ignores them is common practice — Nx and Angular schematics
use `.template` (`package.json.template`), copier uses `.jinja`, create-react-app
ships `gitignore` without the dot. Changing decanter's suffix is not a departure.

**`.stub` specifically: a niche import.** `stubs/*.stub` as scaffold sources is
essentially a **Laravel/PHP** convention (`php artisan stub:publish`). In the
Node/TS ecosystem "stub" reads first as a *test double* (sinon/jest) and second as
a *type stub* (`.pyi`, `@types`). `.template` / `.tmpl` carries the same meaning
with a direct Node-ecosystem precedent and no homonym — at the cost of a stuttering
`template/CLAUDE.md.template` (which `stub/CLAUDE.md.stub` avoids, and which is
plausibly the whole motivation for renaming the directory too).

**`template/` → `stub/`: against the grain.** `template/` (or `templates/`) is the
dominant name for scaffold sources — Yeoman `app/templates/`, create-vite
`template-*`, create-react-app `template/`, Rails `lib/generators/**/templates/`.
Singular `stub/` has no precedent anywhere; even Laravel's is plural. It is also
not a purely internal path: `template/` is listed in `package.json` `files`, so it
is a real path inside `node_modules/n8n-decanter/`.

**Recommendation:** rename the suffix, keep the directory. If the stutter is
unacceptable, `stub/*.stub` is a defensible taste call — it is internally
consistent — but it is a taste call, not a correctness one. See
[Variant B](#variant-b--suffix-only-recommended).

## Scope decision the plan must settle first

The word "template" also appears in **user-facing and user-file** surfaces. The
rename either stops at the repo or cascades:

- **`.decanter-template.json`** — the per-file baseline manifest, present in *every*
  user sync dir (`lib/template.mts:11`). Renaming it is a real user-file migration,
  not repo churn. "Legacy egal" covers the repo; it does not automatically cover
  files on users' disks.
- **`init`'s log lines** — `copied template -> <dir>`, `reset template -> <dir>`,
  `added <rel> from the template`, `template up to date`, the conflict wording
  (`lib/init.mts:264`, `:308`, `:334`, `:339`).
- **`lib/template.mts`** and its exports (`classifyTemplateFile`, `TemplateManifest`,
  `TemplateOutcome`, `TEMPLATE_DIR` in `lib/init.mts:68`).

**Default for this draft:** rename the **directory and the file suffix only**. The
manifest filename, the log vocabulary, and the module/type names stay `template` —
they describe the *mechanism* (a template refresh), not the *directory*, and
renaming them buys nothing while touching every user's sync dir. Revisit only if the
maintainer wants full vocabulary consistency.

## Tasks

1. **Move the tree.** `git mv template stub`, then rename every `X.example` to
   `X.stub` (15 files today, incl. dotfile dirs `.claude/`, `.cursor/`, `.vscode/`).
   Preserve the "full real filename before the suffix" convention
   (`settings.json.stub`, not `settings.stub`).
2. **CLI.** `lib/init.mts` — `TEMPLATE_DIR` (`:68`), the suffix strip in the
   template scan (`:143`), the `${to}.example` source lookup in the rename
   resolver (`:211`), and the explanatory comments (`:449`–`:453`). Grep for the
   literal `".example"`; it is not centralized in a constant today — **introduce
   one** (`lib/template.mts`) as part of the move so the next rename is one line.
3. **Packaging.** `package.json` `files: ["template/"]` → `["stub/"]`. Verify with
   `npm pack --dry-run` that the scaffold still ships (a missing entry breaks
   `init` from the npm install, cf. CHANGELOG `:1181`).
4. **Guardrail.** `scripts/check-docs-surface.mts:300`, `:304` walks
   `REPO_ROOT/template` for the verb-last scan.
5. **Tests.** `test/unit/{init,template,globals,ts-plugin,util,check-docs-surface}.test.mts`,
   `test/e2e.mts`, `test/mcpspawn.mts`, and the field-test harness
   (`test/field-test/{stage,run}.mts`) all reference the path or suffix.
6. **Docs, all three surfaces** (root `AGENTS.md` "Documentation site" rule):
   [`docs/cli/init.md:29`](../../docs/cli/init.md) (the `X.example` sentence),
   `AGENTS.md:156`, `:530`–`:534`, `:749`–`:751`, a `CHANGELOG.md` `[Unreleased]`
   entry under **Changed**, and `PLAN.md` if it names the path. Historical
   CHANGELOG sections stay as written — they record what shipped.
7. **Sanity sweep.** `grep -rn "template/" --exclude-dir=node_modules --exclude-dir=dist`
   for stragglers, then `npm test && npm run typecheck && npm run lint && npm run check:docs`.

## Variant B — suffix only (recommended)

Tasks 1 (suffix half), 2, 5, 6 only. Directory stays `template/`, so tasks 3 and 4
vanish, `package.json` and the packaging risk are untouched, and the diff shrinks to
roughly half. Suffix choice in preference order: **`.template`** (Nx/Angular
precedent, no homonym, stutters) → `.tmpl` (same, terser, less explicit) →
`.stub` (consistent only if the directory moves too).

## Notes

- **Users are unaffected either way.** `.decanter-template.json` keys files by their
  **materialized, target-relative** path (`lib/template.mts:34`), never by the
  source name — so existing sync dirs neither migrate nor re-prompt. The blast
  radius is repo + published package only.
- **Timing: land this after the in-flight `template/` work.** A directory rename
  conflicts with every open branch that adds or edits a template file — Plan 64's
  `template/.claude/hooks/rename-refs.mjs.example` landed in #193 and is still being
  iterated on. Cheap to do, expensive to do at the wrong moment.
- Mechanical enough for Sonnet once the scope decision above is settled; the
  decision itself is the only judgment call.
- Related: [Plan 43](../done/43-emulated-globals-surface.md) — `n8n-globals.d.ts` is
  deliberately *not* a `template/*.example` duplicate (init copies the root file), so
  it needs no rename but does sit in the same copy path.
