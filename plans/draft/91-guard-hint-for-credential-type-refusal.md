# Plan 91 — guard hint when n8n's MCP refuses a credential type the node actually accepts

**Status:** Draft
**Priority:** P3 — not decanter's bug, and not reproduced here yet. Probe before
building.
**Source:** user field feedback 2026-09-02, report 1, closing observation ("Eine
Beobachtung noch, die nicht decanter gehört, aber ihm begegnet"). Same batch as
[Plan 86](../open/86-init-writes-when-asked-for-help.md) …
[Plan 90](../open/90-backup-source-instance-stamp.md).
**Snapshot:** 2026-09-02T04:57Z @ 3c5ee4d

n8n's MCP layer refuses to attach the generic `oAuth2Api` credential to a
newly-added `n8n-nodes-base.httpRequest` node — `node type does not accept
credential 'oAuth2Api'` — although the node's type definition lists it and
existing nodes carry it. The same assignment succeeds over REST. An agent that
hits this has no way to know a working path exists; the guard sees the refusal
go past and could point at it.

## Why

The refusal is n8n's, and decanter should not try to work around it. But
decanter is the thing holding the conversation when it happens, and it already
knows the REST path works — `backup create` / `backup restore` is exactly the
route the same reporter used to deploy a whole workflow while MCP was down. A
recognised error string plus one line of guidance is an hour saved for the next
agent, at close to zero cost and zero risk.

The reason this is a draft and not a plan: **one field report, no local
reproduction.** Pattern-matching on an upstream error string is a maintenance
liability if the string is wrong, rare, or already fixed upstream.

## Scope

1. **Reproduce first, on a pinned tag.** `npm run test:smoke` boots real n8n
   across the pinned tags; add a throwaway probe (not a committed test yet) that
   adds an `httpRequest` node over MCP and tries to attach `oAuth2Api`.
   Confirm the exact error text, confirm REST accepts the same assignment, and
   record which n8n versions do it. **If it does not reproduce on the current
   pins, close this draft with that finding** — that is a valid outcome and
   worth writing down either way.
2. **If it reproduces:** recognise the message in the guard's forwarding path
   (`lib/mcpserve.mts`, shared by `mcp connect` and `mcp serve`) and append the
   REST alternative. Both transports share `guardMessage`, so the hint must live
   where they cannot drift.
3. **Do not turn it into a refusal.** The guard's two refusals (`jsCode` writes,
   dangling-ref publishes) are deliberate and narrow. This is annotation of an
   upstream error on its way through, nothing more.
4. **Check whether it is already fixed upstream** before writing any of it — an
   n8n issue or a later release may make the whole thing moot.

## Notes

- Root `AGENTS.md` records that n8n's MCP tool surface is version-fragile and
  that the docs-site tool reference is incomplete. Any hint added here needs the
  n8n version range it was verified against, in a comment, per the
  measure-before-you-tune rule.
- No CHANGELOG or docs entry until it graduates out of `draft/`.
