# Plan 45 — `init`'s OAuth fall-back-to-paste branch is untested

**Status:** Draft
**Priority:** P3
**Source:** named debt out of [Plan 33](../done/33-post-mcp-pivot-wave.md) Task 3.1

`runOAuthConsent` now has full unit coverage (`test/unit/mcp.test.mts`), but the
branch in `lib/init.mts` that catches a failed consent and prompts for a pasted
`N8N_MCP_TOKEN` instead has none: `init` calls `createPrompt`, which binds
`process.stdin`/`stdout` directly, so there's no seam to script the paste in a
test.

**Recommend:** thread an injectable prompt (or reuse the `openBrowser`-style
hook pattern) into `init` so the fallback path can be driven, then assert: OAuth
throws → paste prompt → token lands in `.env` and the connection check runs
against it. Small; the value is closing the last uncovered auth branch.
Severity: low.
