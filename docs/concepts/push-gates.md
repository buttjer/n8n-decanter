---
title: Push gates
description: The typecheck gate, the compliance guard, and the drift guard — and what --force does.
order: 3
---

[push](/docs/cli/push/) runs three independent checks, in order. Only the
last one is bypassed by `--force`.

## 1. Typecheck gate

The same wrapper-based typecheck as [check](/docs/cli/check/) — see
[Type checking](/docs/concepts/type-checking/). Blocking; skip with
`--no-typecheck` (auto-skipped when no `tsconfig.json` is found).

## 2. Compliance guard

Layout violations are **hard errors that `--force` does not bypass** — they
would corrupt sync state. The full list of checks is on the
[check](/docs/cli/check/) page: placeholder integrity, connection integrity,
duplicate names/ids, orphan files, dangling `$('…')` references, marker
misuse. Standalone: `n8n-decanter check`, no credentials needed.

## 3. Drift guard

If the remote changed since the last sync, push aborts with `pull first`.
This is the only gate `--force` bypasses — it exists so you don't silently
clobber edits made in the n8n UI.

The interplay with pull matters: **pulling records the remote state as the
new sync base**, so after a warned pull the next push overwrites the surfaced
remote edits by design — `.remote.js` files and git history are the safety
net.

Sync hashes are stored in [`.decanter.json`](/docs/concepts/sync-layout/);
"last synced" means the last push *or* pull.
