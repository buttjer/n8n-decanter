---
title: TypeScript nodes & bundling
description: Lossless .js vs one-way .ts, the marker line, shared-code imports, npm bundling.
order: 2
---

Both tiers run as a Code-node **function body** — top-level `return`
required, and the same typed n8n globals (`$input`, `$('…')`, `DateTime`, …)
are available.

## `.js` nodes — the lossless default

What you write is byte-for-byte what runs in n8n and what round-trips back on
pull. Type safety via JSDoc (`// @ts-check` on the first line, `@typedef` for
shapes). **No imports** — a `.js` node is pushed verbatim into n8n, where
Code nodes cannot load modules; the layout guard rejects them (at push time,
and as [preflight](/docs/cli/preflight/)'s `layout` check).
Comments survive into n8n and document the node in place.

## `.ts` nodes — one-way

Choose `.ts` when the type surface is heavy (interfaces, generics,
discriminated unions). The local `.ts` is the only source of truth:

- [push](/docs/cli/push/) compiles it with esbuild and puts a **provenance
  line on line 1** of the uploaded code:

  ```js
  // n8n-decanter · workflows/orders/code/normalize-lines.ts · do not edit here · @ts-n8n sha256:39af5ea6… · v0.10.1 ca3c201 2026-08-20T09:14Z
  ```

  It says which tool wrote the node, which source file it came from, that
  editing it in n8n is pointless (the next push overwrites it), and how it was
  built — CLI version, git commit (`+dirty` when it was built from
  working-tree state), and the push time. The `@ts-n8n sha256:` part is what
  pull uses to recognize a TS-managed node, and it covers **everything below
  line 1** — so a rename, a new commit or a CLI upgrade never makes the node
  look changed. Never write that line yourself.
- **Nodes pushed by an older decanter carry the same marker as a `// @ts-n8n
  sha256:…` line at the *bottom* instead.** That form is read forever and
  counts as fully in sync: nothing re-pushes a node just to move its marker,
  and a node adopts line 1 on its next real code push. The break runs the
  other way — an **older** CLI does not recognize a node pushed by this one,
  and would treat it as a plain `.js` node on pull.
- **Comments are stripped and line numbers shift** in the compiled output —
  n8n error line numbers won't match the source, and the node code shown in
  the n8n UI is undocumented output. Documentation belongs in the `.ts`.
- [pull](/docs/cli/pull/) never touches `.ts` sources; instance-side edits
  are warned about — inspect them with [diff](/docs/cli/diff/) and port what
  you want to keep into the `.ts` by hand (the next push overwrites the remote
  edit).

To convert a node, replace `code/<node>.js` with `code/<node>.ts` and change
its `//@file:` placeholder in `workflow.json` — the tool picks up the new
extension on the next push. A [pull](/docs/cli/pull/) in between (for example
the live-mirror refresh after a structure edit) keeps your re-pointed `.ts` and
won't revert the placeholder.

The reverse works the same way: replace the `.ts` with a `code/<node>.js`
(plain JavaScript — the file is pushed verbatim) and re-point the
placeholder. The next push clears the remote `@ts-n8n` marker line (in either
position) even when the
code is otherwise identical, so the node stops being TS-managed. **Push
before you pull again**: until that push lands, a pull still sees the remote
marker and treats the node as TS-managed (renaming the file back to `.ts`).

## Shared code and npm packages

`.ts` nodes can import helper files (values *and* types) from **any folder
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

Rules: imports at the top of the file only; pure-JS packages only — unlisted
npm packages and Node builtins (`node:*`, `fs`, `crypto`, …) are **compile
errors**; a relative path leaving the sync dir, or an absolute path,
**warns without blocking**; never `require()`. `.js` nodes stay import-free —
that tier is byte-lossless by contract.
