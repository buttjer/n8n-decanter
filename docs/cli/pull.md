---
title: pull
description: Sync Code-node source (and the structure snapshot) from the n8n instance.
order: 3
---

```sh
n8n-decanter pull [workflow…]
```

Pulls each workflow into `workflows/<folder>/` over n8n's MCP server: one
source file per Code node under `code/`, plus the read-only `workflow.json`
structure snapshot with each Code node's `jsCode` replaced by a `//@file:`
placeholder — see [Sync layout](/docs/concepts/sync-layout/).

**Without a ref**, on a terminal `pull` opens an interactive picker listing
your workflows — local *and* remote (over MCP) — so you can pick one without
knowing its id; picking a not-yet-local one pulls it fresh. Already-pulled
workflows are listed **newest-synced first** (the one you last pulled or pushed
is under the cursor), with remote-only rows after them. Piped or
non-interactive, it instead pulls the workflows listed in
[config](/docs/concepts/configuration/). `pull` also resolves a name/id it
doesn't know locally against the server's workflow list, so you can pull a new
workflow by name.

Pull reads the workflow **tip** — what the n8n editor shows: the unpublished
draft when one exists, else the published content.

A workflow must have **"Available in MCP"** enabled (workflow card ⋯ menu, or
workflow settings) before it can be pulled; the error tells you where the
switch lives, and [`list --remote`](/docs/cli/list/) marks gated workflows.

After a successful pull the folder is git-committed automatically
(`"commitOnPull": false` disables it).

## What pull never touches

`.ts` node sources, and `.js` node sources with a top-level import, are
one-way — pull never modifies them. Remote changes to a managed node (for
example a UI edit) are **warned about**, not merged: inspect them with
[`diff`](/docs/cli/diff/) and port what you want to keep into the local file
by hand. See [TypeScript nodes](/docs/concepts/typescript-nodes/).

If a managed node's local file is missing entirely, pull writes nothing and
warns instead of guessing an extension:
``<wf> / <node>: managed on remote but no local <file> — pull cannot
reconstruct the source; add the file (its compiled code stays on the n8n
draft, see `n8n-decanter diff`) before pushing``.

**Clobber guard** — if the remote code carries no marker (so it looks like a
plain `.js` node) but your local `.js` file has a top-level import, pull
keeps your file instead of overwriting it, and warns:
`<wf> / <node>: local <file> imports shared code but the remote code is not a
decanter bundle — keeping your source; the next push overwrites the remote
code`. Like every managed node (see below), it is re-baselined on this pull
too — the next push is what reconciles it.

## Pull re-baselines the sync state

Pulling records the remote code as the new sync base — **after a warned
pull, the next push overwrites the surfaced remote edits by design**, with
[`diff`](/docs/cli/diff/) and git history as the safety net. A plain `.js`
file (no import) is overwritten with the remote body, and pull warns when
that clobbers unpushed local edits.

**git really is the safety net here**: pull takes a **snapshot commit before it
writes anything**, so an uncommitted local edit is recoverable from that commit
(`commitOnPull` must be on — it is by default). If the snapshot cannot be made
(no git repo, `commitOnPull: false`, a git error), the pull still runs but the
warning says so instead of promising a recovery that does not exist.

## Renames and migrations

Node **ids are stable across renames** (wherever the rename happened — UI,
MCP), and the id-keyed state maps each node to its file:
pull follows renames by moving the local file to the new kebab-case name.
Layouts from older versions (node files at the folder root) migrate
automatically on the next pull.

**A rename over MCP leaves `$('…')` references behind, and pull cannot fix
them.** The n8n editor rewrites every `$('Old Name')` reference when you rename
(in the browser, before it saves). n8n's `renameNode` MCP op does not — it
rewrites the node name and the connections, reports success, and leaves the
references dangling in Code-node source *and* in other nodes' expression
parameters. Pull mirrors what n8n stored, so it copies the dangling references
down; the compliance guard then blocks `push` until they are repaired
(`preflight --offline` names each one).

Repair them **in this order**: other nodes' expression parameters first, in n8n
(`updateNodeParameters` over MCP, or the editor) — then the local code files,
then `push`. The other order loses the code fix: an MCP write triggers a
background snapshot refresh whose pull overwrites unpushed `.js` edits.
