# Plan 58 — Preflight-first verb surface: `preflight → push → test → publish`

**Status:** Not started
**Priority:** P1
**Source:** Maintainer session 2026-07-24 (the "does preflight change the draft?" thread). Supersedes nothing; relates to [`../done/36-preflight-verb.md`](../done/36-preflight-verb.md) (which introduced `preflight` alongside `check`/`status`) and [`../draft/57-cli-discoverability-for-agents.md`](../draft/57-cli-discoverability-for-agents.md).
**Snapshot:** 2026-07-24T14:38Z @ 9f3a78a
**Theme:** One verification verb, one honest order. Today `preflight` runs `test` *before* the push, so it grades the instance's draft — not the local code the user is about to ship — and folds both into a single score.

## Why

The verification surface is three verbs deep (`check`, `status`, `preflight`)
and the maintainer could not determine from the docs whether `preflight` writes
to the n8n draft. It does not — but the confusion is earned, and the underlying
defect is worse than the naming:

**`preflight` grades two different artifacts and reports one number.**

| stage | reads |
| --- | --- |
| `check` / `layout` / `types` | local files |
| `simulate` | local files (Docker) |
| `parity` / `drift` / `snapshot` | compares local ↔ remote |
| **`test`** | **the n8n draft** |

`test` runs [`test_workflow`](../../lib/testrun.mts) against the draft tip. When
local differs from the draft, the runtime evidence in a preflight report is
about **code the user is not shipping**. The only signal is the `parity` warn —
worth `-10` ([`lib/preflight.mts:86`](../../lib/preflight.mts#L86)) — so a report
can read *"caution, 90/100"* while half its evidence is off-target. That is
worse than no evidence, because it looks like evidence.

The fix is ordering. `test` only means something **after** the code is on the
draft:

```
preflight   →   push   →   test   →   publish
 local code      local becomes    runs YOUR code   go live
 (offline)       the draft        on the instance
```

Second, `check` and `status` are strict subsets of `preflight`'s findings.
Three verbs that answer overlapping questions is the discoverability problem
[Plan 57](../draft/57-cli-discoverability-for-agents.md) is already circling.
Collapse to one.

## Design decision — what "delete" means

**Decided (maintainer):** `check` and `status` are **removed as verbs**, not
aliased. `preflight` is the single verification entry point.

Two consequences that this plan must actively handle rather than discover late:

1. **The compliance guard is not deleted.** It lives in
   [`lib/validate.mts`](../../lib/validate.mts) and is called by `push` and
   `watch` independently of the `check` verb. Removing the verb removes a
   *view*, never a *gate* — pushes stay guarded.
2. **`status --diff` has no `preflight` equivalent.** `parity`/`drift` report
   counts and node names; `--diff` shows the actual line diff under each
   drifted node ([`docs/cli/status.md:33-35`](../../docs/cli/status.md)). This is
   a real inspection capability and must be carried over (Task 4), or the
   deletion is a regression.

## Tasks

### 1. Remove `test` from `preflight`

- Drop the `test` stage from every profile in
  [`lib/preflight.mts`](../../lib/preflight.mts) — the `runtimeCheck(ctx, "test", …)`
  call at `:341`, `runTestStage` at `:456`, and `"test"` from the `CheckId`
  union (`:26`) and `CHECK_ORDER` (`:34`).
- `preflight`'s runtime tier becomes `simulate` only — local code, Docker,
  offline. Every remaining stage now reads **local files**, so the report
  describes one artifact.
- Delete the now-dead `neverMutate` parameter from `runTest`
  ([`lib/testrun.mts:190,197`](../../lib/testrun.mts#L190)) — `preflight` was its
  only caller. Removing it also removes the "same verb, two behaviours"
  ambiguity that started this thread.
- Scoring/verdict weights in `scoreFindings` (`:82`) rebalance: with the
  instance stage gone, `drift`/`parity` carry the remote story alone.

### 2. Remove the `check` verb

- Drop `"check"` from `VERBS` and `REF_VERBS`
  ([`n8n-decanter.mts:112,122`](../../n8n-decanter.mts#L112)), its `case` arm, and
  its usage line.
- `lib/validate.mts` stays untouched — still called by `push`/`watch`.
- **Template migration is mandatory and is the largest blast radius.** These
  ship into every scaffolded project and break the moment the verb is gone:
  - [`template/.claude/hooks/verify.mjs.example:39`](../../template/.claude/hooks/verify.mjs.example) — the
    PostToolUse hook spawns `["check", workflowId]` on **every file edit**.
    Repoint to `preflight --offline`, and **measure the latency first**
    (Task 6): a per-edit hook has a much tighter budget than a pre-push gate.
  - [`template/package.json.example:8-9`](../../template/package.json.example) —
    `npm run typecheck` and `npm run check`.
  - [`template/.claude/settings.json.example:7-8`](../../template/.claude/settings.json.example) —
    allowlist entries.
  - [`template/CLAUDE.md.example`](../../template/CLAUDE.md.example) and
    [`template/AGENTS.md.example`](../../template/AGENTS.md.example) (lines 35, 227,
    239, 328, 342, 549) — agent-facing prose.
  - [`template/decanter-ts-plugin/index.js.example:5`](../../template/decanter-ts-plugin/index.js.example) — comment.

### 3. Remove the `status` verb

- Drop `"status"` from `VERBS`/`REF_VERBS`, its `case` arm, and its usage line.
- [`lib/status.mts`](../../lib/status.mts) is retained only for whatever
  `preflight`'s `parity`/`drift`/`snapshot` stages already import; delete the
  rest.
- The snapshot-stale hint and the publication-state line survive as
  `preflight` findings (`lifecycle`, `snapshot`) — verify no fact is lost.

### 4. Carry `--diff` onto `preflight`

- Add `preflight --diff`: when `parity` or `drift` is non-clean, print the
  per-node line diff `status --diff` printed. Reuses
  [`lib/diff.mts`](../../lib/diff.mts).
- Without this, Task 3 is a capability regression, not a simplification.

### 5. Rewrite the remediation strings

Every `remediation` / `unlock` string naming a removed verb must be repointed —
they are the CLI's own inline documentation and will otherwise instruct users to
run verbs that no longer exist. Grep `cli("status")`, `cli("push")`,
`cliRef(ctx, "test")` in [`lib/preflight.mts`](../../lib/preflight.mts) (`:292`,
`:298`, `:303`, `:459`, `:461`).

The `parity` warn's message changes meaning entirely: it no longer needs to warn
that "the runtime verdict covers the draft" (there is no instance verdict any
more). It becomes the plain, correct instruction: **`push`, then `test`.**

### 6. Latency budget for the edit-time hook

Measure `preflight --offline` against today's `check` on a representative sync
dir. `check` is sub-second and fires on every agent file edit. If
`preflight --offline` is materially slower, either fast-path it (skip git/state
reads when only `layout`+`types` are requested) or give the hook a narrower
entry point. **Do not ship a per-edit hook that got slower without saying so.**

### 7. Documentation — all three surfaces, plus the flow

Per the root `AGENTS.md` docs rule, a verb change touches every surface:

- **`README.md`** — remove the `check`/`status` rows from `## Commands`; update
  the feature bullets; lead the usage section with the four-verb flow.
- **`/docs`** — delete `docs/cli/check.md` and `docs/cli/status.md`; update
  [`docs/cli/overview.md`](../../docs/cli/overview.md),
  [`docs/cli/preflight.md`](../../docs/cli/preflight.md) (drop the `test` row from the
  preflight-comparison table; document `--diff`),
  [`docs/cli/test.md`](../../docs/cli/test.md) (it is now a **post-push** verb — rewrite
  the "What gets tested" section around that), and the ~20 other files that
  name `check`/`status` (`docs/getting-started/quickstart.md`,
  `docs/agents/*`, `docs/concepts/*`, `docs/faq/troubleshooting.md`).
- **`CHANGELOG.md`** — `[Unreleased]` → **Breaking:** entries for both removals
  and for `preflight` no longer running the instance test.
- **`PLAN.md`** — the preflight ladder and the verification flow are design
  facts; update them.
- `npm run check:docs` must pass — it parses the verb set from
  `n8n-decanter.mts` and will fail until the docs surfaces match. The
  maintained map in
  [`scripts/check-docs-surface.mts`](../../scripts/check-docs-surface.mts) needs the
  two retired verbs recorded.

### 8. Completions and the guard allowlist

- `completion` and `__complete` enumerate verbs — regenerate/verify.
- The scaffolded `.mcp.json` / `settings.json` allowlists reference `check`.

## Acceptance / verification

- `preflight` on a workflow whose local code differs from the draft produces a
  report in which **every stage read local files** — no instance execution, no
  mixed-artifact score.
- `preflight` makes **zero** MCP tool calls in the `--offline` profile, and no
  *write* calls in any profile (wire-log assertion, as
  [Plan 36](../done/36-preflight-verb.md) did at `:237`).
- `check` and `status` exit non-zero with a message naming `preflight` (a
  removed-verb hint, not a bare "unknown verb" — these were documented verbs in
  0.7.0).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.
- A scaffolded project (`init` into a temp dir) has a working edit-time verify
  hook — Task 6's measurement recorded in the PR.
- e2e coverage: the `check`/`status` steps in [`test/e2e.mts`](../../test/e2e.mts)
  are rewritten against `preflight`, not deleted.

## Non-goals

- Changing what `test` does when *you* run it. Its interactive push/keep/restore
  flow stays as-is; it simply stops being something `preflight` invokes.
- Changing `simulate`, `watch`, `push`, or `publish` semantics.
- Aliasing. The maintainer chose removal over `check` → `preflight --offline`
  aliases; recorded here so the decision isn't relitigated.

## Notes — risks worth stating plainly

- **This is the largest breaking change since the Plan 27 verb-grammar flip.**
  Two documented verbs disappear, scaffolded projects need a template
  migration, and any user CI calling `n8n-decanter check` breaks. It warrants a
  minor bump (0.x: breaking → minor) and a migration note at the top of the
  changelog entry.
- **The counter-argument to deleting `check`, recorded for the record:** it is
  the only verb that is instant, offline, and dependency-free, which is exactly
  what an edit-time hook wants. `preflight` is a *gate* — heavier by design.
  Task 6 exists to prove the replacement is fast enough; if it isn't, the
  honest outcome is to reopen the alias question rather than ship a slower
  inner loop.
- **`preflight` loses its instance-side evidence entirely.** After this plan the
  only runtime check inside `preflight` is `simulate`, which needs Docker. On a
  machine without Docker, `preflight` becomes static-only. That is the correct
  trade (evidence about the right artifact beats more evidence about the wrong
  one), but it should be visible in the report, not silent — the `simulate`
  skip already carries an `unlock` string; make sure it reads clearly when it
  is the *only* runtime stage.
