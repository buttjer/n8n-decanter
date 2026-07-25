# Plan 59 — Declutter the verify surface: `check`/`status`/`simulate` → `preflight` (flags, no profiles) + `diff`

**Status:** Not started
**Priority:** P2
**Class:** Distinctive feature — the verb surface *is* the product's ergonomics; a tool an agent (or human) can't navigate loses to raw n8n MCP.
**Source:** Maintainer session 2026-07-24/25, continuing the [Plan 58](58-preflight-first-verb-surface.md) thread. Graduates and widens Plan 58's [Deferred](58-preflight-first-verb-surface.md#deferred-now-plan-59) section. Relates to [Plan 57](../draft/57-cli-discoverability-for-agents.md) (agent discovery) and [Plan 26](26-npx-engine-backend.md) (engine backend). Decisions taken in-session via the run-mode + depth-control questions.
**Snapshot:** 2026-07-25T00:00Z @ 9f3a78a
**Theme:** The verify cluster is five verbs that all feel like "check my thing." Bury `check`, `status`, and `simulate` into `preflight`; promote the one unique capability (`status --diff`) to a `diff` verb; replace the profile vocabulary with two plain flags.

## Decisions (settled in-session — not open)

- **Remove `check`, `status`, and `simulate` as verbs.** All three fold into
  `preflight`.
