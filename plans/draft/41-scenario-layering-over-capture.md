# Plan 41 — Scenario layering over a fresh capture

**Status:** Draft
**Priority:** P2
**Source:** deferred 2026-07-22 from [Plan 37](../done/37-scenario-pin-sets.md) Decision 2
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

An optional hybrid source: `simulate`/`test` `--scenario <slug> --execution <id>`
overlays a scenario's per-node pins on a fresh capture — the capability the
retired `simulate --pin` fixtures provided (pin one flaky network node, keep the
rest live-fresh). Rejected for Plan 37 v1 to keep one precedence rule (a run
pins from a named scenario *or* a capture, never a mix); revisit if the
flaky-node workflow is missed in practice.
