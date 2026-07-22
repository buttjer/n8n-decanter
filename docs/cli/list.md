---
title: list
description: List pulled workflows — name, id, folder — and optionally remote ones.
order: 17
---

```sh
n8n-decanter list [--remote] [--json]
```

Lists every pulled workflow with its name, id, and folder path. Offline by
default.

## `--remote`

Also queries the instance (MCP `search_workflows` — it sees every workflow)
and appends the ones that haven't been pulled yet: `(not pulled)` when they
are ready to pull, `(not available in MCP)` when the workflow still needs its
"Available in MCP" flag in n8n — with a hint to where the switch lives. The
quick way to find the id for a [pull](/docs/cli/pull/), though `pull` also
resolves unpulled names directly.

`--json` emits rows for tooling; remote-only rows carry `dir: null` and an
`mcpAvailable` boolean.
