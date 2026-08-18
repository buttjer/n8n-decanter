# Plan 80 — say the public API key is not an MCP token, and hand setup back to the user

**Status:** Draft
**Priority:** P2
**Source:** User field feedback 2026-08-18 ("headless-Agent läuft in eine
Sackgasse"). Follows [Plan 75](../done/75-init-cold-start-discoverability.md),
which fixed flag *discoverability* but left both credential questions unanswered;
adjacent to [Plan 70](70-sandboxed-agent-credentials.md) (sandboxed credential
paths), which is about *where* creds live, not *who* mints them.
**Snapshot:** 2026-08-18T11:27Z @ 4dd1433
**Model:** Sonnet — wording on three surfaces plus tests.

A headless agent can prepare `init` completely (host, template, config) and then
stall on the one step it structurally cannot do: minting the MCP token, which
exists only behind browser OAuth or the n8n UI. Both cold-start messages name
the two paths but never say (a) that the **public API key is not accepted** —
that only appears in the 401 *after* the agent has already burned a round — nor
(b) that this step **belongs to the human**, so the agent should hand it back
instead of probing.

## Why

Two distinct gaps, one message.

**1. The naming trap is decanter's, not just n8n's.** The MCP token is minted at
*n8n → Settings → MCP → **API key***, and decanter repeats that path verbatim in
both cold-start messages and in `docs/cli/init.md`. An agent holding an
`N8N_API_KEY` reads "API key" and tries it. The disambiguation exists — but only
on the failure path:

- [`lib/init.mts:441`](../../lib/init.mts) — *"no MCP credentials yet — … re-run
  init with `--token <mcp-token>` (n8n → Settings → MCP → API key) or set
  `N8N_MCP_TOKEN`"* — silent on the public key.
- [`lib/mcp.mts:648`](../../lib/mcp.mts) — *"no MCP credentials — run
  `n8n-decanter init . --token <mcp-token>` …"* — same silence.
- [`lib/mcp.mts:584`](../../lib/mcp.mts) — 401 only: *"… (the public API key is
  not a valid MCP token)"*. Correct, one round too late.

**2. Nothing says setup is the user's job.** Plan 75's non-goal was "not an
auto-configuration path — the agent correctly refused to write `.env` itself;
that boundary stays." That boundary was *observed*, never *stated to the agent*.
The messages read like a to-do the agent should complete, so a blind session
keeps trying (fake tokens, flag-name probes) instead of stopping and asking. The
maintainer's standing position — **setup belongs in the user's hands, not the
agent's** — should be a sentence the agent actually reads at the moment it is
stuck, not only a rule in the docs.

## Scope

1. **Both "no MCP credentials" messages** ([`lib/init.mts:441`](../../lib/init.mts),
   [`lib/mcp.mts:648`](../../lib/mcp.mts)) gain the disambiguation now stranded in
   the 401: the public API key (`N8N_API_KEY`) is a *different* credential and is
   rejected here.
2. **A hand-back line** in the same two messages: minting an MCP token needs a
   browser consent or the n8n UI — an agent without one should ask its user for
   the token rather than keep trying. Keep it one line; these messages are
   already dense.
3. **Docs** — name the trap once, explicitly, where the phrase appears:
   [`docs/cli/init.md`](../../docs/cli/init.md) (lines ~20–22, ~52) and the
   troubleshooting FAQ. State the ownership boundary in the agent-facing docs
   (`docs/agents/overview.md`, `template/AGENTS.md.example`) so it is not only in
   an error string.
4. **CHANGELOG** `[Unreleased]` → Changed (user-facing message wording).
5. **Tests** — extend the Plan 75 unit coverage (both cold-start errors carry a
   non-interactive fix) with: both carry the not-the-API-key clause and the
   hand-back clause. `test/e2e.mts:724` already asserts the init warning fires.

## Non-goals

- No change to the interactive TTY flow, and **no auto-configuration** — the
  boundary Plan 75 set stays: decanter never mints or guesses a credential for
  the agent.
- Not a new credential path (that is [Plan 70](70-sandboxed-agent-credentials.md)).

## Verification

- Unit assertions above; `npm test`.
- Field-test signal: a blind cold-start round (S14 shape,
  `FIELD_NO_SEED_ENV=1`) should end turn 1 by *asking the user for the token*,
  with no attempt to pass `N8N_API_KEY` as the MCP token.
