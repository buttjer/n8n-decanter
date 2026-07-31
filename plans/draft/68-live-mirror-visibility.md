# Plan 68 — The live mirror runs a full pull, and the agent never hears about it

**Status:** Draft
**Priority:** P1
**Source:** the mechanism behind claim B2 of the 2026-07-30 field report ("pull
hat ungepushte Änderungen kommentarlos überschrieben"), traced 2026-07-31.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

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

Compounding it: `template/CLAUDE.md.example:23-26` prescribes "pull after each MCP
rename" with no push-or-commit-first caveat, i.e. it steers into the destructive
path deliberately and repeatedly.

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
[Plan 63](../open/63-field-feedback-bugfixes.md) tasks 1–3 (pull's safety commit,
the un-gated warning, the mirror honouring a failed commit) — this plan is only
the visibility and contract half.
