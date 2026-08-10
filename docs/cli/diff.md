---
title: diff
description: Per-node line diff between your local Code-node source and the n8n draft — an inspection view, never a gate; it always exits 0.
order: 5
---

```sh
n8n-decanter diff [workflow…]
```

Shows the **actual changed lines** between your local Code-node source and the
workflow's draft on n8n: `--- remote (n8n)` / `+++ local (<file>)` and `@@`
hunks, per node — exactly what a [push](/docs/cli/push/) would overwrite, and
exactly what a [pull](/docs/cli/pull/) would bring in. It reads the instance
and writes nothing.

## The `git status` / `git diff` split

`diff` is the **`git diff`** half of code sync: the lines. The **`git status`**
half — *is anything pending, is anything drifted, is the live version behind* —
is [`preflight`](/docs/cli/preflight/), which turns the same facts into a scored
verdict. Both read one shared fact computation, so they can never disagree
about which nodes moved.

```sh
n8n-decanter preflight order-sync   # the summary + the verdict (the gate)
n8n-decanter diff      order-sync   # the lines behind that summary
```

## It always exits 0

`diff` is an inspection view, not a gate — like `git diff`, its exit code says
nothing about whether you should ship. It exits **0** whether every node matches
or every node conflicts. (A genuine failure — an unreachable instance, an
unavailable workflow — still exits 1, because the command didn't run.)

**This drops the CI exit codes the retired `status` verb had.** A pipeline that
gated on `status` migrates to `preflight`, which is the verb that grades:

```sh
n8n-decanter preflight --json                # verdict + exit 1 on not-ready
n8n-decanter preflight --fail-on=warn        # also exit 1 on a caution
```

## Refs, multi-workflow, and the picker

`diff` takes refs like `pull`/`push`: several at once, each rendered under its
own header, or none — in which case a terminal opens the
[picker](/docs/cli/overview/#interactive-picker) and a piped run falls back to
the `"workflows"` list in your [config](/docs/concepts/configuration/).

Each workflow's block starts with `<name> (<id>)  [<dir>]`. A ref that isn't
pulled yet is reported as such and skipped, not treated as an error.

## What it prints — and what it omits

**In-sync nodes are omitted entirely.** Only nodes that differ get a line, so a
clean workflow prints one line:

```txt
Order Sync (wf123)  [workflows/order-sync]
  no differences — every tracked node matches the draft
```

Everything else gets a state line, then the diff:

| State line | Means |
| --- | --- |
| `local changes in code/<file> — push pending` | you edited locally; the draft is still at the last sync |
| `changed remotely — pull` | the draft moved; your file is still at the last sync |
| `CONFLICT — changed both locally and remotely` | both sides moved off the last sync |
| `local file code/<file> missing` | the file `.decanter.json` tracks is gone from disk |
| `remote code node unknown locally — pull` | a Code node exists on n8n with no local state entry |
| `code/<file>: node <id> deleted remotely` | the node this file belongs to is gone from the workflow |

The last three have only **one** side to show, so they print the state line
without a hunk. Everything else prints the unified diff underneath.

## `.ts` nodes are compiled before comparing

For a `.ts` node the local side of the diff is the **compiled** JavaScript —
the exact bytes `push` would send, helper imports bundled in. So editing
one shared helper shows up as a diff in **every node that imports it**, which is
the honest answer to "what does this helper change touch?". See
[TypeScript nodes](/docs/concepts/typescript-nodes/). Compile warnings for a
node are replayed immediately above that node's diff.

## What `diff` deliberately does not tell you

Three facts the retired `status` verb printed are **not** here — they aren't
line diffs, and each survives as a [`preflight`](/docs/cli/preflight/) check:

| Fact | Now |
| --- | --- |
| published / unpublished, and whether the live version lags the draft | the `lifecycle` check |
| `workflow.json` structure snapshot out of date | the `snapshot` check |
| the roll-call of nodes that *are* in sync | the `parity` check |
