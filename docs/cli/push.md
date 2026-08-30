---
title: push
description: Push Code-node source to the workflow's draft, guarded by typecheck, compliance, and drift gates.
order: 4
---

```sh
n8n-decanter push [workflow…] [--force] [--publish] [--no-typecheck]
```

Compiles and uploads each workflow's **Code-node source** over n8n's MCP
server — one atomic batch of `jsCode`-only updates, addressed to each node by
its current name (ids anchor the mapping, so renames made elsewhere don't
matter). `.js` node files are pushed verbatim (byte-lossless); `.ts` files
are compiled with esbuild and their imports — helper files from anywhere in
the [sync dir](/docs/concepts/sync-layout/#the-sync-dir) (`shared/` by
default) and opted-in npm
packages — are bundled in — see
[TypeScript nodes](/docs/concepts/typescript-nodes/). Structure is never
pushed — `workflow.json` is a read-only snapshot.

A compiled `.ts` node is uploaded with a **provenance line on line 1** —
`// n8n-decanter · <source path> · do not edit here · @ts-n8n sha256:… ·
v<version> <commit> <time>` — so whoever opens the node in the n8n UI can tell
which file it was built from, that editing it there is pointless, and how it
was built. It is not hashed, so a rename, a new commit or a CLI upgrade never
queues a push; see
[TypeScript nodes](/docs/concepts/typescript-nodes/#ts-nodes--one-way).

**Every push lands on the workflow's draft.** The live (published) version
does not change until [`publish`](/docs/cli/publish/) — or `push --publish`,
which publishes right after a successful push. n8n keeps running the
published version in between.

After a successful push the folder is git-committed automatically
(`"commitOnPush": false` disables it).

## The gates

Push runs three checks, in order — [push gates](/docs/concepts/push-gates/)
has the full rules:

1. **Typecheck** — blocking; `--no-typecheck` skips it (auto-skipped when no
   `tsconfig.json` is found).
2. **Compliance guard** — layout violations are hard errors that `--force`
   does **not** bypass. The full list is under
   [preflight](/docs/cli/preflight/#what-the-compliance-guard-catches), which
   runs the same guard as its `layout` check.
3. **Per-node drift guard** — a Code node's remote code changed since the
   last sync → abort with `pull first`. Only this gate is bypassed by
   `--force`. Remote *structure* changes never block a push.

## Flags

- `--publish` — take the draft live after a successful push (also publishes
  when there was nothing new to push).
- `--force` — bypass the per-node drift guard. It overrides the protection
  for code edited on the instance — don't use it casually, and never let an
  agent use it unasked.
- `--no-typecheck` — skip the typecheck gate.
