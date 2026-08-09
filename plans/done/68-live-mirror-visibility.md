# Plan 68 — The live mirror runs a full pull, and the agent never hears about it

**Status:** Done — the contract says what the mirror does, and the clobber now
reaches the agent through the tool result. The dirty-skip alternative was
weighed and **rejected**; see "The decision".
**Priority:** P1
**Source:** the mechanism behind claim B2 of the 2026-07-30 field report ("pull
hat ungepushte Änderungen kommentarlos überschrieben"), traced 2026-07-31.
**Snapshot:** 2026-08-08T16:20Z @ 59079bb *(re-verified; the contract half is
done, the design half is the remaining scope — see "Status 2026-08-08")*

The reporter blamed the `pull` verb; the real path was the background mirror. It
fires a **full `pull`** — code files, state, file renames — after every forwarded
structure op (39 renames → 39 pulls), it *does* warn on clobbering unpushed
edits, and that warning goes to a stream the agent structurally cannot read.
Meanwhile the file the agent is told to trust describes the mirror as a
`workflow.json` snapshot refresh.

## The three layers

1. **What it does:** `defaultRefresh` → `pullWorkflow`
   ([`lib/mirror.mts:110`](../../lib/mirror.mts)), not a snapshot-only refresh.
   It rewrites `code/*.js` with the remote body, moves files on rename, and
   rewrites `.decanter.json`. On by default ([`config.mts:82`](../../lib/config.mts)).
2. **Why it's wordless:** in `mcp connect` the mirror gets `elog`, a stderr-only
   logger, so stdout stays pure MCP protocol
   ([`n8n-decanter.mts:958-968`](../../n8n-decanter.mts)). The scaffolded
   `.mcp.json` spawns it via npx with no redirection → the warning lands in the
   MCP client's server log: not the agent's transcript, not the user's terminal.
3. **Why nobody expected it:** [`template/AGENTS.md.example`](../../template/AGENTS.md.example)
   (live-mirror bullet, ~line 618) and
   [`docs/concepts/configuration.md:35`](../../docs/concepts/configuration.md) say
   "`workflow.json` snapshot" and never mention code files.
   [`docs/cli/mcp-connect.md:50`](../../docs/cli/mcp-connect.md) is honest ("+ code
   files + state") — the *website* is right and the *shipped contract* is wrong.

~~Compounding it: `template/CLAUDE.md.example:23-26` prescribes "pull after each MCP
rename" with no push-or-commit-first caveat, i.e. it steers into the destructive
path deliberately and repeatedly.~~ **No longer true** (re-checked 2026-08-08):
that file now prescribes the repair order and names this exact hazard — *"the
other order loses your code fix to the background refresh."*

## The decision (2026-08-09) — announce, don't prevent

Two candidates were on the table. **Announce won.**

**Rejected — make the mirror careful** (skip the code-file rewrite when a tracked
file is locally dirty). It collides with renames: the file *move* is part of
`pullWorkflow`, so skipping the code half after an MCP rename leaves files under
their old names while `workflow.json` and `.decanter.json` already carry the new
ones. That trades a quiet overwrite for a loud inconsistency — not obviously a
better deal, and it makes the mirror's behaviour *conditional*, which is most of
what the mirror was buying. A background convenience you have to model to trust
has stopped being a convenience.

**Chosen — make the mirror talk.** Behaviour is unchanged; the warning now
reaches the party who can act on it:

- `pullWorkflow` returns the clobbered files instead of only logging them.
- The mirror turns them into a notice naming the files and the recovery
  (`git show HEAD~1:<file>` — the safety commit from Plan 63 is what makes that
  work, so the two halves finally line up).
- `attachMirrorNotices` (shared, `mcpserve.mts`) appends it to the next
  successful **tool result**. Not this call's — the mirror is scheduled *after*
  the op is forwarded and runs debounced, so its own result is long gone.

Two properties the tests pin, because both are ways this could have been
useless: the queue drains **only once a message can carry it** (a handshake
landing in between must not eat the warning), and a notice is delivered
**once** — one that reappears on every later call is noise an agent learns to
skip, which is how it stops being read at all.

**Known, deliberate limit:** `mcp serve` pipes upstream responses through
untouched, SSE included, so there is no parsed message to append to. Buffering
every response to inject an advisory line would cost streaming for all of them to
deliver it on some. On the HTTP transport the stderr warning stays the only
signal. Written down rather than left to be discovered — this plan exists because
a warning went somewhere nobody looks.

`state.mts` still exports `dirtyJsFiles`, still unused; it was the hook the
rejected option would have used.

## Status 2026-08-08 — layer 3 done, layers 1–2 open

**The contract half is fixed.** Both surfaces that under-described the mirror now
say it runs a full `pull` — `workflow.json` **and** `code/` **and**
`.decanter.json`, including file moves on a rename — and that it can therefore
overwrite an unpushed edit:

- `template/AGENTS.md.example` (the shipped contract, the one that mattered)
- `docs/concepts/configuration.md` (`liveMirror` row)

Layer 2 is partly addressed already: [Plan 63](../done/63-field-feedback-bugfixes.md)
gave the mirror a safety commit and made a failed commit stop the pull, so the
overwrite is recoverable — but a recovery you have to *know about* is not
visibility.

**What is still open is the design question, and it is bigger than the draft
made it look.** "Skip the code-file rewrite when a tracked file is locally dirty"
collides with renames: the file *move* is part of `pullWorkflow`, so skipping the
code half after an MCP rename would leave files at their old names while
`workflow.json` and `.decanter.json` name the new ones. That is not silent — the
layout guard flags it — but it trades a quiet overwrite for a loud inconsistency,
and which of those is better is a real decision, not an implementation detail.

Worth weighing against it: the mirror exists so a restructuring agent does not
have to remember `pull`. A mirror that sometimes syncs structure-only is a mirror
whose behaviour you have to model to trust, which is most of what the mirror was
buying. The alternative on the table — surface the clobber count in the forwarded
op's tool-result text, where the agent actually reads — keeps the behaviour simple
and fixes the thing the field report complained about (nobody was told).

`state.mts` still exports `dirtyJsFiles`, still unused.

## Shape of a fix

Docs half is mechanical (say what `mcp-connect.md` already says). The **design
question** is how a background process reaches an agent that only reads tool
results: append a clobber count to the forwarded op's tool-result text? Or have
the mirror **skip the code-file rewrite** (snapshot-only) when a tracked file is
locally dirty — arguably the better default, since the mirror's job is keeping
structure current, not overwriting work in progress. `state.mts` already exports
an unused `dirtyJsFiles` for exactly this.

Related: the report's `parity` observation is **not** a bug — "local code matches
the draft" is true by construction after the overwrite. The point is that the
whole check ladder goes green over content the agent didn't write, which is this
plan's problem, not `parity`'s.

The mechanical pieces are already split out into
[Plan 63](../done/63-field-feedback-bugfixes.md) tasks 1–3 (pull's safety commit,
the un-gated warning, the mirror honouring a failed commit) — this plan is only
the visibility and contract half.
