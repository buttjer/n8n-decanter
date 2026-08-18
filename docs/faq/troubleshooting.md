---
title: FAQ & troubleshooting
description: Common errors and their causes — Node version, editor squiggles, drift, auth.
order: 1
---

## The CLI crashes with a `SyntaxError` pointing into a `.mts` file

Your Node is older than 22.18 — the CLI is TypeScript run natively via type
stripping, and older Node can't parse it. Check `node --version`;
[Installation](/docs/getting-started/installation/) has the details.

## `check`, `status`, or `simulate` says the verb was removed

The three verify verbs folded into two. `check` → **`preflight --offline`**
(layout + types, no network, no engine). `status` → **`preflight`** for the
summary, **[diff](/docs/cli/diff/)** for the per-node lines. `simulate` →
**`preflight --simulate`** (add `--offline` for the credential-free,
no-instance form the verb had; `--viewer` for the browsable run). The profile
flags went with them: depth is now `--simulate` (adds the local engine) and
`--offline` (drops the instance reads), and they compose — `--full`,
`--quick`, and `--network-none` no longer exist (preflight always forces
network isolation on the graded engine run). CI that branched on `status`'s
exit code moves to [preflight](/docs/cli/preflight/): `diff` always exits 0.

## My editor shows TS1108 "return not inside a function" on a node file

A false positive: node files are function bodies, and the editor's tsserver
doesn't know about the in-memory wrapper the real typecheck uses. Don't "fix"
it by wrapping the file — `n8n-decanter preflight --offline` is authoritative.
[Type checking](/docs/concepts/type-checking/) explains the wrapper and the
bundled tsserver plugin that suppresses the squiggle.

## Push says `pull first`

A Code node's remote code changed since your last sync — the
[per-node drift guard](/docs/concepts/push-gates/) is protecting code edited
on the instance. Run [diff](/docs/cli/diff/) to see exactly which lines differ,
then pull. ([preflight](/docs/cli/preflight/) reports the same situation as a
failing `drift` check — `CONFLICT`, with the node list in its details; `diff`
is the view of the lines and always exits 0.) Remember: after a warned pull,
the next push overwrites the surfaced remote edits — `diff` and git history are
your safety net. (Remote *structure* changes never block a push.)

## Push fails even with `--force`

Then it's the **compliance guard**, not drift: a layout violation (dangling
placeholder, orphan file, duplicate node name, …) that `--force` deliberately
does not bypass. Run `n8n-decanter preflight --offline` and fix what its
`layout` check lists — the one-line message names the first violation, the
indented details under it name them all.

## `diff` reports a `CONFLICT` nobody caused

Every `CONFLICT` is measured against the **last-sync hash** in
`.decanter.json`. If that hash is stale or absent for a node — a hand-edited
state file, a `.decanter.json` restored from an older commit, a sync from
another checkout — the comparison has no valid baseline and the verdict says
more about the state file than about your instance.

Two things it is **not**: a node with *no* recorded hash is never reported as a
conflict (it reads as `push pending`, and [push](/docs/cli/push/) accepts it),
and a changed compiler is not a remote edit — a new esbuild that escapes a
string differently only moves the **local** side, which is `push pending` too.

The way out never needs `--force`: run [pull](/docs/cli/pull/) — it never
touches `.ts` sources and re-records the baseline — then push. Use
[diff](/docs/cli/diff/) first if you want to see the lines.

## Pull warns "edited in the n8n UI" / "CONFLICT" on a `.ts` node

Someone edited a TS-managed node on the instance. Pull never merges into (or
clobbers) `.ts` sources — inspect the remote edit with [diff](/docs/cli/diff/),
port what you want to keep into the `.ts`, then push (which overwrites the
remote edit). Leftover `code/<node>.remote.js` files from older CLI versions just
warn — port and delete them.

## Pull says "Workflow is not available in MCP"

