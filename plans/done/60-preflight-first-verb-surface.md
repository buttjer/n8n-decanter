# Plan 60 — Preflight-first verb surface: `preflight → push → test → publish`

**Status:** Done — shipped in PR #162 (code, docs on every surface, agent contract, tests). Renumbered 58 → 60: [plans/draft/58-guard-route-robustness.md](../draft/58-guard-route-robustness.md) landed first (#164) and owns the number; 59 was already taken by the declutter plan this one spawned.
**Priority:** P1
**Source:** Maintainer session 2026-07-24 (the "does preflight change the draft?" thread). Relates to [`../done/36-preflight-verb.md`](../done/36-preflight-verb.md) (which introduced `preflight` with `test` as a stage) and [`../draft/57-cli-discoverability-for-agents.md`](../draft/57-cli-discoverability-for-agents.md).
**Snapshot:** 2026-07-24T14:38Z @ 9f3a78a
**Theme:** `preflight` ran `test` *before* the push, so it graded the instance's draft — not the local code about to ship — and folded both into one score. Fix the order; make the flow the documented path.

## Why

`test` runs [`test_workflow`](../../lib/testrun.mts) against the **draft tip**.
Every other preflight stage grades **local files**:

| stage | reads |
| --- | --- |
| `layout` / `types` | local files |
| `simulate` | local files (Docker) |
| `parity` / `drift` / `snapshot` | compares local ↔ remote |
| **`test`** | **the n8n draft** |

When local differs from the draft, the runtime evidence in a preflight report
was about **code the user is not shipping**. The only signal was the `parity`
warn — worth `-10` — so a report could read *"caution, 90/100"* while half its
evidence was off-target. That is worse than no evidence, because it looks like
evidence.

The fix is ordering. `test` only means something **after** the code is on the
draft:

```
preflight   →   push   →   test   →   publish
 local code      local becomes    runs YOUR code   go live
 (changes         the draft       on the instance
  nothing)
```

Secondary, and the reason the thread started: `preflight` invoking `test` in a
hidden never-mutate mode meant one verb name covered two behaviours. Removing
the stage removes the ambiguity — `test` is now unambiguously something *you*
run, after `push`.

## Scope

**In:** remove the `test` stage from `preflight`; document the flow.
**Out:** deleting the `check` / `status` verbs. That was considered in the same
session and split off — see [Deferred to Plan 59](#deferred-to-plan-59) below.

## Tasks

1. **Remove the `test` stage** — [`lib/preflight.mts`](../../lib/preflight.mts):
   drop it from `CheckId`, `ALL_CHECK_IDS`, `ProfileSpec`, `PROFILES`, the
   `runtimeCheck` call, and delete `runTestStage`. Drop the now-unused
   `runTest` import and the `testMcp` context field (and its ≥320 s client in
   [`n8n-decanter.mts`](../../n8n-decanter.mts)).
2. **Delete `neverMutate`** from `runTest`
   ([`lib/testrun.mts`](../../lib/testrun.mts)) — `preflight` was its only caller.
   The read-only guarantee now comes from preflight never invoking `runTest` at
   all, which is a stronger and more legible contract than a flag.
3. ~~**Redefine `--quick`.**~~ **SHIPPED AS REMOVAL instead (maintainer call
   during execution).** The task as written planned to redefine `--quick` to
   static-only, since with `test` gone it was byte-identical to the default
   profile. The maintainer chose to **remove the flag outright** rather than
   give users a fourth meaning to learn and then unlearn — [Plan 59](../open/59-declutter-verify-verbs.md)
   retires the profile vocabulary entirely, so a transient redefinition would
   have been churn for nothing. `--quick` now **rejects** with a migration hint
   (static-only is `check`; a no-instance gate is `preflight --offline`), pinned
   by a unit test and an e2e step. Three profiles remain: default, `--full`,
   `--offline`.
4. **Reject `--require=test`** with the reason and the replacement, not a bare
   "unknown check" — it shipped in 0.6.0 and may sit in a user's CI config
   (`RETIRED_CHECK_IDS`).
5. **Reword the `parity` warn.** It was a caveat about the runtime tier grading
   the draft; that can't happen now. It becomes the next step in the flow:
   *"push to make it the draft, then test"*.
6. **Docs — all three surfaces** (root `AGENTS.md` rule): `README.md` feature
   bullet + `## Commands` row; [`docs/cli/preflight.md`](../../docs/cli/preflight.md)
   (the flow section, the ladder table, profiles, safety contract, sample
   output), [`docs/cli/test.md`](../../docs/cli/test.md) (it is now a **post-push**
   verb), [`docs/cli/overview.md`](../../docs/cli/overview.md); `CHANGELOG.md`
   under `[Unreleased]` with **Breaking:** prefixes.
7. **PLAN.md** — the preflight ladder and the verification flow are design
   facts; update them.

## Acceptance / verification

- `preflight` makes **no** `test_workflow` / `execute_workflow` / `get_execution`
  call in **any** profile (unit-tested across all three — `--quick` was removed
  rather than redefined, see Task 3).
- On a TTY, against an **unpublished** workflow with local ahead of the draft —
  the case where the `test` verb pushes without even prompting — `preflight`
  issues no write and no run.
- Every verdict-bearing stage grades local code; `parity` reports the
  divergence and points at `push`.
- No two profiles resolve to the same spec.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Notes — consequences worth stating plainly

- **`--full` becomes the only profile with a runtime check.** `simulate` is the
  sole remaining runtime stage and it needs Docker. Plain `preflight` now gives
  static + sync only. This is the correct trade — evidence about the right
  artifact beats more evidence about the wrong one — but it is a real reduction
  in what the default profile proves, and the docs say so rather than letting a
  green default imply runtime coverage.
- **Auto-fetch now gates on `simulate`.** The default profile no longer fetches
  a capture (nothing consumes it) and reports a missing one as `info`, not
  `warn`.
- `--quick`'s **removal** is breaking for anyone who passed it (it now exits
  non-zero with a migration hint). The alternatives were worse: leaving two
  flags with identical behaviour, or redefining it into a fourth meaning that
  Plan 59 would retire days later.

## Deferred to Plan 59

Now [Plan 59](../open/59-declutter-verify-verbs.md).

Collapsing **`check`**, **`status`**, and **`simulate`** into `preflight` (+ a
new `diff` verb, + dropping the profile system for plain flags) was part of the
original ask and is deliberately not in this change. It has its own plan now —
[Plan 59](../open/59-declutter-verify-verbs.md), which **supersedes this plan's
`--quick` redefinition** (Plan 59 removes profiles entirely). The reasons it's
separate:

- `check` is invoked by the scaffolded PostToolUse hook
  ([`template/.claude/hooks/verify.mjs.example`](../../template/.claude/hooks/verify.mjs.example))
  on **every file edit**, plus `template/package.json.example` scripts and the
  agent allowlists. It is sub-second by design; `preflight --quick` must be
  measured against it before it can replace it.
- `status --diff` shows the per-node line diff. `preflight` has no equivalent
  and would need one first, or the removal is a capability regression.

Both are worth doing — as their own plan, with the latency measurement and the
`--diff` port as prerequisites, not as a rider on this one.
