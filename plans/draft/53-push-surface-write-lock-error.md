# Plan 53 — `push`: surface n8n's write-lock error when a human is editing

**Status:** Draft
**Priority:** P3
**Source:** fell out of the `n8n-editor-live-reflects-mcp-edits` research (the
proxy-removal exploration, [Plan 52](../open/52-remove-watch-browser-reload-proxy.md)).
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

n8n 2.x runs a **single-writer lock**: a UI user acquires it on their first edit
of a workflow. While it's held, an MCP `update_workflow` write is **rejected with
`LockedError`** (`ensureWorkflowEditable`, n8n's `collaboration.service.ts`). So
decanter's `push` (which writes via MCP) has a failure mode it didn't have on the
old REST path: pushing to a workflow a teammate is actively editing in the n8n UI
**aborts**.

Today that surfaces as a raw MCP tool error. `push` should **classify it** and
print a clear, actionable message — e.g. *"'<name>' is being edited in the n8n UI
(a write lock is held) — ask them to stop editing (the lock releases after ~20s
idle or on tab close), then retry."* Small: add the classifier to
[`lib/mcp.mts`](../../lib/mcp.mts)'s error mapping (like `isUnavailableInMcp`) and
the friendly surface in [`lib/push.mts`](../../lib/push.mts) / `watch`.

Verify the exact error shape/text against a real 2.x instance before wording the
match.
