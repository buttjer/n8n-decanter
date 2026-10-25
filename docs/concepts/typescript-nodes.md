---
title: TypeScript nodes & bundling
description: Lossless plain .js vs one-way bundled .js/.ts, the marker line, shared-code imports, npm bundling.
order: 2
---

All three tiers run as a Code-node **function body** — top-level `return`
required, and the same typed n8n globals (`$input`, `$('…')`, `DateTime`, …)
are available.

## The three tiers

The `.js` tier splits in two, by whether the file has a top-level import —
a `.ts` file is always in the bundled tier:

| Tier | Has imports? | Push | Pull |
|---|---|---|---|
| plain `.js` | no | pushed verbatim, byte-for-byte | round-trips: lossless, two-way |
| bundled `.js` | yes | compiled with esbuild, line-1 marker, same as `.ts` | one-way — pull never overwrites it |
| `.ts` | — (always bundled) | compiled with esbuild, line-1 marker | one-way — pull never touches `.ts` sources |

A plain `.js` node is pushed verbatim into n8n, where Code nodes cannot load
modules on their own — **no imports** is what keeps it byte-for-byte and
two-way. Adding a top-level `import` to a `.js` file moves it into the
bundled tier: push now runs it through esbuild like a `.ts` node, and the
node becomes one-way, the same as `.ts` — see [Shared code and npm
packages](#shared-code-and-npm-packages) below. Type safety on either `.js`
tier is via JSDoc (`// @ts-check` on the first line, `@typedef` for shapes).
Comments survive into n8n on the plain tier and document the node in place;
the bundled tiers strip comments (see below).

## `.ts` and bundled `.js` nodes — one-way

Choose `.ts` when the type surface is heavy (interfaces, generics,
discriminated unions); choose an importing `.js` when you just want to pull
in a helper without switching extension. Either way, the local file is the
only source of truth once it imports something:

- [push](/docs/cli/push/) compiles it with esbuild and puts a **provenance
  line on line 1** of the uploaded code:

  ```js
  // n8n-decanter · workflows/orders/code/normalize-lines.ts · do not edit here · @ts-n8n sha256:39af5ea6… · v0.10.1 ca3c201 2026-08-20T09:14Z
  ```

  It says which tool wrote the node, which source file it came from, that
  editing it in n8n is pointless (the next push overwrites it), and how it was
  built — CLI version, git commit (`+dirty` when it was built from
  working-tree state), and the push time. The source path's extension (`.ts`
  or `.js`) is what pull uses to recognize which tier the node is on, and the
  `@ts-n8n sha256:` part covers **everything below line 1** — so a rename, a
  new commit or a CLI upgrade never makes the node look changed. Never write
  that line yourself.
- **Nodes pushed by an older decanter carry the same marker as a `// @ts-n8n
  sha256:…` line at the *bottom* instead.** That form is read forever and
  counts as fully in sync: nothing re-pushes a node just to move its marker,
  and a node adopts line 1 on its next real code push. The break runs the
  other way — an **older** CLI does not recognize a node pushed by this one,
  and would treat it as a plain `.js` node on pull.
- **Comments are stripped and line numbers shift** in the compiled output —
  n8n error line numbers won't match the source, and the node code shown in
  the n8n UI is undocumented output. Documentation belongs in the local file.
- [pull](/docs/cli/pull/) never touches `.ts` sources, and never overwrites an
  importing `.js` either; instance-side edits are warned about — inspect them
  with [diff](/docs/cli/diff/) and port what you want to keep into the local
  file by hand (the next push overwrites the remote edit).

To convert a node between tiers, edit the file and re-point its `//@file:`
placeholder in `workflow.json` if the filename changes — the tool picks up
the new extension and/or import on the next push. There are three states —
**plain `.js`** (no imports) ↔ **importing `.js`** (bundled) ↔ **`.ts`**
(always bundled) — and you can move between any two of them:

- **plain `.js` → importing `.js`**: add a top-level import to the existing
  `.js` file — no rename needed. The next push bundles it and prints a note
  that the node is now one-way.
- **importing `.js` → plain `.js`**: remove the import. The next push clears
  the remote marker and the node goes back to lossless, two-way, with a note
  that it has no imports any more.
- **`.js` ↔ `.ts`**: replace the extension (`code/<node>.js` ↔
  `code/<node>.ts`) and change the placeholder in `workflow.json` to match. A
  [pull](/docs/cli/pull/) in between (for example the live-mirror refresh
  after a structure edit) keeps your re-pointed file and won't revert the
  placeholder, as long as that file already exists locally.

