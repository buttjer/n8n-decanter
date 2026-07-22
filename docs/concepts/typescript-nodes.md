---
title: TypeScript nodes & bundling
description: Lossless .js vs one-way .ts, the marker line, shared/ imports, npm bundling.
order: 2
---

Both tiers run as a Code-node **function body** — top-level `return`
required, and the same typed n8n globals (`$input`, `$('…')`, `DateTime`, …)
are available.

## `.js` nodes — the lossless default

What you write is byte-for-byte what runs in n8n and what round-trips back on
pull. Type safety via JSDoc (`// @ts-check` on the first line, `@typedef` for
shapes). **No imports** — a `.js` node is pushed verbatim into n8n, where
Code nodes cannot load modules; [check](/docs/cli/check/) rejects them.
Comments survive into n8n and document the node in place.

## `.ts` nodes — one-way

Choose `.ts` when the type surface is heavy (interfaces, generics,
discriminated unions). The local `.ts` is the only source of truth:

- [push](/docs/cli/push/) compiles it with esbuild and appends a
  `// @ts-n8n sha256:…` marker line to the uploaded code — the marker is how
  pull recognizes a TS-managed node. Never write that marker yourself.
- **Comments are stripped and line numbers shift** in the compiled output —
  n8n error line numbers won't match the source, and the node code shown in
  the n8n UI is undocumented output. Documentation belongs in the `.ts`.
- [pull](/docs/cli/pull/) never touches `.ts` sources; instance-side edits
  are warned about — inspect them with `status --diff` and port what you want
  to keep into the `.ts` by hand (the next push overwrites the remote edit).

To convert a node, replace `code/<node>.js` with `code/<node>.ts` and change
its `//@file:` placeholder in `workflow.json` — the tool picks up the new
extension on the next push.

The reverse works the same way: replace the `.ts` with a `code/<node>.js`
(plain JavaScript — the file is pushed verbatim) and re-point the
placeholder. The next push clears the remote `@ts-n8n` marker even when the
code is otherwise identical, so the node stops being TS-managed. **Push
before you pull again**: until that push lands, a pull still sees the remote
marker and treats the node as TS-managed (renaming the file back to `.ts`).

## Shared code and npm packages

`.ts` nodes can import from `shared/*.ts` (values *and* types) and from npm
packages installed in the sync dir and opted in via `"bundleDependencies"` in
the [config](/docs/concepts/configuration/):

```ts
import { total, type OrderLine } from "../../shared/money";

const lines: OrderLine[] = $input.all().map((i) => i.json as OrderLine);
return [{ json: { total: total(lines) } }];
```

Push bundles the imports into the compiled node, so the pushed code is
**self-contained and runs anywhere — n8n Cloud included**, no
`NODE_FUNCTION_ALLOW_*` setup. Each importing node carries its own copy, so
keep helpers small; editing a shared file marks every importing node as
push-pending in [status](/docs/cli/status/).

Rules: imports at the top of the file only; relative paths must stay inside
the repo; pure-JS packages only — unlisted npm packages and Node builtins
(`node:*`, `fs`, `crypto`, …) are compile errors; never `require()`. `.js`
nodes stay import-free — that tier is byte-lossless by contract.
