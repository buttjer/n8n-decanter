# Plan 44 — `run`'s faked n8n context diverges from n8n

**Status:** Draft
**Priority:** P2
**Source:** backlog item

`$jmespath` throws, other globals are absent, and the docs never mark the
boundary. `lib/run.mts` `buildGlobals`: `$jmespath` is wired to *throw* ("not
implemented in `run` — assert on the data directly"), even though it is one of
the stable Code-node globals the project already treats as core (it ships in
`n8n-globals.d.ts`; see [Plan 43](43-n8n-globals-dts-sourcing.md)). A node that
uses `$jmespath` — common in data-shaping nodes — cannot be `run` at all, and
the failure only surfaces mid-run at the call site. Other real globals are
simply missing (`$vars`, `$secrets`, `$ifEmpty`, `$evaluateExpression`,
`$max`/`$min`; `$runIndex` pinned at 0; `$('Node').item` is not the per-item
*linked* item in `runOnceForEachItem`), so those nodes hit an opaque
`ReferenceError`. Meanwhile `docs/cli/run.md` sells it as "executes a node's body
against a faked n8n context" with no list of what is covered vs. absent.

**Recommend:** (a) implement `$jmespath` — n8n's `$jmespath(obj, expr)` maps
straight onto the `jmespath` package's `search(obj, expr)`, a small pure-JS dep
wired exactly like luxon; and (b) document the emulated-vs-unsupported boundary
in `docs/cli/run.md`, and have unsupported globals fail with a friendly "not
emulated in `run`" message instead of a bare `ReferenceError`. Relates to
[Plan 31](../open/31-run-sandbox-boundary.md) and
[Plan 47](47-run-from-execution.md). Severity: moderate.
