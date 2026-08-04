# Plan 63 — Field-feedback bugfix sweep

**Status:** Not started
**Priority:** P1
**Source:** the 2026-07-30 field report from an agent driving a 45-node
production workflow (Shopify → eBay, 39 node renames, two code fixes, one
scenario), verified claim-by-claim against the code on 2026-07-31. The clusters
that needed a design call became [Plan 64](../done/64-mcp-rename-does-not-rewrite-refs.md)
… [Plan 71](../draft/71-data-table-writes.md); this plan is the residue that
needs none.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7
**Model:** Sonnet — eight small, well-specified, offline fixes.

Eight independently-shippable defects the field report surfaced (or that fell out
of verifying it), each with an obvious correct fix and no open design question.
Three of them are silent-data-loss or silent-wrong-data bugs — `pull` destroying
uncommitted edits it promised git would save, and `node run` answering
`$('X').all(1)` with output 0's items — so this plan is worth landing ahead of
the drafts it was split out of.

## Why

The report's headline complaints all needed a design decision and are drafted
separately. But verifying them turned up a set of defects that don't: each is a
handful of lines, offline, with a precedent already in the codebase for what the
right behavior looks like. Grouping them keeps eight small PRs from becoming
eight separate planning conversations.

Everything here is live against `main` — `[Unreleased]` was empty when the report
came in, so nothing had been fixed since the reporter's run (0.8.0).

## Tasks

### 1. `pull` must safety-commit *before* it overwrites

[`lib/pull.mts:176`](../../lib/pull.mts) commits **after** the write loop. So an
uncommitted local `.js` edit is destroyed and never enters git — and the warning
printed on that very path ([`pull.mts:135`](../../lib/pull.mts)) plus
[`docs/cli/pull.md:49`](../../docs/cli/pull.md) both tell the user to "recover via
git". **That advice is false on the one path that prints it.**

Both other callers already do it right and say why: `watch` commits first and
*skips* the pull if the snapshot failed
([`lib/watch.mts:49-57`](../../lib/watch.mts)), and the live mirror commits first
([`lib/mirror.mts:106-109`](../../lib/mirror.mts)). The user-facing verb is the
odd one out.

Fix: `commitWorkflowDir(dir, "decanter: snapshot before pull (<id>)", log)` ahead
of the write loop (`n8n-decanter.mts:596`). Minimum acceptable alternative: only
say "recover via git" when a pre-pull snapshot actually succeeded.

### 2. `pull`'s clobber warning skips the case that needs it most

The warning is gated on `nodeState.lastPushedHash !== undefined`
([`lib/pull.mts:134`](../../lib/pull.mts)) — borrowed from push's "an undefined
baseline never drifts" relaxation ([`lib/push.mts:41-43`](../../lib/push.mts)). On
the read side that is backwards: no baseline means the node isn't in
`.decanter.json` yet, so `nodeState` is `{}` ([`pull.mts:95`](../../lib/pull.mts))
and the local file is precisely the thing with no protection.

Concrete loss path, and it matches the scaffolded agent workflow: an agent adds a
Code node over the guard (the guard blocks `jsCode`, so the remote body is
empty), writes the source into `code/<kebab-name>.js`, and the debounced
background mirror pull fires before the first push — no state entry, no warning,
`writeIfChanged` replaces the fresh file with the empty remote body.

Fix: drop the `lastPushedHash !== undefined` conjunct. A tracked file that exists
on disk and differs from the remote body warrants a warning regardless of
baseline.

### 3. The live mirror ignores a failed safety commit

