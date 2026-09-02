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

This is the message you get when nothing below you is a sync dir. When one
*is*, the error says so instead — see the next section.

## "decanter.config.json not found" but the sync dir is one level down

Same message, opposite cause: the sync dir is fine, the command just ran
*above* it. The search only walks up, so from the repo root it never sees
`flows/decanter.config.json`. The error names the sync dir it found below you
and the two ways to point at it:

```sh
n8n-decanter pull --dir flows
N8N_DECANTER_DIR=flows n8n-decanter pull
```

**Don't run `init` here** — it would scaffold a second sync dir on top of a
working one. A coding agent lands in this case whenever it is started at the
repo root: what does and doesn't load from there is the matrix in
[Working with coding agents](/docs/agents/overview/#where-the-agent-wiring-loads-from),
and the root MCP entry (which needs a root-resolvable command as well as the
override) is in
[mcp connect](/docs/cli/mcp-connect/#when-your-sync-dir-is-not-your-project-root).

## My agent has no `n8n-instance` tools, and restarting didn't help

Three different things produce that symptom, and only one of them is a restart:

- **The wiring is new.** `init` normally runs *inside* the session it
  configures, and nothing it scaffolds hot-loads — MCP servers, permission
  rules and hooks are read once, at agent **startup**. That session stays
  unconfigured until it restarts (or `/reload`s). This is the common case and
  the restart is the real fix.
- **The wiring is below the agent.** The sync dir is nested in a bigger repo
  and the agent was started at the repo root. `.mcp.json` is discovered by
  walking **up** from the launch directory — never downward — so
  `flows/.mcp.json` is invisible from `<repo>/`. Startup already looked and
  missed it; restarting looks in the same places again. **No number of restarts
  will ever produce those tools.**
- **The agent is in a git worktree.** `.mcp.json` is tracked, so it is there —
  but the guard it spawns is not runnable yet. `node_modules` is gitignored, so
  `npx --no-install n8n-decanter` finds nothing under a local install, and the
  server is unapproved at the new path. (Credentials are *not* part of this one
  any more: decanter reads the main checkout's when a worktree has none.)
  [Git worktrees](/docs/concepts/configuration/#git-worktrees) has both fixes.

**Which one am I in?** Is the working directory a linked worktree (`.git` is a
file, not a directory)? Then it is the third case. Otherwise compare the two
paths: is the `.mcp.json` below the directory the agent was started in? If yes,
it is the second case. Fix it by
starting the agent in the sync dir (`cd flows && claude`, the recommendation) or
by wiring the repo root — both spelled out in
[init](/docs/cli/init/#when-the-sync-dir-is-nested-in-a-bigger-repo), with the
per-file load matrix behind them in
[Working with coding agents](/docs/agents/overview/#where-the-agent-wiring-loads-from).
`init` prints whichever of the two applies when it first scaffolds the files.

Meanwhile the CLI is unaffected either way — it finds its own config and
credentials, so `pull` / `push` / `preflight` keep working (add `--dir flows`
when you run them from above the sync dir). What the missing tools cost you is
workflow **structure** work over MCP, not the Code-node flow.

## "MCP session expired … re-run: n8n-decanter init --reauth"

The stored OAuth refresh token was invalidated (they rotate on every use — a
crash at the wrong moment, or a concurrent run, can burn one). Run
[`init --reauth`](/docs/cli/init/#re-authorizing-reauth): it skips the
credential-reuse step, re-consents in the browser, and writes a fresh pair.

**A bare `init` is not enough**, which is why the message names the flag.
`init` reuses `.decanter-auth.json` whenever its host matches, so it would
re-probe with the same dead token and finish with "credentials written
anyway". You do not have to delete anything by hand.

A second **copy** of `.decanter-auth.json` produces this reliably rather than
occasionally: two copies rotate independently and the loser's token is spent for
good. Never copy the file between checkouts — see
[Git worktrees](/docs/concepts/configuration/#git-worktrees).

## "n8n is rate-limiting the OAuth token endpoint (429)"

**Your credentials are fine.** This is n8n throttling, not an expired session,
and the CLI already retried (five times, honouring `Retry-After`) before
printing it. Wait for the window to pass — n8n's default is 5 minutes — and run
the command again. Nothing needs re-authorizing, and deleting
`.decanter-auth.json` would only cost you a browser round-trip.

The usual cause is many decanter runs at once (several `watch` processes, or a
CI matrix) against one instance from one IP.

## "MCP token refresh failed (…)"

Anything other than the two cases above — an HTTP 500, a malformed response, a
connection that dropped. Decanter deliberately does **not** diagnose these as
an expiry: nothing in them says the stored credentials are spent. Retry first,
then check that the host is reachable and MCP access is still enabled in
n8n → Settings → MCP. Only re-authorize if the message actually says the token
was spent or revoked.

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

Being gitignored, neither file exists in a fresh git worktree — decanter reads
the main checkout's copies there, and a local file still wins if you make one:
[Git worktrees](/docs/concepts/configuration/#git-worktrees).
