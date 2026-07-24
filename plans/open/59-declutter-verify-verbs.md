# Plan 59 — Declutter the verify verbs: `check`/`status` → `preflight` + `diff`

**Status:** Not started
**Priority:** P2
**Class:** Distinctive feature — the verb surface *is* the product's ergonomics; a tool an agent (or human) can't navigate loses to raw n8n MCP.
**Source:** Maintainer session 2026-07-24, continuing the [Plan 58](58-preflight-first-verb-surface.md) thread. Graduates Plan 58's [Deferred](58-preflight-first-verb-surface.md#deferred) section. Relates to [Plan 57](../draft/57-cli-discoverability-for-agents.md) (agent discovery) — orthogonal but same north star: a legible surface.
**Snapshot:** 2026-07-24T14:38Z @ 9f3a78a
**Theme:** Five verbs feel like "check my thing." Collapse the confusing overlap: remove `check` and `status`, route their jobs to `preflight` (the gate) and a new `diff` (the lines).

## Why

The verify cluster is where the surface reads as messy — and where today's
`test`-vs-`preflight` confusion lived. Five verbs, overlapping jobs:

| verb | job | overlaps |
| --- | --- | --- |
| `check` | static gate (layout + types), offline | ⊂ `preflight --quick` exactly |
| `status` | drift summary + CI exit codes | ⊂ `preflight`'s sync tier |
| `status --diff` | the actual line diff | **unique — nothing else shows it** |
| `simulate` | local-engine replay | a `preflight --full` stage, but has unique flags |
| `test` | instance run | a verb (Plan 58 moved it *out* of preflight) |
| `preflight` | the scored gate | superset of `check` + `status`-summary |

`check` and `status`-summary are **strict subsets** of `preflight`. Three verbs
that all answer "am I OK?" is the overlap that makes the surface feel cluttered.
The one genuinely unique thing in the cluster — the **line diff** — is buried as
a flag on the verb we want to delete.

**The maintainer's decision (2026-07-24):** declutter the *verify cluster only*
(not a full-surface rename). The end state:

- **`preflight`** — the gate. Absorbs `check` (it already *is* `--quick`, static
  since Plan 58) and `status`'s summary/exit-code role (its sync tier already
  computes `parity`/`drift`/`snapshot`/`lifecycle`).
- **`diff`** — new verb. The line-diff inspection view, promoted out of
  `status --diff`. **`diff`, not `drift`:** it shows local-ahead edits too, not
  only remote drift, so `drift` (a specific direction, and a preflight check id)
  would misname it. Matches the `git status` / `git diff` split.
- **`test`** — unchanged (Plan 58). The post-push instance run.
- **`simulate`** — **kept as a specialist verb.** It is *not* part of the
  confusing overlap: "run it locally" is unambiguous. It carries flags
  `preflight --full` forces off (`--viewer`, `--network-none` toggle,
  engine-version rehearsal of *uncommitted* local code). De-emphasized in help,
  not removed.

Headline flow, unchanged from Plan 58 and now with nothing redundant beside it:

```
preflight → push → test → publish        (diff / simulate: when you need them)
```

## Prerequisites — do these first, they gate the removals

1. **Latency budget for `check`'s replacement.** `check` is spawned by the
   scaffolded PostToolUse hook
   ([`template/.claude/hooks/verify.mjs.example`](../../template/.claude/hooks/verify.mjs.example))
   on **every file edit** — a tight budget a pre-push gate doesn't have. Measure
   `preflight --quick` vs `check` on a representative sync dir. If materially
   slower, fast-path `--quick` (it's static-only since Plan 58 — it should be
   able to skip all git/state/config-for-sync work) or give the hook a narrower
   entry point. **Record the numbers in the PR.** If it can't be made fast
   enough, stop and reopen whether `check` should stay as a thin alias.

2. **`diff` must reach parity with `status --diff` before `status` dies.**
   Including the `.ts`-compile-then-compare behaviour (bundling `shared/*.ts`,
   so a helper edit shows every importing node). Reuses
   [`lib/diff.mts`](../../lib/diff.mts) and the existing `status --diff` path.

## Tasks

### 1. Add the `diff` verb
- New verb wrapping the current `status --diff` rendering: per-node line diffs
  for every drifted node (local-ahead, remote, conflict), `.ts` nodes compiled
  first. Reuses [`lib/status.mts`](../../lib/status.mts)'s `computeSyncFacts` +
  `lib/diff.mts` — extract the diff renderer if it's currently entangled with
  the summary print.
