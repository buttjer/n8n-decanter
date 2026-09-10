# Plan 92 — an upstream-auth mode, so a gateway can front the instance

**Status:** Done (2026-09-09)
**Priority:** P1 — small, offline, and the only alternative today is a
placeholder credential that does not actually work.
**Source:** operator report 2026-09-09, from wiring an n8n instance behind
agentgateway. Adjacent to [Plan 70](../draft/70-sandboxed-agent-credentials.md)
(file-free credentials) and [Plan 87](87-auth-errors-point-the-wrong-way.md)
(auth-error wording), but neither covers "decanter holds no credential at all".
**Snapshot:** 2026-09-09T00:00Z @ 76ae1de
**Model:** Opus — the design question (what the mode *is*) was the work; the
edits are small and spread across nine files.

Pointing decanter at a proxy that attaches the n8n credentials itself worked
only by putting a **fake value in `N8N_API_KEY`** to satisfy `requireApiKey` — a
placeholder sitting in a credential file, which is the shape somebody eventually
tries to rotate. `N8N_DECANTER_AUTH=upstream` replaces it: decanter sends no
credential header at all, on either backend.

## Why

**Measured 2026-09-09 against the live gateway:** a client-sent
`X-N8N-API-KEY` is *appended* to the one the gateway adds, and n8n answers
`401` to the pair. So the placeholder is not merely ugly — it fails exactly
like a real-but-wrong key, and reads as a server fault. Only omitting the
header works, and nothing in the CLI could omit it.

## Design decisions

- **One explicit switch, not inference.** A gateway URL is indistinguishable
  from an n8n URL, and the problem is the header, not the path. No URL building
  changed: `N8N_HOST` at the proxy already yields `host + /api/v1/…` and
  `host + /mcp-server/http`, so one proxy route serves both.
- **`N8N_DECANTER_AUTH`, not `N8N_AUTH_MODE`.** `N8N_HOST` / `N8N_API_KEY` /
  `N8N_MCP_TOKEN` carry n8n's name because they *are* n8n's credentials; this is
  a decanter behavior switch — the category `N8N_DECANTER_DIR` established. It
  will often sit in a `.env` an n8n container also reads, in a namespace that
  already holds `N8N_BASIC_AUTH_*` and `N8N_AUTH_EXCLUDE_ENDPOINTS`.
- **An unknown value throws** rather than falling back to the default. A typo
  would otherwise restore the header silently and reproduce the very 401 the
  mode removes. The throw is in `loadConfig`, so it surfaces on offline verbs
  too — deliberate: it is a setup error, not a credential error.
- **`McpAuth` gained a third member, `{kind:"upstream"}`** — a member, not a
  re-reading of `null`, so `resolveMcpAuth`'s `null` keeps meaning exactly
  "unusable, tell the user how to set up" and the cold-start message is
  unchanged.
- **`bearerToken()` became `authHeaders()`**, returning `{}` in upstream mode,
  plus a `canRefresh` getter. Two reasons: "send no credential" then lives in
  one place instead of being re-derived at three call sites (and a
  `...(token && {…})` that drops on `""` is not a mistake the compiler catches);
  and the check sits *above* `#accessToken`, whose OAuth machinery would
  otherwise have needed widening for a case that can only TypeError there.
- **Credentials already on disk are kept and warned about, not deleted.**
  Removing a user's credential is not init's call, and they are what a switch
  back needs — but an ignored secret has to read as ignored, or it looks live to
  whoever finds it next.

## What changed

- `lib/types.mts` — `DecanterConfig.authMode`, `AuthMode`.
- `lib/config.mts` — `AUTH_MODE_ENV`, `readAuthMode` (throws on unknown),
  `loadConfig` reads it, `requireApiKey` passes through in upstream mode.
- `lib/api.mts` — `authMode` on the client; `X-N8N-API-KEY` **omitted**, not
  blanked; a 401 branch that did not exist before; mode-aware 403/scope hints.
- `lib/mcp.mts` — the third `McpAuth` member; `resolveMcpAuth` takes the mode
  and answers first, warning about ignored credentials; `authHeaders()` +
  `canRefresh` + `authKind` replacing `bearerToken()`; `#accessToken` guards
  against the unreachable case; three-branch terminal 401.
- `lib/mcpconnect.mts`, `lib/mcpserve.mts` — spread the headers; gate the 401
  retry on `canRefresh`; third 401 branch in the stdio guard's own wording.
  **`mcp serve` now drops the agent's session secret** rather than swapping it
  for a credential that does not exist.
- `lib/init.mts` — `--auth`, refusals against `--token`/`--api-key`/`--reauth`,
  the credential ladder skipped, the mode written to `.env`, and **the REST
  probe run without a key** (it was gated on the key, so upstream mode would
  have verified MCP and nothing else).
- `lib/preflight.mts`, `n8n-decanter.mts` — `hasApiKey` → `restAvailable`,
  true in upstream mode; `authMode` on preflight's hand-written `N8nApi`; the
  connect remediation drops `init`; flag plumbing; `mcp serve` banner.

## Acceptance / verification

`npm test` (780 unit + 96 e2e + 34 guard-proxy + 8 mcp-spawn + 18 interactive),
`npm run lint`, `npm run typecheck`, `npm run check:docs` — all green.

The load-bearing tests:

- **e2e** runs the mock in `gatewayMode`, where **any** client-sent credential
  401s. So `init --auth upstream` + `diff` (MCP) + `executions` (REST) exiting
  0 *is* the proof that no header was sent — and the old placeholder workaround
  fails the step. Written as an inversion rather than a relaxation for exactly
  that reason.
- **guard-proxy** asserts the forwarded request carries no `authorization` and
  is not the agent's session secret — the twin of the existing "agent secret
  swapped for the real credential".
- **api-scopes** asserts the key header is *absent*, not empty — a difference
  invisible to any assertion that only checks the value.

## Not done

`template/.env.example` has no commented `N8N_DECANTER_AUTH=upstream` line: the
path is blocked by this machine's Read `permissions.deny`, and the guard was not
worked around. It is one comment line, listed in the handover.

## Notes

Not marked `Class: Distinctive feature` — it is deployment plumbing, not a
capability that differentiates decanter from n8n or from generic git-sync.
