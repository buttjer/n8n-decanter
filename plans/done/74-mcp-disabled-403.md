# Plan 74 — A switched-off MCP server answers 403, and decanter has no message for it

**Status:** Done (2026-08-04)
**Priority:** P2
**Source:** fell out of building [Plan 61](61-field-test-scenario-wave-2.md)'s
`disable-mcp` pre-hook; reproduced against real n8n 2.30.7 on 2026-08-04.
**Snapshot:** 2026-08-04T19:40Z @ e227e7f

Turning MCP access off in n8n — the exact thing the docs tell a user to turn
*on* — makes every decanter command fail with a bare
`MCP initialize failed: 403 Forbidden {"message":"MCP access is disabled"}`.
The 401 and 404 branches beside it both hand the user a next step; the 403 path
has none, and it is the one a user reaches by flipping a documented switch.

## What was verified (n8n 2.30.7, live)

`PATCH /rest/mcp/settings {"mcpAccessEnabled": false}` returns 200 and takes
effect immediately. Afterwards, `POST /mcp-server/http`:

| request | answer |
| --- | --- |
| no token | **401** (unchanged — same as when MCP is enabled) |
| stale/rotated token | **401** |
| **valid token** | **403** `{"message":"MCP access is disabled"}` |

**It never 404s.** [`lib/mcp.mts:586`](../../lib/mcp.mts) maps 404 to *"no MCP
endpoint … enable MCP access in n8n (Settings → MCP; needs n8n ≥ ~2.20)"* — the
right advice, wired to a status this instance does not produce. 404 evidently
means "too old to have the endpoint at all", not "switched off".

`AGENTS.md`'s MCP section said *"Probe with no token → 401 when live, 404 when
disabled/too-old"*; the no-token probe **cannot** distinguish live from
disabled. Corrected in the same change as this note.

## Why it matters

- It is a **documented, one-click state**. The n8n UI switch that enables MCP
  also disables it; a user who toggles it off (or an admin who never toggled it
  on for a second instance) lands here.
- The **401 masks it.** If the token is also stale, the user sees the 401
  message and chases a token that was never the problem. That ordering trap is
  worth a mention in the troubleshooting page regardless of the fix.
- Every other reachable failure on this path has a routing hint. This one
  reads like an internal error.

## Done

1. **403 mapped** in [`lib/mcp.mts`](../../lib/mcp.mts) beside 401/404: it
   surfaces n8n's own `message` plus *"turn MCP access on in n8n (Settings →
   MCP); if it is on, the token's user may lack access"*. A 403 with no JSON
   body still routes.
2. **404 re-worded** — it means the endpoint is absent (wrong `N8N_HOST`, or an
   n8n too old to ship one), and says explicitly that a switched-off server
   answers 403 instead.
3. [`docs/faq/troubleshooting.md`](../../docs/faq/troubleshooting.md) — its own
   section, including the **401-masks-403** ordering trap, and the 404 section
   corrected.
4. `CHANGELOG.md` — Fixed.
5. Two cases in [`test/unit/mcp.test.mts`](../../test/unit/mcp.test.mts): a mock
   answering 403 with n8n's body, and one with no JSON body.

The condition stays in S13's rubric — the fix changes *what* a blind agent is
graded on (does the routed message land?), not whether it is worth measuring.

## Notes

- Found **offline, without a blind round** — the D6 principle Plan 61 argues
  for: a finding provable with a probe should never cost Sonnet turns. S13 keeps
  the condition in its rubric to grade the *agent's* reaction once the message
  is fixed.
