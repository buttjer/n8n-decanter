---
title: push
description: Push local workflows back to n8n, guarded by typecheck, compliance, and drift gates.
order: 4
---

```sh
n8n-decanter push [workflow…] [--force] [--no-typecheck]
```

Compiles and uploads each workflow through the n8n API. `.js` node files are
pushed verbatim (byte-lossless); `.ts` files are compiled with esbuild and
their imports from `shared/` and opted-in npm packages are bundled in — see
[TypeScript nodes](/docs/concepts/typescript-nodes/).

On an n8n 2.x instance, push reports whether the code **went live or stayed a
draft**: a push to an already-published workflow publishes immediately; an
unpublished workflow keeps the change as a draft.

After a successful push the folder is git-committed automatically
(`"commitOnPush": false` disables it).

## The gates

Push runs three checks, in order — [push gates](/docs/concepts/push-gates/)
has the full rules:

1. **Typecheck** — blocking; `--no-typecheck` skips it (auto-skipped when no
   `tsconfig.json` is found).
2. **Compliance guard** — layout violations are hard errors that `--force`
   does **not** bypass. Same checks as [check](/docs/cli/check/).
3. **Drift guard** — remote changed since the last sync → abort with
   `pull first`. Only this gate is bypassed by `--force`.

## Flags

- `--force` — bypass the drift guard (and watch's structural conflict
  prompts). It overrides the protection for edits made in the n8n UI — don't
  use it casually, and never let an agent use it unasked.
- `--no-typecheck` — skip the typecheck gate.