[`lib/mirror.mts:109`](../../lib/mirror.mts) awaits `commitWorkflowDir` but
discards the result and pulls unconditionally. `commitWorkflowDir` returns
`"failed"` (a warning, never a throw) for any git error — unset user identity,
mid-merge, `index.lock`, a rejecting hook — so the documented rail
([`docs/cli/mcp-connect.md:53`](../../docs/cli/mcp-connect.md), "a dirty tree is
safety-committed before the pull") silently degrades to an unrecoverable
overwrite.

Fix: capture the `CommitResult` and skip `pullWorkflow` with a warning when it is
`"failed"`, mirroring [`lib/watch.mts:52-57`](../../lib/watch.mts).

### 4. Scenario reachability is branch-blind

`reachableInCapture` asks only whether the *source* node emitted items, via
`firstRunItems(runData[source])` — and `firstRunItems` always reads
`runs[0].data.main[0]`, the source's **first** output, regardless of which output
the edge leaves from ([`lib/simulate.mts:288-289`](../../lib/simulate.mts),
[`:156`](../../lib/simulate.mts)). `forEachConnectionTarget`
([`lib/util.mts:62`](../../lib/util.mts)) has the group index in scope and never
passes it to the callback.

Two consequences, both reproduced: a node on an IF's false branch that the
capture never took is judged reachable and written into `_decanterScenario.fill`
(so the author is told to write data for a branch the capture provably never
reached), and `capturedInputFor` fills `inputSample` from the wrong branch's
items — so the author codes against the wrong upstream shape.

Fix: add `outputIndex` to `forEachConnectionTarget`'s callback signature, then
have `reachableInCapture` and `capturedInputFor` read
`runs[0].data.main[outputIndex]`. Small and local; fixes both symptoms.

**Done (2026-08-04).** Exactly that: the group index — which was in scope in
`forEachConnectionTarget` all along — is passed to the callback, `firstRunItems`
takes an output index (default 0, so every other caller is unchanged), and both
consumers read the branch they are actually looking at. Three unit cases in
[`test/unit/simulate.test.mts`](../../test/unit/simulate.test.mts); the two that
assert the new behaviour were confirmed to **fail** against the old code.
Pulled forward out of turn because [Plan 65](../draft/65-three-gate-scenario-mismatch.md)
depends on it — `fill` stays wrong regardless of which gate wins until this
lands.

### 5. `node run` silently ignores the branch index

[`n8n-globals.d.ts:32`](../../n8n-globals.d.ts) — the type surface decanter ships
into every sync dir — declares `all(branchIndex?, runIndex?)`.
[`lib/run.mts:102`](../../lib/run.mts) implements `all: () => list`, taking no
arguments, and [`:183`](../../lib/run.mts) names `$items`' second parameter
`_outputIndex` and drops it. Verified: with a node pinned to `[{json:{ok:1}}]`,
`all()`, `all(1)` and `$items("Fetch", 1)` all return the same output-0 items.

**This returns wrong data, not empty data** — strictly worse than the pin
truncation in [Plan 66](../draft/66-multi-output-pins.md). And
[`docs/cli/node-run.md:31`](../../docs/cli/node-run.md) lists `$('Node')` /
`$node` / `$items()` as ✅ Covered, i.e. it claims full fidelity for a call that
is silently wrong.

Fix (this plan): make `all(n)` / `$items(name, n)` with `n > 0` **throw a
signpost error** — the pattern `lib/run.mts` already uses for `$vars` /
`$evaluateExpression` — and demote the docs row to 🟡 Partial. Teaching the
fixture format a per-output shape is [Plan 66](../draft/66-multi-output-pins.md)'s
job, not this one's.

### 6. A data-tables 403 gives no hint what's missing

[`lib/api.mts:132`](../../lib/api.mts) throws one generic message for every
non-OK status, and only `listDataTables` is wrapped (for 404 only) at
[`lib/datatables.mts:83`](../../lib/datatables.mts) — `getDataTableColumns` and
`getDataTableRows` are unwrapped, so a 403 from an under-scoped key propagates
verbatim. The codebase already has the remediation pattern this path skips
([`lib/mcp.mts:583`](../../lib/mcp.mts) maps 401/404 to actionable prose;
[`lib/preflight.mts:95`](../../lib/preflight.mts) has a dedicated `unlock` field).

The scope names need no research — they are pinned in four places already,
including [`template/.env.example:18`](../../template/.env.example) and
[`test/smoke-n8n.mts:225`](../../test/smoke-n8n.mts), and Plan 25 recorded the
live-verified fact that column and row reads have *distinct* scopes that don't
fold into `dataTable:read` (exactly the trap that 403s `/columns` after a
successful list).

Fix: map 403 in `#request` to a per-endpoint scope hint. Doing it there rather
than in `fetchDataTables` fixes the same blind spot for `executions` and `backup`
for free, since `pathname` already identifies the refused surface. Include the
read-only fact in the hint — that's where the reporter was standing when they
needed it.

### 7. `scenario create` writes an unbounded file with no size signal

`writeScenario` prints a path line, an optional coverage line, a gaps warning and
a PII warning ([`lib/simulate.mts:652-654`](../../lib/simulate.mts)) — nothing
measures the bytes. The reporter's scenario was 33 MB, and because
`commitWorkflowDir` stages `git add -A -- .` scoped to the workflow folder, the
next `pull` or `push` sweeps it into git history unasked.

The precedent is decanter's own: [`lib/compile.mts:239`](../../lib/compile.mts)
already warns above a ~100 KB compiled-bundle threshold. Scenarios are orders of
magnitude bigger and land in the same history.

Fix: compute `Buffer.byteLength` before the write, append `(N KB)` to the success
line, and warn above a threshold (~1 MB) that the file is about to be committed.
Also note in [`docs/cli/scenario.md`](../../docs/cli/scenario.md) that the
folder-scoped auto-commit will pick it up. Trimming itself is
[Plan 67](../draft/67-scenario-trim.md).

### 8. Two scenario messages point at the wrong place

- `readScenarioMeta` accepts the legacy `_decanterMock` key, but the incomplete
  message hardcodes `_decanterScenario.fill`
  ([`lib/simulate.mts:263`](../../lib/simulate.mts)) — for a pre-rename file it
  names a key that literally isn't in the file. Fix: capture which marker matched
  and interpolate it.
- The replay gap error ([`lib/simulate.mts:476`](../../lib/simulate.mts)) derives
  its node list from the **workflow graph** and then tells the reader to "see the
  `_decanterScenario` block" — a block those nodes are by definition not in.
  **This is the message the field report mistook for the other one**, and the
  confusion is decanter's own wording. Fix: stop pointing at `_decanterScenario`
  for graph-derived gaps; say the nodes are *not* in `fill` and name the path to
  add runData under.
- While in there: `firstRunItems` returns `undefined` for a present-but-empty
  `"Node": []`, so an author who deliberately wrote "emits nothing" is told they
  didn't fill it. Distinguish "no entry" from "empty entry" in the message. (The
  *semantics* — whether `[]` should count as filled — is
  [Plan 65](../draft/65-three-gate-scenario-mismatch.md)'s call, not this one's.)

## Acceptance / verification

- Unit tests for each: pull's pre-commit ordering and the un-gated warning
  (`test/unit/`), the output-index-aware reachability, `all(1)` throwing, the 403
  mapping, the size warning threshold, and both message strings.
- An e2e step for task 1 + 2: edit a `.js` without pushing, pull, assert the
  warning fired **and** `git log` holds the pre-pull content.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Notes

- CHANGELOG: tasks 1, 2, 3, 5, 6, 7, 8 are user-facing (Fixed; task 7 Added).
  Task 4 is user-facing too — it changes which nodes `scenario create` scaffolds.
- Docs: `docs/cli/node-run.md` fidelity row (task 5),
  `docs/cli/scenario.md` size note (task 7), `docs/cli/pull.md`'s "recover via
  git" becomes unconditionally true once task 1 lands.
- Task 5's signpost error and Task 4's index plumbing are the two places
  [Plan 66](../draft/66-multi-output-pins.md) will build on — do them here, but
  don't pull 66's scope in.
- No `PLAN.md` change: none of these alter the data model or a documented flow.