- **The local-engine run becomes `preflight --simulate`** — an opt-in flag, not
  a verb and not a profile. Name **kept as `simulate`** (candidates sandbox /
  playground / rehearse / container were weighed and declined — see
  [Naming note](#naming-note)).
- **No profiles.** Drop `--quick` / `--full` / `--default` and the `Profile`
  enum. Depth is controlled by two orthogonal flags (below).
- **`status --diff` → a `diff` verb.** Named `diff`, not `drift` (it shows
  local-ahead edits too, not only remote drift; and `drift` is already a
  preflight check id). The `git status` / `git diff` split.
- **`test` unchanged** (Plan 58): the post-push instance run.

## The surface after

| Job | Verb | Was |
| --- | --- | --- |
| Gate (am I OK to ship?) | `preflight` | `check` + `status` + `simulate` + `preflight` |
| See the actual changed lines | **`diff`** | `status --diff` |
| Run it for real on the instance | `test` | `test` (unchanged) |

Gone: **`check`**, **`status`**, **`simulate`**. Everything outside the verify
cluster (`init`, `pull`, `push`, `watch`, `publish`, `unpublish`, `list`,
`executions`, `data-tables`, `scenario`, `backup`, `node`, `mcp`) is untouched —
numerous but not confusing.

Headline flow, unchanged: **`preflight → push → test → publish`** (`diff` when
you want to see what changed).

## Depth: two flags replace four profiles

```
preflight                       static + instance reads            (the default gate)
preflight --simulate            + a local-engine run of your code
preflight --offline             static only — no instance contact  (edit-hook, air-gapped CI)
preflight --offline --simulate  static + local engine, no instance (air-gapped runtime check)
```

- **`--simulate`** is *additive*: it appends the local-engine stage (Docker /
  the [Plan 26](26-npx-engine-backend.md) npx backend), `--network-none` always
  forced, credentials stripped, pins from a capture/scenario.
- **`--offline`** is *subtractive*: it drops the instance-reads tier and skips
  `requireHost` (it already joins the dispatcher's offline set).

They compose, and every old profile is reconstructable:

| old profile | new |
| --- | --- |
| default (static+sync) | `preflight` |
| `--quick` (static only, per Plan 58) | `preflight --offline` |
| `--full` (+ engine) | `preflight --simulate` |
| `--offline` (static + engine, no instance) | `preflight --offline --simulate` |

**Supersedes Plan 58's profile model.** Plan 58 (shipped separately) redefined
`--quick` as static-only to resolve a two-identical-profiles problem; this plan
removes `--quick` and the whole `Profile`/`PROFILES`/`profileSpec` machinery. If
58 and 59 land in close releases, **soften or drop 58's "`--quick` is now
static-only" changelog line at release time** — it's a transient state a user
shouldn't have to learn and then unlearn.

## Prerequisites — do first, they gate the removals

1. **Edit-hook latency.** `check` is spawned by the scaffolded PostToolUse hook
   ([`verify.mjs.example`](../../template/.claude/hooks/verify.mjs.example)) on
   **every file edit**. Its replacement is **`preflight --offline`**
   (static-only: layout + types, no network, no Docker). Measure it vs `check`
   on a representative sync dir; both spawn `tsc`, so parity is expected, but
   **prove it and record the numbers in the PR.** If slower, fast-path
   `--offline` (skip all git/state/sync-config work) or give the hook a narrower
   entry point.
2. **`diff` parity with `status --diff`** before `status` dies — including the
   `.ts`-compile-then-compare (bundling `shared/*.ts`, so a helper edit shows
   every importing node). Reuses [`lib/diff.mts`](../../lib/diff.mts) and
   [`lib/status.mts`](../../lib/status.mts)'s `computeSyncFacts`.

## Tasks

### 1. Reshape `preflight` flags ([`lib/preflight.mts`](../../lib/preflight.mts), [`n8n-decanter.mts`](../../n8n-decanter.mts))
- Delete the `Profile` type, `PROFILES`, `profileSpec`, and the
  `--quick`/`--full`/`--default` parsing. Replace `ctx.profile` with two
  booleans: `simulate` (`--simulate`) and `offline` (`--offline`, subtractive).
- Sync tier runs unless `offline`; the `simulate` stage runs iff `simulate`.
- **`--json` contract:** replace `report.profile` with the resolved flags (e.g.
  `{simulate, offline}`). Agents key on this — call it out in the changelog.
- `--require=simulate` still means "fail if the engine run didn't happen";
  `--require=test` stays rejected via `RETIRED_CHECK_IDS`.

### 2. Fold in `simulate`; remove the verb
- Move `simulate`'s doc/help substance into `preflight --simulate`.
- Drop `simulate` from `VERBS`/`REF_VERBS`, its `case`, its usage line; add a
  removed-verb hint → `preflight --simulate`.
- **`--viewer` — open sub-decision.** The standalone `simulate --viewer` (the
  browser pin/data inspector, cf. [Plan 54](../draft/54-persist-pindata-for-browser-test.md))
  fights the one-shot-gate model preflight embodies. **Recommend** preserving it
  as `preflight --simulate --viewer` rather than dropping it; confirm with the
  maintainer before deleting any viewer code. `--network-none` (always-on in
  preflight already) and `--n8n-version` (already a preflight flag) need no new
  home.

### 3. Add the `diff` verb
- New verb wrapping the current `status --diff` renderer: per-node line diffs
  for every drifted node (local-ahead / remote / conflict), `.ts` compiled
  first. Extract the diff renderer from `statusWorkflow` if entangled.
- **Exit code:** mirror `git diff` — **`0` always**, it's an inspection view,
  not a gate (the gate is `preflight`). This drops `status`'s CI exit codes;
  CI migrates to `preflight`. Changelog says so.
- Register in `VERBS`/`REF_VERBS`, `case`, usage line, completions.

### 4. Remove `check` and `status`
- Drop both from `VERBS`/`REF_VERBS`, their `case`s and usage lines; removed-verb
  hints route `check`→`preflight --offline`, `status`→`preflight` (summary) + `diff` (lines).
- **`lib/validate.mts` stays** — `push`/`watch` call the compliance guard
  directly; removing the verb removes a *view*, not a *gate*.
- Retain in `lib/status.mts` only what `preflight`'s sync tier and `diff` import;
  delete the standalone summary renderer. Confirm no fact is lost (publish-state,
  snapshot-stale hint, live-lags-draft note all survive as preflight findings).
- **Template migration** (ships into every scaffold; breaks the instant a verb
  is gone):
  - [`verify.mjs.example`](../../template/.claude/hooks/verify.mjs.example) → `preflight --offline` (after Prereq 1).
  - [`package.json.example`](../../template/package.json.example) scripts (`typecheck`/`check`).
  - [`settings.json.example`](../../template/.claude/settings.json.example) allowlist.
  - [`CLAUDE.md.example`](../../template/CLAUDE.md.example) / [`AGENTS.md.example`](../../template/AGENTS.md.example) prose.
  - [`decanter-ts-plugin/index.js.example`](../../template/decanter-ts-plugin/index.js.example) comment.

### 5. Docs — every surface (root `AGENTS.md` rule)
- **`README.md`** — `## Commands`: drop `check`/`status`/`simulate` rows, add
  `diff`; feature bullets; the offline/online table.
- **`/docs`** — delete `docs/cli/check.md`, `docs/cli/status.md`,
  `docs/cli/simulate.md`; add `docs/cli/diff.md`; rewrite
  [`preflight.md`](../../docs/cli/preflight.md) (the two-flag model, the
  `--simulate` stage, `--offline`); update
  [`overview.md`](../../docs/cli/overview.md) (command list, offline/online
  table, the picker action list that names `status`/`check`).
- **`CHANGELOG.md`** — `[Unreleased]`, **Breaking:** for the three verb removals,
  the `diff` addition, the profile→flags change, the `diff` exit-code change, and
  the `--json` `profile`→flags change.
- **`PLAN.md`** — verb-grammar section + the preflight description (drop profile
  vocabulary; document the two flags).
- **[`scripts/check-docs-surface.mts`](../../scripts/check-docs-surface.mts)** —
  record `check`/`status`/`simulate` retired, add `diff`; `npm run check:docs`
  must pass.

### 6. Tests
- e2e `check` / `status` / `status --diff` / `simulate` steps → rewritten against
  `preflight` (+ its flags) and `diff`. Coverage moves, not deleted.
- Removed-verb steps: `check`/`status`/`simulate` exit non-zero with the routing
  hint.
- Unit: the flag-combo → active-stages mapping (the table above), replacing the
  profile-spec tests.
- Completions enumerate the new set.

## Acceptance / verification
- `n8n-decanter check|status|simulate` each exit non-zero naming their
  replacement.
- `preflight`, `preflight --simulate`, `preflight --offline`,
  `preflight --offline --simulate` run exactly the four stage-sets in the table.
- `n8n-decanter diff <wf>` reproduces `status --diff` output, `.ts`-compile
  included; exits 0.
- Prereq-1 latency numbers recorded.
- `npm test`, `typecheck`, `lint`, `check:docs` green.

## Naming note
`simulate` was kept over sandbox / playground / container / rehearse. Rationale
for the record: **sandbox** is already overloaded in this repo (shell-sandbox +
the `node run` boundary, [Plan 31](31-run-sandbox-boundary.md)); **playground**
implies interactivity this one-shot CI check doesn't have; **container** names
the mechanism and would age wrong against the [Plan 26](26-npx-engine-backend.md)
npx backend; **rehearse/replay** were viable verbs but not worth the churn. If
the name is ever revisited, revisit it once, here.

## Non-goals
- Touching `list`/`executions`/`data-tables`/`scenario`/`backup`/`node`/`mcp`.
- Any auto-escalation (run the engine only "when it would help") — the additive
  `--simulate` flag is explicit on purpose.
- Aliasing removed verbs as hidden shims; they're removed with hints. (Revisit
  only if Prereq 1 fails for `check`.)

## Notes
- **Second (larger) breaking wave in the same area as Plan 58.** Land 58 first
  (it's the safety fix); this builds on it and then removes the profile scaffold
  58 touched. Sequence into separate releases so users migrate once per step —
  and collapse 58's transient `--quick` note per the [supersession point](#depth-two-flags-replace-four-profiles).
- Net: three verbs out, one in (`diff`); the profile vocabulary gone; the
  confusing gate-overlap at zero.
