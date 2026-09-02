# Plan 87 — the auth failure message sends users to a dead end, and calls throttling an expiry

**Status:** Not started
**Priority:** P1 — the advice is a closed loop, and the mislabelling can talk a
user into deleting credentials that were never broken.
**Source:** user field feedback 2026-09-02, report 1 ("Fehlermeldungen, die in
die falsche Richtung zeigen"), verified against the code the same day. Same
batch as [Plan 86](86-init-writes-when-asked-for-help.md),
[Plan 88](88-data-tables-stale-rows-and-refs.md),
[Plan 89](89-rest-verbs-prerequisite-chain.md),
[Plan 90](90-backup-source-instance-stamp.md) and
[Plan 91](../draft/91-guard-hint-for-credential-type-refusal.md).
**Snapshot:** 2026-09-02T04:57Z @ 3c5ee4d
**Model:** Sonnet — small, offline, two files.

When the MCP refresh token is spent, decanter says `re-run: n8n-decanter init`.
`init` reuses `.decanter-auth.json` whenever the host matches and never re-mints,
so it re-probes with the same dead credentials, prints "credentials written
anyway", and returns the user to the start. Worse: **any** failing refresh wears
the words "session expired", including an HTTP 429 — so n8n merely rate-limiting
reads as a dead session, and the printed advice pushes the user toward throwing
away credentials that are fine.

## Why

These are two defects in one sentence of output, and they compound in the worst
order: the message misdiagnoses the cause, then prescribes a remedy that cannot
work for the cause it named. A user following it exactly ends up deleting a
working credential file — the report describes reaching for exactly that, and
only the docs (which say "delete `.decanter-auth.json`, then `init`") stopped it
being wasted effort. The CLI should not need the docs to correct it.

The "safe side" here is unambiguous and worth naming: **never advise discarding
a credential unless we know it is spent.** Only `invalid_grant` knows that.

## Findings, as verified

1. **Every non-ok refresh response becomes the same error.**
   `refreshAccessToken` (`lib/mcp.mts:241-243`) does:
   ```ts
   const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
   throw new TokenRefreshError(reason);
   ```
   and `TokenRefreshError`'s message (`lib/mcp.mts:200`) is
   `MCP session expired (token refresh failed: ${reason}) — re-run: n8n-decanter init`.
   So a 429 renders as `MCP session expired (token refresh failed: HTTP 429)`.
2. **The 429 backoff does not cover the token endpoint.** It lives in `#rpc`
   (`lib/mcp.mts:567-575`), which wraps `/mcp-server/http` calls only.
   `refreshAccessToken` and `oauthDiscovery` each do a bare `fetch`. A throttled
   refresh is therefore neither retried nor named — the one place a retry would
   have made the error disappear entirely.
3. **`init` cannot re-mint.** `lib/init.mts:591` takes the
   `auth !== null && auth.host === host` branch and logs `using existing MCP
   OAuth credentials (.decanter-auth.json)`; the OAuth consent flow is in the
   `else if (interactive)` branch below it and is never reached. `init`'s verify
   step then builds a client from those same credentials
   (`lib/init.mts:672-687`) and, on failure, logs
   `MCP check failed (…) — credentials written anyway`. It has the failure in
   hand and does nothing with it.
4. The internal handling is otherwise careful and should not be disturbed:
   `#refresh` (`lib/mcp.mts:491-509`) already treats `invalid_grant` as the only
   reason to conclude a token is genuinely spent, and re-reads the file to
   resolve a lost cross-process rotation race. The defect is in what reaches the
   user, not in the race logic.

## Tasks

1. **Retry 429 on the token endpoint.** Give `refreshAccessToken` the same
   backoff `#rpc` uses (`lib/mcp.mts:567-575`): honour `Retry-After`, cap at the
   verified 5-minute window, same retry ceiling. Keep the sleep injectable the
   way `#rpc`'s is (`lib/mcp.mts:387` — "injectable for tests only") so the test
   does not take real seconds. Consider `oauthDiscovery` in the same pass; it
   sits on the same path and has the same gap.
2. **Stop calling non-`invalid_grant` failures an expiry.** Split
   `TokenRefreshError`'s message by reason:
   - `invalid_grant` → the credential really is spent (see task 3 for the
     wording);
   - `HTTP 429` (if it survives task 1's retries) → "n8n is rate-limiting the
     token endpoint — wait and retry; **your credentials are fine**";
   - anything else → name the reason without diagnosing it, and do **not**
     suggest discarding anything.
   The explicit "your credentials are fine" line is the point of the task: the
   report shows a user reasoning their way toward deletion from silence.
3. **Make the `invalid_grant` advice executable.** Two candidates, in preference
   order:
   - **`init --reauth`** (or `--force-auth`): skip the reuse branch at
     `lib/init.mts:591` and go straight to consent. Then the error text can name
     one command that actually works.
   - Failing that, the error names the real steps the docs give: delete
     `.decanter-auth.json`, then `init`.
   Either way the message must stop naming a bare `init`.
4. **Let `init`'s verify step act on what it learns.** When the probe at
   `lib/init.mts:680` fails with a spent-token error specifically (not a network
   error, not a 403 `MCP access is disabled` — that is
   [Plan 74](../done/74-mcp-disabled-403.md)'s case), offer re-consent on a TTY
   instead of `credentials written anyway`. This is what closes the loop the
   user fell into.
5. **Audit the sibling messages for the same advice.** `lib/mcp.mts:110`
   (corrupt auth file) and `lib/mcp.mts:141` (auth file minted for another host)
   both end in `re-run: n8n-decanter init`. For **those two** the advice is
   correct — a corrupt or wrong-host file is not reused, so `init` does re-mint.
   Confirm that and leave them alone; the point of the task is to not "fix" them
   by reflex.

## Acceptance / verification

- Mock token endpoint returning 429 then 200: the refresh succeeds, nothing is
  printed about an expired session, and the injected sleep is what was waited on.
- Mock token endpoint returning a persistent 429: the error says rate-limited,
  says the credentials are fine, and does **not** name `init`.
- Mock token endpoint returning `{"error":"invalid_grant"}`: the error names a
  command that re-mints (task 3's choice), and following it against the mock
  produces working credentials.
- `init` run twice against a host whose refresh token was revoked between runs
  does not terminate in `credentials written anyway` on a TTY.
- The existing lost-race behaviour in `#refresh` (`lib/mcp.mts:491-509`) still
  passes its tests untouched.

## Notes

- **CHANGELOG:** `Fixed` — "a rate-limited (429) MCP token refresh is retried
  and no longer reported as an expired session"; `Fixed`/`Added` — whichever
  task 3 lands.
- **Docs:** the auth/troubleshooting page currently carries the
  delete-then-`init` recipe the CLI should have printed. If task 3 adds
  `--reauth`, that page, the `init` docs page, the README `## Commands` row and
  `overview.md` all move together (root `AGENTS.md`, "Documentation site") —
  `npm run check:docs` will not catch a new *flag*.
- **PLAN.md:** `.decanter-auth.json`'s lifecycle is described there; a `--reauth`
  path is worth a sentence.
- Do not touch the rotate-persist logic. Single-use rotating refresh tokens are
  the reason `#refresh` looks the way it does, and this plan is about output.
