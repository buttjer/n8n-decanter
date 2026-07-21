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

The remote changed since your last sync — the
[drift guard](/docs/concepts/push-gates/) is protecting edits made in the
n8n UI. Run [status](/docs/cli/status/) (`--diff` shows exactly what
differs), then pull. Remember: after a warned pull, the next push overwrites
the surfaced remote edits — the `.remote.js` files and git history are your
safety net.

## Push fails even with `--force`

Then it's the **compliance guard**, not drift: a layout violation (dangling
placeholder, orphan file, duplicate node name, …) that `--force` deliberately
does not bypass. Run [check](/docs/cli/check/) and fix what it lists.

## A `code/<node>.remote.js` file appeared

Someone edited a TS-managed node in the n8n UI (or a pull hit a conflict).
Port the changes into the `.ts`, delete the `.remote.js`, then push. Never
edit the `.remote.js` itself — [sync layout](/docs/concepts/sync-layout/)
covers the contract.

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

In `.env` next to `decanter.config.json` (`N8N_HOST`, `N8N_API_KEY`), or the
environment. The scaffolded `.gitignore` keeps `.env` out of git. Prefer a
minimal-scope API key — see [Configuration](/docs/concepts/configuration/).
