---
title: archive
description: Archive a workflow on the server, deliberately — reversible in n8n, local folder kept.
order: 11
---

```sh
n8n-decanter archive <workflow> [--force]
```

Archives a workflow on the n8n server (MCP `archive_workflow`). The workflow
moves to the workflows list's **Archived** filter: it disappears from the
active list and — if it was published — is taken offline first. Archiving is
**reversible in the n8n UI** (restore it from the Archived filter);
**permanent deletion is deliberately not a decanter surface** — hard-delete an
archived workflow from the n8n UI when you really mean it.

`archive` replaced the API-era `delete` verb (which hard-deleted through the
public API). It needs no API key — like every lifecycle verb it rides the MCP
connection, and it refuses workflows that aren't "Available in MCP".

Because it is outward-facing (the workflow vanishes from your co-workers'
lists and goes offline if live), consent is explicit:

- On a terminal, `archive` prompts `y/N`, naming the workflow (name + id) and
  warning when it is currently published.
- Non-interactively (piped, CI, an agent), it **refuses** unless you pass
  `--force`, which skips the confirmation.

The **local folder is never touched** — it stays as your git-tracked record of
the workflow. If the id is still listed in `decanter.config.json`, `archive`
reminds you to remove it so `pull` / `push` / `status` stop targeting it.

Archived workflows refuse all MCP access ("archived and cannot be accessed"),
so `pull` / `push` / a second `archive` fail until you restore the workflow in
the n8n UI.

`archive` always needs a ref and archives **one** workflow per invocation — it
never falls back to the config's `workflows` list, and never cascades. Archive
them one at a time.

## `--force`

On `archive`, `--force` means exactly one thing: **skip the `y/N`
confirmation** (so a non-interactive run can proceed). That is a different
meaning from [push](/docs/cli/push/)'s `--force` (bypass the drift guard) and
[init](/docs/cli/init/)'s (overwrite template files). Only use it when you
have explicitly decided to archive that workflow.