In every direction, **push before you pull again**: until that push lands, a
pull still sees the remote marker (or its absence) as it was before your
edit, and resolves the node on that basis.

## Shared code and npm packages

Both `.ts` and `.js` nodes can import helper files (values *and* types, for
`.ts`) from **any folder
inside the [sync dir](/docs/concepts/sync-layout/#the-sync-dir), in any number
of folders** — `shared/` is simply the default [init](/docs/cli/init/)
scaffolds, not a rule — and from npm packages installed in the sync dir and
opted in via `"bundleDependencies"` in the
[config](/docs/concepts/configuration/):

```ts
import { total, type OrderLine } from "../../../shared/money";

const lines: OrderLine[] = $input.all().map((i) => i.json as OrderLine);
return [{ json: { total: total(lines) } }];
```

(Node files live in `workflows/<folder>/code/`, so a top-level helper root is
three levels up.) Write the specifier **extensionless**, as above — an
explicit `../../../shared/money.ts` is accepted too (the scaffolded
`tsconfig.json` sets `allowImportingTsExtensions`, and the bundler resolves
either), but the extensionless form keeps working if that helper ever becomes
a plain `.js` file. All three of these shapes work, together in one node if
you like:

- the scaffolded `shared/` — the default, covered by the scaffolded editor
  tooling (the agent allowlist ships `Edit(shared/**)`; widen it if you use
  another name)
- **any other folder**, at any nesting (`helpers/`, `domain/money/`)
- a **per-workflow helper dir** next to `code/`
  (`workflows/<folder>/local/…`) — sibling subdirs of a workflow folder are
  reserved for exactly this kind of thing

The boundary: a relative import should resolve **inside the sync dir**. An
import that escapes it **warns without blocking** — the finding is early,
offline, on your machine, and in decanter's words — because the escape only
endangers your own portability: the bundle still builds here, and fails
loudly (`Could not resolve`) wherever the target is genuinely absent, e.g. a
colleague's clone or CI. `preflight --fail-on=warn` is the strict variant if
you want the warning to gate. To reach code outside the sync dir in a way
that travels, package it and go the npm route
(`npm i file:../packages/x` + a `bundleDependencies` entry) — with the caveat
that a `file:`/`npm link` target *outside your repo* resolves to a
machine-specific path, so teammates would compile different bytes.

**Same-named helpers never collide by path** — `shared/money.ts` and
`domain/money.ts` are unrelated modules. What can collide is the **binding
name** you import under: aliased
(`import { total as orderTotal } from "../../../shared/money"`) the two
bundle side by side; **unaliased duplicate bindings silently last-win** —
esbuild lets the second import shadow the first with no warning, and only the
typecheck (TS2300 *Duplicate identifier*) catches it. That typecheck gates
`push`; it does **not** gate `node run`, `preflight --no-typecheck`, or a
project where `typescript` isn't installed (the check skips) — alias, or keep
basenames distinct.

Push bundles the imports into the compiled node, so the pushed code is
**self-contained and runs anywhere — n8n Cloud included**, no
`NODE_FUNCTION_ALLOW_*` setup. Each importing node carries its own copy, so
keep helpers small; editing one shared file makes **every** importing node
differ from the draft — [diff](/docs/cli/diff/) compiles before comparing, so
it lists them all, and [preflight](/docs/cli/preflight/)'s `parity` check
counts them.

Two asymmetries to know about helper files (both by design):

- **Auto-commit is scoped to the workflow folder** — a push/pull auto-commit
  includes a per-workflow helper dir, but a *top-level* helper edit is yours
  to commit.
- **`watch` observes the workflow folder and its `code/` only** — saving a
  helper does not re-push its importers; they sync on their next save or
  `push`.

Rules: imports at the top of the file only — an import below the first
statement is always warned about, never bundled, on either extension (the
layout check can't tell a stray mid-file import from a verbatim node that
happens to use the word, so it warns rather than blocking; move it to the
top either way, or the node fails: at push time for a bundled node, at
runtime in n8n for a verbatim `.js`); pure-JS packages only — unlisted npm packages and Node
builtins (`node:*`, `fs`, `crypto`, …) are **compile errors**; a relative
path leaving the sync dir, or an absolute path, **warns without blocking**;
never `require()`. A plain `.js` node (no top-level import) stays
byte-lossless by contract — adding one moves it into the bundled tier, as
above.
