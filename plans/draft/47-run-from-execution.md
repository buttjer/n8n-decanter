# Plan 47 — `run --from-execution <execId>`

**Status:** Draft
**Priority:** P3
**Source:** deferred 2026-07-19 from [Plan 3](../done/3-local-run-and-diff-fidelity.md) C
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

Load a captured execution (`executions` verb) as a `run` fixture: reconstruct
`$input` (via the connections graph — a node's own input isn't stored, only
upstream outputs), the `$('…')` node outputs, and staticData. Deferred because
agents read the execution JSON directly and hand-craft fixtures; the automation
carries the risk (executions run the *published* version on n8n 2.x, and data
can be flawed or stale). `run --chain "A" "B"` stays deferred alongside it (real
ordering/mode semantics — Plan 3's original note).
