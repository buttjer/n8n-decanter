# Plan 54 — Persist scenario pinData to the draft for the browser's "Test workflow"

**Status:** Draft
**Priority:** P3
**Source:** the proxy-removal watch loop
([Plan 52](../open/52-remove-watch-browser-reload-proxy.md)) + scenarios
([Plan 37](../done/37-scenario-pin-sets.md), done).
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

With the proxy gone, the dev loop is: `watch` pushes code to the draft (MCP) →
the n8n editor live-updates → you hit **"Test workflow"** in the browser. That
browser test runs the **draft**, but only uses pins stored on `workflow.pinData`.

**The gap: MCP cannot persist pinData.** `update_workflow` has no pinData op;
`test_workflow` takes pinData only as an *ephemeral run argument* (not stored);
`prepare_test_pin_data` is read-only. So decanter's committed **scenario** pins
(Plan 37) can't reach the browser's Test-workflow over the MCP path.

**Idea:** a command/flag to push a scenario's pinData onto the draft via the
**public REST `PUT /api/v1/workflows/:id`** (`pinData` persists on n8n ≥ 2.30.7 —
Plan 18 verified), so the in-browser Test-workflow runs with the reviewed pins —
closing the loop between committed scenarios and the browser.

Caveats to settle:
- It's a **full-workflow REST write** — verify it lands on the draft and does
  **not** auto-publish an active workflow (the old `publishIfActive` behavior).
- **API-key-gated** (like `backup`/`executions`/`data-tables`).
- Simpler alternative that needs no code: **pin once in the n8n UI** — those pins
  survive MCP code pushes (`update_workflow` only touches nodes), so the loop
  works after a one-time manual pin.

Decide whether the REST-persist convenience is worth the full-PUT caveat, or
whether "pin once in the UI" is enough.