The workflow hasn't been opted into MCP yet: enable **"Available in MCP"**
from the workflow card in the n8n workflows list (⋯ menu) or the workflow
settings, then retry. [list --remote](/docs/cli/list/) marks which workflows
still need it.

## "n8n refused the MCP request (403 — MCP access is disabled)"

MCP access is switched **off** for the whole instance. Turn it on under n8n →
**Settings → MCP**. If it is already on, the token's user may not have access
to MCP.

**A stale token hides this**, because the 401 below is checked first: if
decanter reports the 401 and a fresh token does not help, check the MCP switch
too.

## "no MCP endpoint … (404)" or "MCP token was rejected (401)"

The **404** means there is no MCP server at that address at all — check
`N8N_HOST` points at the right instance, and that the n8n is recent enough
(~2.20+) to ship the built-in MCP server. A server that exists but is switched
off answers **403**, not 404 (see above).

A 401 means the credentials **exist and were rejected** — most often a rotated
token. It does **not** mean the project was never configured, and being unable to
read `.env` (the scaffolded deny rules block it) is not evidence either way. If
you are an agent: ask the user rather than inferring.

The **401** means the token is wrong — note that the **public API key is not a
valid MCP token**; mint one under n8n → Settings → MCP → API key, or re-run
[init](/docs/cli/init/) for OAuth.

## A REST verb fails with 403 — which scope is missing?

`executions`, `data-tables` and `backup` use n8n's **public REST API**, not MCP,
so they need `N8N_API_KEY`. n8n answers a valid-but-under-scoped key with a bare
**403** that names no scope, so decanter adds the one you need per endpoint:

| Verb / call | Scope to add |
| --- | --- |
| `executions <workflow>` (the list) | `execution:list` — plus `execution:read` to fetch one |
| `executions <workflow> <id>` | `execution:read` |
| `data-tables` (listing tables) | `dataTable:list` **and** `dataTable:read` |
| a table's **columns** | `dataTableColumn:read` — **not** covered by `dataTable:read` |
| a table's **rows** | `dataTableRow:read` — separate again |
| `backup restore` | `workflow:create` (it redeploys the backup as a new workflow) |
| `init`'s connection check | `workflow:read`, `workflow:list` |

The data-table split is the one that catches people out: three separate scopes
for what looks like one resource. **decanter only ever reads data tables**, so no
write scope is ever needed.

Scopes live under n8n → **Settings → n8n API**, on the key itself.

## "decanter.config.json not found" after setting `.env` by hand

Credentials alone are not a sync dir. If you (or your agent) pasted
`N8N_HOST`/`N8N_MCP_TOKEN` into a file instead of running
[init](/docs/cli/init/), the config, starter template, `.gitignore` and agent
configs were never scaffolded. Fix it in one command — it reuses the values
already in `.env` and needs no browser or TTY:

```sh
n8n-decanter init . --host <host-url> --token <mcp-token>
```

## "MCP session expired … re-run: n8n-decanter init"

The stored OAuth refresh token was invalidated (they rotate on every use — a
crash at the wrong moment, or a concurrent run, can burn one). Re-running
`init` re-consents and mints a fresh pair.

## "ambiguous ref" / "no workflow matches"

Workflow refs match by id, name, or unique name prefix — case-insensitively,
and ambiguity errors instead of prompting. Use more of the name, or the id.
Since the verb comes first (`n8n-decanter <verb> <workflow>`), a workflow
literally named like a verb needs no special handling — `n8n-decanter diff push`
runs `diff` on the workflow named `push`.

## Where do my credentials live?

`N8N_HOST` (and optionally `N8N_MCP_TOKEN`, `N8N_API_KEY`) in `.env` next to
`decanter.config.json`, or the environment; OAuth credentials in
`.decanter-auth.json` next to it. The scaffolded `.gitignore` keeps both
files out of git. The API key is optional — only `executions` and
`data-tables` need it — see
[Configuration](/docs/concepts/configuration/).
