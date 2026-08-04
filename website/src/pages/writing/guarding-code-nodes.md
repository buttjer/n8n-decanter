---
layout: ../../layouts/ArticleLayout.astro
title: "Your agent can rewire the workflow. It can't own the code."
description: "n8n ships an MCP server, so a coding agent can edit workflows directly. That works right up until it reaches a Code node — and the fix is to take exactly one write away from it."
standfirst: "n8n ships an MCP server, so a coding agent can edit your workflows directly. That works right up until it reaches a Code node."
date: "2026-07-27"
---

n8n is the best thing that happened to the boring half of my work. Hundreds of
integrations somebody else keeps current. Credentials in a vault instead of in my
`.env`. An execution history that shows which item failed, on which node, with
the payload, and lets me retry that one. A canvas a colleague can read without
ever opening an editor. Draft and published versions, so the thing serving
traffic isn't whatever I saved last. And all of it self-hostable, so none of it
is rented.

Recent versions also ship a built-in MCP server — which is further than most
tools have gone. Point a coding agent at it and it genuinely works: the agent can
search workflows, read their full structure, add nodes, rename them, wire
connections, publish a version. For the first ten minutes it feels like the
future arrived on schedule.

Then it edits a Code node, and you notice what you gave up.

## A Code node is a string inside a JSON blob

In n8n, a Code node's source lives in a `jsCode` field — a string, inside a node
object, inside a workflow document. That's a perfectly reasonable way for a
workflow engine to store it. It is a terrible way to *own* a few hundred lines of
business logic.

Every tool you'd normally point at code stops at that boundary:

- **No diff worth reading.** A rewritten Code node is one changed string. Export
  the workflow JSON to git and a 40-line logic change looks much like a node that
  moved 20 pixels.
- **No types.** Nothing checks that `$input.first().json.customerId` is real, or
  that the helper you pasted into four nodes still agrees with itself.
- **No sharing.** Common logic gets duplicated per node, because there is nowhere
  for a shared module to live.
- **No review surface.** The change is invisible until it runs.

The problem was never that agents write bad code. It's that they write
*unreviewable* code, quickly. Unreviewable code produced at speed is strictly
worse than unreviewable code produced slowly.

## Two fixes that don't work

**Don't give the agent MCP access.** Now you've discarded the part that was
working. Structural edits — add a node, rewire a branch, rename a step, wire the
error path — are tedious by hand and well-suited to an agent, and n8n's own MCP
tools do them against the engine's own validation. Taking that away to protect
your Code nodes trades a real capability for a blunt one.

**Mirror whole workflow JSON into git.** This is the usual "n8n as code" answer,
and it is write-hostile. Pushing a whole workflow document back means clobbering
whatever moved on the other side — and workflow JSON churns for reasons that
aren't yours: node positions, version ids, credential references. You end up with
a history that is mostly noise wrapped around occasional signal, and a sync
direction you don't quite trust.

## Split ownership at the sharp edge

The observation everything else follows from: **structure and code want different
owners.**

Structure is n8n's job, and it is *good* at it — that's the whole reason this
works. The canvas, the schema, validation before a save, the draft/published
split, the execution model, the credential store, the four hundred integrations
that are somebody else's maintenance burden. Rebuilding any of that in git would
mean writing a worse engine to get better diffs. And making git a second master
for structure just means two masters to reconcile.

Code is git's job. It wants files, diffs, types, review, blame, history. n8n
never claimed otherwise; a workflow engine storing a function as a string is the
correct call for a workflow engine.

So the move isn't to take MCP away from the agent. It's to take *one write* off
it. [n8n-decanter](/) sits between your agent and n8n as an MCP server of its
own. It forwards the entire tool surface — create, read, update, rename, connect
— and refuses one thing: an `update_workflow` operation that sets `jsCode`.

The agent connects through a scaffolded `.mcp.json` and never sees a second set
of credentials. From its side, n8n's full toolset is there, minus one door. When
it tries that door, it's told where the file is instead.

One other call isn't waved through unread: `publish_workflow`. Going live gets
checked before it passes — a gate, not an ownership claim, and the subject of
*Being wrong should be cheap* below.

## What it writes instead

A folder per workflow, one file per Code node:

```
workflows/
  order-enrichment/
    workflow.json          # read-only mirror of the structure
    .decanter.json         # node id → file, per-node sync hashes
    code/
      normalize-order.ts
      score-risk.ts
shared/
  money.ts                 # imported by both, bundled in at push
```

`workflow.json` is a snapshot, never a source of truth — each Code node's source
is replaced by a pointer:

```json
{
  "name": "Normalize order",
  "type": "n8n-nodes-base.code",
  "parameters": { "jsCode": "//@file:code/normalize-order.js" }
}
```

Structural changes still show up as clean git diffs; the code they refer to lives
where code belongs. When the agent adds a Code node over MCP, it lands with no
source at all — an empty file — and the first push seeds it from whatever you or
it then write there.

## What it is, plainly

