---
title: executions
description: Fetch recent execution run data as JSON, for building accurate run fixtures.
order: 13
---

```sh
n8n-decanter executions [workflow…] [--status=success|error|waiting] [--limit=N]
n8n-decanter executions <execution-id>         # fetch one execution by id
n8n-decanter executions [workflow…] clean      # delete fetched data (offline)
```

Fetches recent execution data — the full run JSON, newest first — for each
workflow into `workflows/<folder>/executions/<execution-id>.json`. Read-only
against the API. The point is to see the **real items each node produced** and
copy those shapes into [node run](/docs/cli/node-run/) fixtures, instead of
guessing. A purely numeric argument is treated as an `<execution-id>`;
everything else is a `<workflow>`.

## Options

| Flag | Meaning |
| --- | --- |
| `--status=success\|error\|waiting` | Only fetch executions in that state |
| `--limit=N` | How many to fetch (default 5, API cap 250; `--limit N` also works) |

A **numeric argument** is treated as a single execution id: it fetches just
that execution and routes the file to its workflow's folder.

## Where the items live in the JSON

Each node's output items are at:

```txt
data.resultData.runData["<Node>"][0].data.main[0][]
```

That array is exactly the `items` a [node run](/docs/cli/node-run/) fixture feeds a node
— copy a real shape in and your offline run matches production.

## Never commit run data

Each `executions/` dir is written **self-ignored** (it contains a `.gitignore`
of just `*`) because run data can hold credentials and PII — it must never
reach git. `init`'s scaffolded root `.gitignore` also lists
`workflows/*/executions/`.

## `executions clean`

Offline. Deletes the fetched `executions/` dirs for the given workflow refs,
or for every pulled workflow when no ref is given. Run it when you're done.

## Caveat: published version

Executions run the **published** workflow version (n8n 2.x), not necessarily
your local draft — so treat the data as convenience reference, not ground
truth about your current code.

To make that concrete, `executions` **warns** when a fetched execution ran a
published version different from your local draft (comparing the execution's
`workflowVersionId` against `workflow.json`'s `versionId`):

```txt
! captured executions ran published version <X>; your draft is <Y> —
  the data may not match the code you're editing
```

The files are still written — it's a warning, not an error — but it tells you
the captured shapes may be a step behind the code in front of you.
