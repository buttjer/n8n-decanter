---
title: Configuration
description: decanter.config.json keys and credential resolution.
order: 5
---

`decanter.config.json` is searched upward from the current directory (or from
wherever `--dir` / `N8N_DECANTER_DIR` starts that search — see
[Pointing at a nested sync dir](#pointing-at-a-nested-sync-dir)); credentials
come from `.env` / `.decanter-auth.json` next to it or from the environment.

```json
{
  "root": "./workflows",
  "workflows": ["0cXNQKKzmO0pXiCq"],
  "commitOnPush": true,
  "commitOnPull": true,
  "requestTimeoutMs": 30000,
  "n8nVersion": "2.31.4",
  "dataTables": true,
  "liveMirror": true,
  "backupLimit": 20,
  "bundleDependencies": ["zod"]
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `root` | — | Directory holding the workflow folders. |
| `workflows` | `[]` | Workflow ids processed when a command gets no refs. |
| `commitOnPush` | `true` | Auto-commit the workflow folder after a successful push. |
| `commitOnPull` | `true` | Same for pull. |
| `requestTimeoutMs` | `30000` | Request timeout (MCP and API) — raise for slow instances. |
| `n8nVersion` | unset | n8n version the local engine behind [`preflight --simulate`](/docs/cli/preflight/) pins to (e.g. `"2.31.4"`); `--n8n-version` overrides it per run. Unset falls back to the project's default with a hint. |
| `dataTables` | `true` | Whether the read-only [data-tables](/docs/cli/data-tables/) fetch is available. `false` refuses it (and the API key needn't carry the data-table read scopes); `data-tables clean` still works. |
| `liveMirror` | `true` | Run a full [`pull`](/docs/cli/pull/) in the background after an agent restructures a workflow through the [guard](/docs/cli/mcp-connect/) (a forwarded `update_workflow`) — `workflow.json`, the `code/` files and `.decanter.json`, including file moves on a rename. It is a pull, not a snapshot-only refresh, so it can overwrite unpushed local edits; it safety-commits first, and stops if that commit fails. `false` disables the auto-refresh (CI / deterministic setups). |
| `backupLimit` | `20` | Cap on the retained [`backups/`](/docs/cli/backup/) working set per workflow. Each `backup create` rolling-prunes the oldest beyond this; `0` keeps all (git holds the full history regardless). |
| `bundleDependencies` | `[]` | npm packages `.ts` nodes may import; [bundled on push](/docs/concepts/typescript-nodes/). Pure-JS only. |

## Pointing at a nested sync dir

The search only goes **up**, which is the wrong direction whenever the sync dir
sits *below* where the command runs — a monorepo whose flows live in `flows/`,
or a coding agent whose MCP entry was hoisted to the repo root. Two overrides
move where that search **starts**; the walk itself is unchanged and still climbs
from there:

```sh
n8n-decanter pull --dir flows              # per invocation
N8N_DECANTER_DIR=flows n8n-decanter pull   # or from the environment
```

- **Precedence: `--dir` > `N8N_DECANTER_DIR` > the working directory.** Every
  verb honours both. [`init`](/docs/cli/init/) is the one exception — it
  *creates* a sync dir rather than finding one, so it takes its target as a
  positional argument (`n8n-decanter init flows`) and rejects `--dir` rather
  than quietly scaffolding the working directory instead.
- **Relative values resolve against the working directory.** That is what keeps
  a committed root `.mcp.json` portable: `"N8N_DECANTER_DIR": "flows"` is right
  on every clone, while an absolute path is right on exactly one machine.
  Absolute values are accepted for one-off use.
- **A value that isn't a directory is an error**, naming which of the two set
  it — there is no silent fallback to the working directory. An empty string
  counts as unset, since agent configs that interpolate a missing variable ship
  `""`.
- **The environment variable is the load-bearing half for agents:** every agent
  MCP config has an `env` / `environment` block, while a working-directory field
  is not guaranteed across agents and versions. See
  [mcp connect](/docs/cli/mcp-connect/#when-your-sync-dir-is-not-your-project-root)
  for the full root-wiring entry — the override alone is not enough there, the
  command has to resolve from the root too.

Neither override changes credential resolution: `.env` and
`.decanter-auth.json` are still read next to the `decanter.config.json` the
search lands on, and a variable already set in the environment always wins over
the `.env` file.

When a verb does run above its sync dir without an override, the
`decanter.config.json not found` error says so — it names the directory it found
below you and both override forms, instead of sending you to `init` (which would
scaffold a second sync dir on top of a working one). The `init` advice is still
what a genuinely un-inited directory gets.

## Credentials

The sync rides n8n's **MCP server**; the public API key is an optional extra.

**Set them with [`init`](/docs/cli/init/), not by hand.** Writing `N8N_HOST` /
`N8N_MCP_TOKEN` into `.env` yourself gets the credentials right and everything
else wrong: no `decanter.config.json`, no template, no `.gitignore` covering
`.env`, no agent configs. Headless is not an excuse — `n8n-decanter init .
--host <host-url> --token <mcp-token>` takes the same values as flags, with no
prompt and no browser.

In order of resolution:

1. **`N8N_HOST`** — always required for online verbs (`.env` or environment).
2. **MCP credentials** (the sync verbs — pull, push, diff, watch, publish,
   unpublish, test, and `preflight` without `--offline` — plus the
   `mcp connect`/`mcp serve` guard):
   - `N8N_MCP_TOKEN` (`.env` or environment) — a rotatable token from n8n →
     Settings → MCP → API key. Takes precedence when set.
   - Otherwise `.decanter-auth.json` — the OAuth client id + refresh token
     [init](/docs/cli/init/) minted via browser consent. The refresh token
     rotates on every use; the file is rewritten automatically. Delete it and
     re-run `init` to re-consent (also the fix for a
     "MCP session expired" error).
3. **`N8N_API_KEY` (optional)** — only for the verbs MCP cannot serve:
   [executions](/docs/cli/executions/),
   [data-tables](/docs/cli/data-tables/), and
   [backup](/docs/cli/backup/). Scope it minimally:
   `execution:read`, `execution:list`, `workflow:list` (init's connection
   check), and `workflow:read` + `workflow:create` (only for `backup`
   create/restore's full-fidelity GET/POST). While `dataTables` is on, add
   **three** separate read scopes — `dataTable:list`, `dataTable:read`,
   `dataTableColumn:read` **and** `dataTableRow:read`: `dataTable:read` does
   *not* cover a table's columns or rows, which is the split that catches people
   out. decanter only ever **reads** data tables, so no write scope is needed.
   A 403 from any REST verb names the missing scope for you —
   [the table in troubleshooting](/docs/faq/troubleshooting/) lists them all.

The instance needs **MCP access enabled** once (n8n → Settings → MCP;
requires an n8n with the built-in MCP server, ~2.20+), and each synced
workflow needs its **"Available in MCP"** flag (workflow card ⋯ menu, or
workflow settings) — [list --remote](/docs/cli/list/) and the picker show
which workflows still need it.

`preflight --offline`, `node run`, `scenario check`, and plain `list` need no
credentials at all (`scenario create --scaffold` is the exception — it needs
MCP).

## Git worktrees

Both credential files are gitignored, so a **linked git worktree starts with
neither** — and every credentialed verb there would fail on `N8N_HOST must be
set`, the guard included. Since an agent that finds no n8n MCP tools is exactly
the agent that goes looking for an unguarded route, decanter closes that gap
itself:

**In a worktree without its own credentials, decanter reads the main
checkout's.** It maps the sync dir onto the same path in the main checkout
(`.git` is a file in a worktree, pointing back at the shared git dir) and reads
`.env` / `.decanter-auth.json` from there. **A local file always wins**, so a
worktree deliberately pointed at a staging instance keeps its own; the fallback
only fires where the alternative is failing outright. Nothing else is
redirected — `workflows/`, `.decanter.json` and `decanter.config.json` stay
worktree-local, which is the whole point of the worktree.

**Do not copy `.decanter-auth.json` into a worktree.** The OAuth refresh token
is single-use and rotates on every redemption, and decanter's recovery from a
lost race re-reads *the same file* to adopt the winner's token. Two copies fork
into two token chains, and the one that loses is dead — you get "MCP session
expired" and an `init` re-consent. One shared file is the correct shape, and it
is what the fallback gives you.

### Claude Code worktrees

Two more things break in a worktree that decanter cannot fix, because they
happen before decanter runs. Both are Claude Code settings (other agents have no
equivalent):

- **`node_modules` is missing**, so the scaffolded `npx --no-install
  n8n-decanter` finds nothing under a local install. Either install decanter
  globally, run `npm install` in each worktree, or symlink it from the main
  checkout by putting this in `.claude/settings.json`:

  ```json
  { "worktree": { "symlinkDirectories": ["node_modules"] } }
  ```

- **The MCP server is unapproved at the new path.** Approval is stored per
  absolute project directory, so a fresh worktree re-asks — and a
  non-interactive session simply starts without the server.

A `.worktreeinclude` file in the repository root (gitignore syntax) copies
gitignored files into each new worktree, which is the upstream answer to the
credential problem. It is safe for `.env` and **wrong for
`.decanter-auth.json`** — see above; decanter's fallback covers both without it.
