---
title: Push gates
description: The typecheck gate, the compliance guard, and the per-node drift guard — and what --force does.
order: 3
---

[push](/docs/cli/push/) runs three independent checks, in order. Only the
last one is bypassed by `--force`.

## 1. Typecheck gate

The same wrapper-based typecheck as [preflight](/docs/cli/preflight/)'s
`types` check — see [Type checking](/docs/concepts/type-checking/). Blocking;
skip with `--no-typecheck` (auto-skipped when no `tsconfig.json` is found).

## 2. Compliance guard

Layout violations are **hard errors that `--force` does not bypass** — they
would corrupt sync state. The full list is on the preflight page, under
[what the compliance guard catches](/docs/cli/preflight/#what-the-compliance-guard-catches):
placeholder integrity, connection integrity, duplicate names/ids, orphan files,
dangling `$('…')` references, marker misuse, and a leftover retired `fixtures/`
dir. Standalone: `n8n-decanter preflight --offline` runs this guard plus the
typecheck and nothing else — no credentials, no network, and every violation
listed under the failing `layout` check. The guard also **warns without
blocking** about an inline Python `pythonCode` node and a committed scenario
that embeds inline Code-node source under `workflowData`.

## 3. Per-node drift guard

If a Code node's **remote code** changed since the last sync (and differs
from what you're about to push), push aborts with `pull first`. This is the
only gate `--force` bypasses — it exists so you don't silently clobber code
edited on the instance. Remote **structure** changes never block a push:
pushes write only `jsCode`, and the structure snapshot is mirrored (read-only),
never pushed from here.

The interplay with pull matters: **pulling records the remote code as the
new sync base**, so after a warned pull the next push overwrites the surfaced
remote edits by design — [diff](/docs/cli/diff/) and git history are the safety
net. On the gate side the same situation shows up as preflight's `drift` check:
a node changed both locally and remotely fails it as a `CONFLICT`.

Per-node sync hashes are stored in
[`.decanter.json`](/docs/concepts/sync-layout/); "last synced" means the last
push *or* pull. A remote edit that happens to match your local code
re-baselines silently instead of aborting.
