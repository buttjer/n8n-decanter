# Plan 6 — TypeScript migration of the CLI

**Priority:** P3
**Status:** In progress
**Theme:** convert the CLI's own source (`n8n-decanter.mjs`, `lib/`, `scripts/`,
`test/`) from untyped `.mjs` to strict TypeScript `.mts`, run natively via
Node's type stripping — no build step, no change to the data model or to how
sync dirs work.

## Source

- IDEAS: "**[P3]** Transform to TypeScript Project".
- Related PLAN.md refs: repo layout listing (`n8n-decanter.mjs`,
  `scripts/typecheck.mjs`), the "Type checking" section, and the decision note
  "a thin CLI entry instead of one big `n8n-decanter.mjs`".

## Why

The CLI is ~1.9k lines of untyped ESM. The interesting bugs in this codebase
live at data-model seams — the `.decanter.json` state shape, the workflow JSON
node/connection structure, the four-way status classification, hash
provenance ("from the PUT *response*") — exactly the kind of invariants a type
checker holds better than prose. The repo already carries `typescript` as a
dependency (for the node-file wrapper) and `esbuild` (for `.ts` node
compiles), so migrating adds **zero new runtime dependencies**.

What must *not* change:

- **The workflow node-file checking model.** The root `tsconfig.json` is not
  the CLI's config — it is the *node-file* config that
  `scripts/typecheck.mjs` discovers via `ts.findConfigFile(process.cwd(), …)`
  and that `runTypecheck` (`lib/validate.mjs`) locates by upward search from
  the config dir. Its name and include set are load-bearing in this repo and
  in every sync dir (materialized from `template/tsconfig.json.example`).
- **Run-from-source.** Everything invokes the CLI directly (`node
  n8n-decanter.mjs …` in README/CLAUDE.md, `test/e2e.mjs` execs it as a
  subprocess, the `bin` field points at the source file). A `dist/` build step
  would complicate all of these for no user benefit.

## Design decision

### Runtime: native type stripping (Option A — recommended)

Rename sources to `.mts` and let Node run them directly. Type stripping is
enabled by default since Node 22.18 / 23.6 (dev machine is on 22.19).
Consequences:

- `engines` bumps from `>=18.17` to `>=22.18` — **breaking**, but Node 18 went
  EOL 2025-04 and Node 20 EOL 2026-04, so every supported Node satisfies it.
- Only *erasable* syntax is allowed (no `enum`, `namespace`, parameter
  properties). Enforced at check time via `erasableSyntaxOnly` (needs
  TypeScript ≥ 5.8; the declared `^5.6.0` range already admits it — bump the
  range to `^5.8.0` explicitly). The current codebase uses none of these.
- Relative imports must name the real file: `import { N8nApi } from
  "./lib/api.mts"` (Node does not rewrite specifiers). `tsc` accepts this with
  `allowImportingTsExtensions` + `noEmit`.
- Node still type-*strips*, never type-*checks* — correctness comes from the
  `tsc -p tsconfig.cli.json` gate below.

Rejected alternatives:

- **Option B — build step to `dist/`** (tsc emit or esbuild): keeps
  `engines >=18.17` but breaks run-from-source everywhere (bin, e2e subprocess
  exec, README invocations) and adds a publish/build pipeline this project
  doesn't have. Fallback only if the engines bump turns out to be
  unacceptable.
- **Option C — JSDoc + `checkJs` on the existing `.mjs`**: zero runtime risk,
  but it isn't "a TypeScript project" (the IDEAS entry), and interface/union
  modelling of the data-model seams — the actual payoff — is markedly worse in
  JSDoc.

### Config layout: second config, root name untouched

The CLI gets its own `tsconfig.cli.json`; the root `tsconfig.json` keeps its
current contents and role (workflow node files). Editor coverage of the CLI
files is wired by adding `"references": [{ "path": "./tsconfig.cli.json" }]`
to the root config — tsserver consults a config's project references when the
nearest config doesn't include the opened file. References do not enter
`parsed.fileNames`, so `scripts/typecheck.mjs` and the push-gate program are
unaffected, and the *template* tsconfig (sync dirs) is untouched.

Fallback if the references trick doesn't light up in the editor (spike, Task
1): move CLI source under `src/` with a nested `src/tsconfig.json`
(nearest-config resolution then just works) — bigger diff and a PLAN.md layout
change, so only on demonstrated need.

## Non-goals

- No `dist/`, bundling, or publish pipeline; run-from-source stays.
- No change to workflow node files, the function-body wrapper, or the root /
  template tsconfig semantics — [Plan 1](1-trustworthy-edit-loop.md) and
  [Plan 4](4-editor-node-diagnostics.md) own that territory.
- No change to the data model (`.decanter.json`, placeholders, markers) or any
  sync behavior; the e2e suite's byte-identical round-trip assertions must
  pass unchanged.
- No restructure to `src/` unless the Task-1 spike forces it.
- Template contents unchanged except filename strings inside
  `settings.local.json.example` (see Task 5).

## Tasks

### 1. Preflight spike (de-risk before renaming anything)

~30 minutes, in a scratch copy:

- Rename the entry to `.mts`, run `node n8n-decanter.mts help` on Node 22.18+.
  Check whether an `ExperimentalWarning` for type stripping lands on stderr;
  if it does, decide suppression (shebang `#!/usr/bin/env -S node
  --disable-warning=ExperimentalWarning`, or accept the noise) and audit which
  e2e assertions read stderr before choosing.
- `npm link` with `bin` pointing at the `.mts` file; confirm the shim runs.
- Add the `references` entry to root `tsconfig.json` plus a stub
  `tsconfig.cli.json`; open a `lib/*.mts` file in VS Code and confirm it binds
  to the CLI project (e.g. `@types/node` types resolve on `process`). If not,
  switch to the `src/` fallback before proceeding.