A CLI. MIT, on npm, one process running next to a git repo you already have.
`init` scaffolds the folder and your agent's config, `pull` and `push` move
Code-node source between repo and instance, `watch` does it on save, `diff` shows
what's different, and `mcp connect` is the guard the agent talks to. It works
against any n8n new enough to ship the MCP server, cloud or self-hosted — no
plugin, no fork, no change to how anyone else on the team uses n8n. **There is no
service in the middle:** nothing is hosted by me, your credentials stay on your
machine, and if you delete the tool tomorrow your workflows keep running exactly
as they are. n8n stays the product. This is a bracket around one field.

**Who it's for:** people whose Code nodes stopped being one-liners. A few hundred
lines of real logic across a handful of nodes, a repo you already review in, and
an agent you'd rather keep pointing at the workflow than take away from it. Teams
get the review surface back; solo builders get types, a diff, and shared helpers
that exist once.

**Who it isn't for:** workflows that are all integrations and barely any code. If
your Code nodes are three `return items` one-liners, the n8n editor is already
the right place and a repo buys you nothing but ceremony. It also isn't a
deployment tool — it won't promote workflows between environments or manage
credentials. Those are n8n's problems, and n8n has its own answers.

## The wrinkle nobody warns you about

n8n Code node source is not a module. It's a **function body**: top-level
`return`, top-level `await`, `$input` in scope from nowhere. Which means `tsc`
rejects a perfectly valid node file outright — `TS1108: A 'return' statement can
only be used within a function body`.

You can't fix that by changing the files, because the files have to stay
byte-identical to what n8n runs. So typechecking wraps each node file in an
in-memory `async function` through a custom `CompilerHost`, typechecks that, and
maps the diagnostic line numbers back to the real file. On disk the source stays
verbatim. In your editor you get real types, real completion on `$input`, and
real errors before anything is pushed.

TypeScript nodes compile through esbuild on push, with `shared/` helpers and
opted-in npm dependencies inlined into each node — so a node arrives in n8n as
the single self-contained function body it has to be.

## Being wrong should be cheap

Guarding the write is only half of it. The other half is that a bad edit
shouldn't reach production.

Pushes land on the workflow's **draft**. The published version keeps running,
untouched, serving traffic. `publish` is a separate, deliberate step. So an agent
that misunderstands the task produces a wrong draft — which is a thing you read,
not a thing your customers hit.

On top of that, a push runs two independent gates:

1. **Compliance.** Layout and structural violations are hard errors — including
   a `$('Some node')` call that names a node which no longer exists. `--force`
   does not bypass this one, on purpose: if it were bypassable it would be
   bypassed.
2. **Per-node drift.** If a node's remote code moved off the hash recorded at
   last sync and differs from what you're about to send, the push aborts rather
   than overwriting someone. This one `--force` *does* bypass, because
   "I know, do it anyway" is a legitimate thing to mean.

The split matters more than either gate. One is a rule about correctness and
isn't negotiable; the other is a warning about concurrency and sometimes is.

And because going live is the step that actually costs something, the same
correctness check runs there too — including when the agent skips the CLI and
calls n8n's `publish_workflow` tool itself. That's the guard's second refusal,
for a boring reason: a gate you can walk around isn't a gate. It fails closed as
well. If the draft can't be read, nothing is published, and the error says the
*check* couldn't run rather than pretending to know the workflow is broken —
"couldn't verify, so we shipped it" being the one outcome a gate must never
have.

## What I'd flag before you trust it

It's pre-1.0, and the data model may still move in minor versions. Beyond that,
the honest sharp edges:

- **The guard is policy, not security.** It stops an agent that goes through
  decanter. An agent handed your raw n8n credentials can write whatever it likes.
  This is a tool for keeping a cooperating agent inside the lines, not a
  containment boundary for a hostile one.
- **A rename doesn't repair its own references.** n8n's MCP `renameNode` rewrites
  the node name and the connections — not the `$('Old name')` calls in Code nodes
  or in other nodes' expressions. (The editor does rewrite them, in the browser,
  before it saves; the MCP op reports success and leaves them dangling.) Decanter
  catches them at push, `test` and `publish` instead of at 3am, and on Claude
  Code a hook reports them the moment the rename lands — but the repair is still
  someone's job.
- **Pull re-baselines even on conflict.** After a conflicting pull, the next push
  overwrites the remote edit. That's deliberate — files are the source of truth —
  but it will surprise you once.
- **TypeScript is one-way.** n8n stores the compiled JS, so the browser shows
  compiled output, not your source. Round-tripping `.ts` is not a thing.
- **n8n takes a single-writer lock.** A human with the workflow open in the
  editor will make your push fail. Correct behaviour, occasionally annoying
  behaviour.

## Where this leaves the agent

It can do the thing it's good at — restructuring a workflow, wiring a new branch,
renaming a step and repairing what the rename stranded — through the engine's own
validated API. And the part that needed review gets review, because it's a file
in a pull request instead of a string in a payload.

That's the whole idea. Not *don't let agents touch it*. Just: **don't let the
part that needs a diff live somewhere a diff can't reach.**

---

n8n-decanter is MIT-licensed and on npm. The [getting-started
guide](/docs/getting-started/quickstart/) takes about five minutes against an
existing instance, and the [agent
setup](/docs/agents/overview/) covers wiring the guard into Claude Code or any
other MCP client.
