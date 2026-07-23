---
title: test
description: Run the workflow on your n8n instance with pinned data — the recommended runtime check.
order: 7
---

```sh
n8n-decanter test <workflow> [--execution <execution-id> | --scenario <slug>] [--trigger <node>] [--json]
```

Runs the workflow **on your n8n instance** (MCP `test_workflow`) with
external touchpoints pinned: the trigger, credentialed nodes, and HTTP
Request nodes are fed captured data, while logic nodes (Code, Set, If, …)
**execute for real** — on the instance's exact engine version, community
nodes included, no Docker needed. The run targets the **draft** and is
synchronous (the server caps it at 5 minutes; a timeout is reported as
such). Afterwards each pure node's output is diffed client-side against the
capture — divergence exits 1, so it's CI-gateable like
[simulate](/docs/cli/simulate/).

Pins come from the same sources `simulate` uses: a fetched capture
(`--execution <id>`, defaulting to the newest under `executions/`) or a
committed [scenario](/docs/cli/scenario/) (`--scenario <slug>`). A
trigger/network node with no captured output **aborts before anything
runs** — an unpinned one would hit the real world. `--trigger <node>` picks
the start trigger in multi-trigger workflows.

**Synthetic pins are the exception to the diff.** A `--scenario` with any
`authored`/`scaffolded` node (see
[provenance](/docs/cli/scenario/#provenance-and-synthetic-pins)) is reported
"**synthetic pins — proves executability, not output correctness**": no
per-node diff is asserted, and `ok` reflects only that the instance run
succeeded. A capture-only run keeps the diff/exit-1 semantics above
unchanged. `--json` adds `syntheticPins: boolean` and `provenance`.

## Preflights — which one when?

**Preflights** are decanter's three ways to verify a workflow before you ship
it: `check` (static, offline), `simulate` (offline engine replay), and `test`
(instance-side pinned run). All are CI-gateable — the two runtime ones diff
every node against a real capture and exit 1 on divergence.
[**`preflight`**](/docs/cli/preflight/) runs the whole ladder as one scored,
read-only gate — reach for it (not the three individually) as the pre-push gate.

| Preflight | Where it runs | What it needs | Reach for it when |
| --- | --- | --- | --- |
| [check](/docs/cli/check/) | locally, static | nothing | every edit — layout + types, offline |
| **`test`** (recommended) | **your instance**, runtime | MCP + a capture/scenario | the default runtime check: instance-exact engine, community nodes, no Docker |
| [simulate](/docs/cli/simulate/) | local engine, runtime | Docker + a capture/scenario | pre-push verification of *uncommitted local* code, CI without an instance, `--network-none` isolation, engine-version rehearsal |
| [**preflight**](/docs/cli/preflight/) | all of the above, scored | as available | the one-command pre-publish gate — a single verdict over the whole ladder |

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