- Exit code: **decide and document.** Recommend mirroring `git diff` — `0`
  always, it's an inspection view, not a gate (the gate is `preflight`). This is
  a behaviour change from `status`'s CI exit codes, so CI migrates to
  `preflight`, and the changelog says so.
- Register in `VERBS` + `REF_VERBS`, add a `case`, a usage line, completions.

### 2. Remove `check`
- Drop from `VERBS`/`REF_VERBS`, its `case`, its usage line; add to
  `RETIRED_CHECK_IDS`-style removed-verb handling so `n8n-decanter check` exits
  non-zero naming `preflight --quick` (it was a documented verb in 0.7.0 — a
  hint, not a bare "unknown verb").
- **`lib/validate.mts` stays untouched** — `push`/`watch` call the compliance
  guard directly. Removing the verb removes a *view*, never a *gate*.
- **Template migration** (ships into every scaffold; breaks the moment the verb
  is gone):
  - [`verify.mjs.example`](../../template/.claude/hooks/verify.mjs.example) → `preflight --quick` (after Prereq 1).
  - [`package.json.example`](../../template/package.json.example) scripts.
  - [`settings.json.example`](../../template/.claude/settings.json.example) allowlist.
  - [`CLAUDE.md.example`](../../template/CLAUDE.md.example) / [`AGENTS.md.example`](../../template/AGENTS.md.example) prose.
  - [`decanter-ts-plugin/index.js.example`](../../template/decanter-ts-plugin/index.js.example) comment.

### 3. Remove `status`
- Drop from `VERBS`/`REF_VERBS`, its `case`, its usage line; removed-verb hint
  routes to **`preflight`** (summary/verdict) and **`diff`** (lines).
- Retain in [`lib/status.mts`](../../lib/status.mts) only what `preflight`'s
  sync tier and the new `diff` verb import; delete the standalone renderer.
- Confirm no fact is lost: publish-state line, snapshot-stale hint, and the
  live-lags-draft note all survive as `preflight` findings (`lifecycle`,
  `snapshot`).

### 4. Docs — all surfaces (root `AGENTS.md` rule)
- **`README.md`** — drop `check`/`status` `## Commands` rows, add `diff`;
  feature bullets; the offline/online table.
- **`/docs`** — delete `docs/cli/check.md` + `docs/cli/status.md`, add
  `docs/cli/diff.md`; update `overview.md` (command list, offline/online table,
  the interactive-picker action list which names `status`/`check`).
- **`CHANGELOG.md`** — `[Unreleased]`, **Breaking:** for both removals + the
  `diff` addition + the exit-code change.
- **`PLAN.md`** — the verb-grammar section and the status/preflight description.
- **`scripts/check-docs-surface.mts`** — record `check`/`status` retired, add
  `diff`; `npm run check:docs` must pass.

### 5. Tests
- e2e `check`/`status`/`status --diff` steps → rewritten against `preflight` +
  `diff` (not deleted — the coverage moves).
- Removed-verb steps: `check` and `status` exit non-zero with the routing hint.
- Completions enumerate the new set.

## Acceptance / verification
- `n8n-decanter check` and `n8n-decanter status` exit non-zero, each naming its
  replacement.
- `n8n-decanter diff <wf>` shows the same line diffs `status --diff` did,
  `.ts`-compile behaviour included.
- Prereq-1 latency numbers recorded; the scaffolded edit-hook is no slower in a
  way that matters (or the regression is called out and accepted).
- `npm test`, `typecheck`, `lint`, `check:docs` green.

## Non-goals
- Touching `list` / `executions` / `data-tables` / `scenario` / `backup` /
  `node` / `mcp` — the maintainer scoped this to the verify cluster. Those are
  numerous but not *confusing*; renaming them churns muscle memory for no
  clarity gain.
- Removing `simulate`. It stays a specialist verb (see Why).
- Aliasing `check`/`status` as hidden shims — they're removed, with hints.
  (Revisit only if Prereq 1 fails.)

## Notes
- **Second breaking wave in the same area as Plan 58.** Land 58 first; this
  builds on `--quick` already being static-only. Sequencing them into separate
  releases gives users one migration at a time.
- Net verb count: **−1** (`check`, `status` out; `diff` in), and the *confusing*
  overlap goes to zero. Decluttering here is about removing overlap, not hitting
  a target count.
