---
title: FAQ & troubleshooting
description: Common errors and their causes — Node version, editor squiggles, drift, proxy auth.
order: 1
---

## The CLI crashes with a `SyntaxError` pointing into a `.mts` file

Your Node is older than 22.18 — the CLI is TypeScript run natively via type
stripping, and older Node can't parse it. Check `node --version`;
[Installation](/docs/getting-started/installation/) has the details.

## My editor shows TS1108 "return not inside a function" on a node file

A false positive: node files are function bodies, and the editor's tsserver
doesn't know about the in-memory wrapper the real typecheck uses. Don't "fix"
it by wrapping the file — [check](/docs/cli/check/) is authoritative.
[Type checking](/docs/concepts/type-checking/) explains the wrapper and the
bundled tsserver plugin that suppresses the squiggle.

## Push says `pull first`

A Code node's remote code changed since your last sync — the
[per-node drift guard](/docs/concepts/push-gates/) is protecting code edited
on the instance. Run [status](/docs/cli/status/) (`--diff` shows exactly what
differs), then pull. Remember: after a warned pull, the next push overwrites
the surfaced remote edits — `status --diff` and git history are your safety
net. (Remote *structure* changes never block a push.)

## Push fails even with `--force`

Then it's the **compliance guard**, not drift: a layout violation (dangling
placeholder, orphan file, duplicate node name, …) that `--force` deliberately
does not bypass. Run [check](/docs/cli/check/) and fix what it lists.

## Pull warns "edited in the n8n UI" / "CONFLICT" on a `.ts` node

Someone edited a TS-managed node on the instance. Pull never merges into (or
clobbers) `.ts` sources — inspect the remote edit with `status --diff`, port
what you want to keep into the `.ts`, then push (which overwrites the remote
edit). Leftover `code/<node>.remote.js` files from older CLI versions just
warn — port and delete them.

## Pull says "Workflow is not available in MCP"

The workflow hasn't been opted into MCP yet: enable **"Available in MCP"**
from the workflow card in the n8n workflows list (⋯ menu) or the workflow
settings, then retry. [list --remote](/docs/cli/list/) marks which workflows
still need it.

## "no MCP endpoint … (404)" or "MCP token was rejected (401)"

The 404 means MCP access is off (n8n → Settings → MCP) or the n8n predates
the built-in MCP server (~2.20+). The 401 means the token is wrong — note
that the **public API key is not a valid MCP token**; mint one under n8n →
Settings → MCP → API key, or re-run [init](/docs/cli/init/) for OAuth.

## "MCP session expired … re-run: n8n-decanter init"

The stored OAuth refresh token was invalidated (they rotate on every use — a
crash at the wrong moment, or a concurrent run, can burn one). Re-running
`init` re-consents and mints a fresh pair.

## "ambiguous ref" / "no workflow matches"

Workflow refs match by id, name, or unique name prefix — case-insensitively,
and ambiguity errors instead of prompting. Use more of the name, or the id.
Since the verb comes first (`n8n-decanter <verb> <workflow>`), a workflow
literally named like a verb needs no special handling — `n8n-decanter status push`
runs `status` on the workflow named `push`.

## The live-reload proxy loses my n8n login

The [watch proxy](/docs/concepts/watch-live-reload/) is designed for a local
**http** n8n. Against an https/remote host, Secure cookies don't survive the
plain-http hop, so auth may not carry through — best-effort only.

## Where do my credentials live?

`N8N_HOST` (and optionally `N8N_MCP_TOKEN`, `N8N_API_KEY`) in `.env` next to
`decanter.config.json`, or the environment; OAuth credentials in
`.decanter-auth.json` next to it. The scaffolded `.gitignore` keeps both
files out of git. The API key is optional — only `executions` and
`data-tables` need it — see
[Configuration](/docs/concepts/configuration/).