- Bump `typescript` to `^5.8.0` and rerun `npm test` — confirms the TS bump
  doesn't shift node-file wrapper diagnostics.

### 2. `tsconfig.cli.json` + dependencies

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["n8n-decanter.mts", "lib/**/*.mts", "scripts/**/*.mts", "test/**/*.mts"]
}
```

- devDependencies: add `@types/node` (`^22`, matching the engines floor);
  bump `typescript` to `^5.8.0`.
- `package.json` scripts: `"typecheck": "tsc -p tsconfig.cli.json && node
  scripts/typecheck.mts"` — one command, both halves. The push/check gate
  (`runTypecheck`) keeps invoking only the node-file script; sync dirs must
  not start typechecking CLI source.

### 3. Mechanical rename (own commit, no logic changes)

`git mv` every file so rename detection keeps history reviewable:
`n8n-decanter.mjs` → `.mts`; the thirteen `lib/*.mjs` modules;
`scripts/typecheck.mjs`; `test/e2e.mjs`. In the same commit update every
relative import specifier to its `.mts` form and nothing else — the diff
should be extensions only. (`workflows/` node files and everything under
`template/` are *not* renamed; they're data, not CLI source.)

### 4. Type the seams (the payoff commit)

- New `lib/types.mts` holding the data-model types: `WorkflowJson` /
  `WorkflowNode` / `Connections`, `DecanterState` (node-id → filename map,
  `lastPushedHash`, `lastPulledWorkflowHash`), `DecanterConfig`, and the `log`
  interface threaded through every command.
- Annotate exported signatures across `lib/`; convert existing JSDoc comments
  to real types. Under `strict: true`, JSON.parse boundaries (`workflow.json`,
  `.decanter.json`, API responses, the e2e mock db) get `unknown`/narrow or a
  deliberate cast at the parse site — not `any` spread through the call
  graph.
- Where typing exposes a live bug, fix it in a separate commit with a test —
  don't fold behavior changes into the migration.

### 5. Rewire path references

- `package.json`: `bin` → `./n8n-decanter.mts`, `engines` → `>=22.18`.
- `lib/validate.mts`: the `../scripts/typecheck.mjs` URL → `.mts`.
- `test/e2e.mts`: the `CLI` constant.
- `README.md`: all `node n8n-decanter.mjs …` invocations and the
  `scripts/typecheck.mjs` link.
- Permission strings: `.claude/settings.json` (`Bash(node n8n-decanter.mjs
  *)`) and `template/.claude/settings.local.json.example` (two `push --force`
  entries) — the template change is user-facing (materializes into sync
  dirs).
- Final sweep: `grep -rn '\.mjs'` (excluding node_modules/CHANGELOG/plans)
  must come back clean of stale CLI references.

### 6. Documentation

- **CHANGELOG.md** `[Unreleased]`:
  - `Changed` — **Breaking:** requires Node ≥ 22.18; CLI entry renamed to
    `n8n-decanter.mts` (invoke as `node n8n-decanter.mts …` or via the bin).
  - The internal typing work itself gets no entry.
- **PLAN.md**: repo-layout listing, "Type checking" section, and the CLI-entry
  decision note all name `.mjs` files — propose the updates and **ask the user
  first** (per CLAUDE.md).
- **CLAUDE.md**: Commands block and the architecture bullet — same rule.
- **IDEAS.md**: check the entry off only when all of the above is done.

## Acceptance / verification

- `npm test` passes with the e2e suite exec'ing the `.mts` CLI as a
  subprocess; the byte-identical round-trip assertions are untouched.
- `npm run typecheck` is green — and demonstrably two-headed: a planted type
  error in `lib/` fails the tsc half; a planted error in a workflow node file
  fails the wrapper half with correctly mapped line numbers.
- `npm link` on a clean Node ≥ 22.18 → `n8n-decanter help` prints usage (no
  build step ran).
- Sync-dir regression: in an init'ed dir, `push`/`check` still find the
  materialized `tsconfig.json` by upward search and typecheck only node files
  (covered by e2e).
- Editor: a `lib/*.mts` file shows strict diagnostics under
  `tsconfig.cli.json`; a workflow node file still behaves per the root config.

## Notes

- **Outcome (2026-07-17):** implemented on branch `typescript-migration`
  (rename commit + typing commit), out of order with the user's OK —
  plans 1–5 hadn't started, so the ordering concern reduced to reference
  churn, handled by updating the file references in those plan docs.
  One deviation from the sketch: tsserver requires a *referenced* project
  to be `composite` (may not `noEmit`), so `tsconfig.cli.json` uses
  composite + declaration-only emit into `node_modules/.cache` instead of
  `noEmit` — same checking, no visible build artifacts. Still open:
  PLAN.md + CLAUDE.md updates (ask-first rule) and an editor spot-check
  of the project binding.
- **Ordering:** run this *after* plans 1–4 land. Plans 1 and 4 both touch or
  reference `scripts/typecheck.mjs` and the template hooks; migrating first
  would churn their file references mid-flight. Matches the P3 tag.
- The erasable-syntax constraint (`erasableSyntaxOnly`) is a permanent style
  rule for CLI code from then on: no enums, no namespaces, no parameter
  properties.
- Node's type stripping executes without checking — the safety story is the
  `tsc` gate plus e2e, same trust model as today, now with types.
- If a future need for `engines >=18.x` compatibility appears (unlikely), the
  escape hatch is Option B: an esbuild pass emitting `.mjs` next to a
  `prepublishOnly` hook — deliberately out of scope now.
