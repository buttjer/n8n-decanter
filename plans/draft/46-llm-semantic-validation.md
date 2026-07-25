# Plan 46 — LLM semantic validation

**Status:** Draft
**Priority:** P3
**Source:** backlog item
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

LLM-based *semantic* workflow validation — **as a `preflight` stage/flag, not a
new verb** (see the 2026-07-25 note below). Split out of the
validator idea — [Plan 2](../done/2-offline-validation-and-rename.md) covers only
the offline structural subset and explicitly defers this.

**Shape note (2026-07-25).** The verify surface is **consolidating, not
expanding**: [Plan 60](../done/60-preflight-first-verb-surface.md) made
`preflight` the one local-code gate, and [Plan 59](../open/59-declutter-verify-verbs.md)
*removes* `check`/`status`/`simulate` as verbs in favour of `preflight` flags.
A semantic check should therefore land as a **preflight stage** (opt-in flag),
not a fifth verb. Two consequences worth stating when this graduates: the stage
is **network + billable**, so it must be explicitly opt-in (never in the default
profile), and it needs a `--require=` id like every other stage so CI can demand
it.
