# Plan 42 — Auto-refresh `workflow.json` after MCP structure edits

**Status:** Draft
**Priority:** P2
**Source:** backlog item (2026-07-23)

Snapshot freshness without an explicit `pull`. Today `workflow.json` is written
**only** by `pull` (`lib/pull.mts`; `watch` refreshes it only because it pulls).
So after an agent restructures a workflow over the guarded MCP proxy
(`mcp connect`/`serve`: create/rename/add-node/wire), the local read-only
snapshot is **stale** until the next manual `pull`, and the "structural changes
show up as clean git diffs" story lags behind what the agent just did.

Investigate two variants: (a) **guard-proxy-triggered refresh** — the proxy
already sees every `update_workflow`/create/rename call (`lib/mcpserve.mts`); on
a structure-mutating op it could pull that workflow to rewrite `workflow.json`
(and auto-commit); (b) **broader auto-pull on every change** — a general "keep
the mirror live" mode. Design questions: which ops count as structure-mutating,
debounce/races against concurrent local edits and `push`, git-commit churn,
draft-vs-tip timing, and on-by-default vs. opt-in (like `browserReload`). Decide
whether it's worth it or whether explicit `pull` stays the model.
Severity: low/medium.
