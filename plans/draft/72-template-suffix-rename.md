# Plan 72 — `template/*.example` → `template/*.template`

**Status:** Draft
**Priority:** P3
**Source:** maintainer request, 2026-08-04. Originally proposed as
`template/` → `stub/` plus a `.stub` suffix; **hard-reduced to the suffix alone**
after the convention check below. Legacy compatibility is explicitly a non-concern.
**Snapshot:** 2026-08-04T14:03Z @ 1955c62
**Model:** Sonnet — mechanical once the contract wording is drafted.

Rename the scaffold suffix from `.example` to `.template`, so the files say
"scaffold source" instead of "optional sample", and centralize the suffix in one
constant. Cosmetic for users (`init` materializes `X` either way, and the manifest
keys the materialized names) — this is a correctness-of-naming cleanup whose real
work is the **documented contracts**, not the file moves.

## Why

`.example` has a settled meaning (`.env.example`, `config.example.json`): *a sample —
copy it, adapt it, it is not the real file*. Decanter's template files are the
opposite: canonical artifacts, copied verbatim by `init`, hash-tracked in
`.decanter-template.json`, offered as updates on re-init. The suffix exists only to
keep local tooling from picking them up (`template/package.json` would look like a
nested package, `template/tsconfig.json` would be found by editors, `.claude/hooks/*.mjs`
would be linted) — any inert suffix does that; `.example` additionally misleads.

**Why `.template` and not `.stub`:** neutralizing scaffold files with a suffix is
standard practice, and `.template` is the Node-ecosystem spelling of it — **Nx and
Angular schematics** ship `package.json.template`; copier uses `.jinja`; CRA ships
`gitignore` undotted. `.stub` is a **Laravel/PHP** convention (`php artisan stub:publish`);
in Node/TS "stub" reads first as a test double (sinon/jest), second as a type stub.
Cost of `.template`: `template/CLAUDE.md.template` stutters. Accepted.

## Non-goals

Explicitly out of scope — these were in the original proposal and are dropped:

- **Renaming `template/`.** `template/` (or `templates/`) *is* the ecosystem
  convention (Yeoman, create-vite, CRA, Rails, cookiecutter); singular `stub/` has no
  precedent. It is also a published path (`package.json` `files` → visible in
  `node_modules/n8n-decanter/`). Nothing to gain.
- **`.decanter-template.json`.** Lives in every user sync dir; renaming it is a real
  user-file migration for zero benefit. The name describes the *mechanism*, which is
  unchanged.
- **`init`'s log vocabulary** (`copied template -> …`, `template up to date`) and
  `lib/template.mts` / `classifyTemplateFile` / `TemplateManifest`. Same reasoning.

## Tasks

1. **Centralize the suffix.** `".example"` is hardcoded at three sites in
   [`lib/init.mts`](../../lib/init.mts) — the scan's strip (`:143`–`:144`) and the
   rename resolver's source lookup (`:211`). Export a `TEMPLATE_SUFFIX` from
   [`lib/template.mts`](../../lib/template.mts) (next to `MANIFEST_FILE`) and use it
   at all three, so any future change is one line. **Do this first** — the rest of
   the code change is then trivial.
2. **Rename the 15 files.** `git mv X.example X.template` across `template/`,
   including the dotfile dirs (`.claude/`, `.claude/hooks/`, `.cursor/rules/`,
   `.vscode/`, `decanter-ts-plugin/`). Keep the standing rule that the **full real
   filename precedes the suffix** (`settings.json.template`, not `settings.template`).
   Note `template/.env.example` → `.env.template`: `.example` is idiomatic for that
   one filename, but it materializes as `.env` and is never seen under either name —
   consistency inside the directory wins.
3. **Contracts** — the documented rules other agents follow. This is the substance
   of the plan; a rename that leaves these saying `.example` is worse than no rename:
   - [`AGENTS.md:530`–`:534`](../../AGENTS.md) — the template-file naming rule
     ("Files named `X.example` are inert in this repo on purpose … always use the
     full real filename before `.example`"). Rewrite for `.template`, and keep the
     *why* (tooling inertness) — that is the part agents get wrong.
   - `AGENTS.md:749`–`:751` — housekeeping drift audit ("`template/*.example` still
     match their repo counterparts"; the Plan 43 "no `template/*.example` duplicate"
     note).
   - `PLAN.md:1053` (`X.example` materialization, in the init/manifest contract),
     `:1105` (Plan 43 single-sourcing), and `:710` / `:1073` — both name
     `AGENTS.md.example` as the template's agent contract.
   - In-code contract comments: `lib/init.mts:115`, `:449`–`:453`.
4. **Docs & changelog** (root `AGENTS.md` "Documentation site" rule):
   [`docs/cli/init.md:29`](../../docs/cli/init.md) — the user-facing "Files named
   `X.example` in the template land as `X`" sentence — plus a `CHANGELOG.md`
   `[Unreleased]` **Changed** entry (template contents are user-facing). Historical
   changelog sections stay as written: they record what shipped. README needs nothing —
   it never names the suffix.
5. **Tests.** `test/unit/{init,template,globals,ts-plugin,util}.test.mts`,
   `test/e2e.mts`, `test/mcpspawn.mts`, and `test/field-test/{stage,run}.mts` — grep
   for `.example` and for `template/`.

## Acceptance / verification

- `grep -rn "\.example" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git`
  returns only `example.com` hostnames and historical `CHANGELOG.md` sections.
- `npm test && npm run typecheck && npm run lint && npm run check:docs` green.
- `npm pack --dry-run` still lists the renamed template files (a scaffold missing
  from the tarball breaks `init` from an npm install — cf. `CHANGELOG.md:1181`).
- A fresh `init` into a temp dir materializes the same file set as before, and a
  **re-init on a sync dir created by the previous release** reports "up to date" —
  proving the manifest (which keys materialized names) is untouched by the rename.

## Notes

- **Users are unaffected.** `.decanter-template.json` keys files by their
  materialized, target-relative path (`lib/template.mts:34`), never by the source
  name — existing sync dirs neither migrate nor re-prompt. Blast radius is the repo
  and the published tarball's internal filenames.
- **Timing.** A `template/` rename conflicts with any open branch touching those
  files; Plan 64's `template/.claude/hooks/rename-refs.mjs.example` landed in #193
  and is still being iterated on. Land this when that settles.
- Related: [Plan 43](../done/43-emulated-globals-surface.md) — `n8n-globals.d.ts` is
  deliberately *not* a `template/*.example` duplicate (init copies the root file), so
  it gains no suffix, but its rule text in `AGENTS.md`/`PLAN.md` is in task 3.
