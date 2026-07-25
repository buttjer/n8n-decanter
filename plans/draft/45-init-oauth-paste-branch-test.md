# Plan 45 — `init`'s OAuth fall-back-to-paste branch is untested

**Status:** Draft
**Priority:** P3
**Source:** named debt out of [Plan 33](../done/33-post-mcp-pivot-wave.md) Task 3.1
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

`runOAuthConsent` now has full unit coverage (`test/unit/mcp.test.mts`), but the
branch in `lib/init.mts` that catches a failed consent and prompts for a pasted
`N8N_MCP_TOKEN` instead has none.

> **Premise corrected (2026-07-25).** This note used to say *"`init` calls
> `createPrompt`, which binds `process.stdin`/`stdout` directly, so there's no
> seam to script the paste in a test"* — that is **not true**: `createPrompt`
> ([`lib/prompt.mts`](../../lib/prompt.mts)) is explicitly built to work with
> piped stdin, and [`test/e2e.mts`](../../test/e2e.mts) **already scripts this
> exact paste** ("piped init prompts in order: host, MCP token (paste fallback —
> no TTY, no browser consent), optional API key"). So the recommendation below —
> thread an injectable prompt — aimed at a seam that already exists.
>
> **The real gap is narrower:** the piped path is covered; the **TTY** arm is
> not. That arm is gated on `process.stdin.isTTY` and hardcodes `openBrowser`,
> so exercising it needs either a consent-injection seam or `expect` (which
> root `AGENTS.md` already prescribes for TTY-only paths — possibly requiring
> **no production-code change at all**). Also note #144 added the headless
> `--host/--token/--api-key` path, which lowers the value further.

**Recommend:** decide between an `expect`-driven TTY test and an injectable
consent hook, then assert: OAuth throws → paste prompt → token lands in `.env`
and the connection check runs against it. Small; the value is closing the last
uncovered auth branch. Severity: low.
