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
are compiled with esbuild and their imports from `shared/` and opted-in npm
packages are bundled in — see
[TypeScript nodes](/docs/concepts/typescript-nodes/). Structure is never
pushed — `workflow.json` is a read-only snapshot.

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
   does **not** bypass. Same checks as [check](/docs/cli/check/).
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
