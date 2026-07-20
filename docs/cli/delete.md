---
title: delete
description: Delete a workflow from the server, deliberately — the local folder is kept.
order: 13
---

```sh
n8n-decanter <ref> delete [--force]
```

Deletes a workflow from the n8n server. This is a **hard delete** — n8n removes
it outright, even if it is published (there is no archive step). It cannot be
undone on the server side.

Because it is destructive and outward-facing, consent is explicit:

- On a terminal, `delete` prompts `y/N`, naming the workflow (name + id).
- Non-interactively (piped, CI, an agent), it **refuses** unless you pass
  `--force`, which skips the confirmation.

The **local folder is never touched** — it stays as your git-tracked record of
the workflow. If the id is still listed in `decanter.config.json`, `delete`
reminds you to remove it so `pull` / `push` / `status` stop targeting it.

`delete` always needs a ref and removes **one** workflow per invocation — it
never falls back to the config's `workflows` list, and never cascades. Delete
them one at a time.

Needs credentials and the `workflow:delete` scope (see
[configuration](/docs/concepts/configuration/)).

## `--force`

On `delete`, `--force` means exactly one thing: **skip the `y/N`
confirmation** (so a non-interactive run can proceed). That is a different
meaning from [push](/docs/cli/push/)'s `--force` (bypass the drift guard) and
[init](/docs/cli/init/)'s (overwrite template files). Only use it when you have
explicitly decided to delete that workflow.
