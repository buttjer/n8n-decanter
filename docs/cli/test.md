---
title: test
description: Grade the draft on your n8n instance — statically, or with a pinned run.
order: 10
---

```sh
n8n-decanter test <workflow> [--execution <execution-id> | --scenario <slug>] [--trigger <node>] [--json]
```

`test` grades **the draft on your instance** — the thing
[`publish`](/docs/cli/publish/) would take live. It has two tiers.

## Bare: the static tier — nothing runs

```sh
n8n-decanter test <workflow>
```

Reads the draft and checks it for dangling `$('…')` references, in Code-node
source *and* in other nodes' expression parameters. **It executes nothing** and
needs no capture, no scenario, and no pinning — so it always works, including on
a fresh clone.

This is the cheap half of the same question the pinned run asks, and it is what
[`publish`](/docs/cli/publish/) refuses on. The usual cause of a finding is a
rename: n8n's `renameNode` MCP op rewrites the node name and the connections
only and leaves every reference behind (the n8n editor does rewrite them). The
output names both halves and the order to repair them in — see
[`pull`](/docs/cli/pull/#renames-and-migrations).

> A green bare `test` means "statically clean, nothing was executed". It is not
> a statement that the workflow runs. For that, pin it:

## With `--execution` / `--scenario`: the pinned run

Runs the workflow **on your n8n instance** (MCP `test_workflow`) with
external touchpoints pinned: the trigger, credentialed nodes, and HTTP
Request nodes are fed captured data, while logic nodes (Code, Set, If, …)
**execute for real** — on the instance's exact engine version, community
nodes included, no Docker needed. The run targets the **draft** and is
synchronous (the server caps it at 5 minutes; a timeout is reported as
such). Afterwards each pure node's output is diffed client-side against the
capture — divergence exits 1, so it's CI-gateable like the local-engine
[`preflight --simulate`](/docs/cli/preflight/#the---simulate-stage).

Pins come from the same sources that stage uses: a fetched capture
(`--execution <id>`) or a committed [scenario](/docs/cli/scenario/)
(`--scenario <slug>`). **One of the two is required** — there is no fallback to
"the newest capture lying around", because a bare `test` must never execute. A
trigger/network node with no captured output **aborts before anything runs** —
an unpinned one would hit the real world. So does a dangling `$('…')` reference:
the static tier runs first, and a known-broken draft is never fired at the
instance. `--trigger <node>` picks the start trigger in multi-trigger workflows.

**Synthetic pins are the exception to the diff.** A `--scenario` with any
`authored`/`scaffolded` node (see
[provenance](/docs/cli/scenario/#provenance-and-synthetic-pins)) is reported
"**synthetic pins — proves executability, not output correctness**": no
per-node diff is asserted, and `ok` reflects only that the instance run
succeeded. A capture-only run keeps the diff/exit-1 semantics above
unchanged. `--json` adds `syntheticPins: boolean` and `provenance`.

## Where `test` sits: after the push

```sh
n8n-decanter preflight <workflow>   # 1. is my local code sound?   (local, changes nothing)
n8n-decanter push     <workflow>    # 2. make it the draft
n8n-decanter test     <workflow>    # 3. ← you are here
n8n-decanter publish  <workflow>    # 4. go live
```

`test_workflow` runs n8n's **draft**. Before step 2 the draft is not your code,
so an instance run would grade something you aren't shipping — which is why
[`preflight`](/docs/cli/preflight/) does **not** run `test` as a stage. Push
first, then test what you pushed.

| Command | Where it runs | What it needs | Reach for it when |
| --- | --- | --- | --- |
| [`preflight --offline`](/docs/cli/preflight/) | locally, static | nothing | every edit — layout + types, offline |
| [`preflight --simulate`](/docs/cli/preflight/#the---simulate-stage) | local engine, runtime | Docker + a capture/scenario | runtime evidence about **local** code, before pushing; CI without an instance; enforced network isolation |
| [**`preflight`**](/docs/cli/preflight/) | the above, scored | as available | **before `push`** — one verdict over your local code |
| **`test`** (bare) | **your instance**, static | MCP | **after `push`** — is the draft internally sound? nothing runs |
| **`test --execution/--scenario`** | **your instance**, runtime | MCP + a capture/scenario | **after `push`** — instance-exact engine, community nodes, no Docker |

The split follows the same line as everything else here: `preflight` grades your
**local files**, `test` grades **the instance's draft**. The static tier is not a
second `preflight --offline` — it reads a different artifact.

## What gets tested — local code or the draft?

`test_workflow` always runs the **draft tip**. When your local code differs
from the draft:

- **On a terminal**, `test` asks what you want to test: your **local code**
  (it pushes to the draft first — the same drift-guarded, draft-only push
  the `push` verb does; nothing is ever activated) or **what's on n8n now**
  (worded as "the live workflow" when draft and published version match,
  "the current n8n draft" when they diverge). On an unpublished workflow it
  skips the question and just pushes — updating a draft nobody runs is the
  obvious intent. After a pushed test you choose to **keep** the draft (then
  [publish](/docs/cli/publish/) when ready) or **restore** the pre-test
  draft — via n8n's version history (`restore_workflow_version`, n8n ≥ 2.29)
  with a byte-exact write-back fallback for older instances; the snapshot is
  persisted to a gitignored file first, so a crash can't lose it.
- **Non-interactively** (piped, CI, agents), `test` **never mutates**: it
  tests the draft as-is and prints "tested the draft, not your local code —
  run `n8n-decanter push` first". There are no choice flags; the choices are
  verb composition (`push`, then `test`).

Either way **the live (published) version is never affected** — the run and
any push land on the draft only.

Requirements: the MCP connection ([init](/docs/cli/init/)), the workflow's
"Available in MCP" flag, an n8n new enough to ship `test_workflow`
(~2.3x), and a workflow with a trigger node. `--json` emits the full report
for scripts.
