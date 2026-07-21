# Plan 29 — Picker: recency sort + force-retry on drift

**Priority:** P2 (two small, well-scoped picker UX wins; touches the picker,
`state.mts`, one typed error, tests, docs — no data-model change)
**Status:** Not started
**Theme:** Two independent interactive-picker improvements: (1) list pulled
workflows **newest-synced first**, and (2) when a picker-run verb fails with a
**forceable** (drift) error, offer a special **retry-with-`--force`** confirm
(default **No**) instead of only printing the error.
**Model:** Sonnet (well-specified; the one design-sensitive spot is the
`ForceableError` type + the TTY confirm test).

## Why

The interactive picker ([lib/picker.mts](../lib/picker.mts), Plan 19/23) lists
pulled workflows in `listWorkflowRefs` order — folder order (alphabetical), which
ignores what the user has actually been working on. When a picker-run verb fails
on the drift guard, the loop only logs the error and drops back to the menu, so
the user has to leave the picker and re-run `push --force` by hand — even though
the CLI already tells them `--force` would fix it.

Both are picker-only ergonomics. Neither is a decanter differentiator (they mirror
ordinary CLI polish), so this stays in the normal backlog — **not** the
distinctive-features group.

---

## Feature 1 — Sort pulled workflows newest-synced first

### Recency signal: `.decanter.json` mtime (no schema change)

Every sync rewrites the state file **unconditionally**:

- full push — [push.mts:111](../lib/push.mts#L111)
- single-node push (watch) — [push.mts:136](../lib/push.mts#L136)
- pull — [pull.mts:157](../lib/pull.mts#L157)

So the mtime of `<slug>/.decanter.json` is a faithful "last pulled/pushed"
proxy, for **free** — no new field, no migration, no PLAN.md data-model change.

**Decision — mtime, not a stored timestamp.** A `lastSyncedAt` field committed in
`.decanter.json` was considered and rejected: today a no-op sync (code unchanged →
identical hashes) leaves the file **byte-identical**, so git shows no diff and the
push/pull auto-commit is a real no-op. A timestamp would change the file on *every*
sync, turning no-op syncs into git churn and spurious auto-commits. mtime keeps the
"nothing changed → nothing to commit" property intact. **Known limitation:** a
fresh `git clone` stamps every state file with the checkout time, so ordering
degrades to the name tie-break until the first local sync — acceptable, since mtime
is a *local-activity* signal, not committed history.

### Implementation

1. **[lib/state.mts](../lib/state.mts)** — add `syncedAt: number` (mtimeMs) to
   `WorkflowRef`; populate it in `listWorkflowRefs` via
   `statSync(path.join(dir, STATE_FILE)).mtimeMs` (the file is known to exist).
   Additive field — `listWorkflowRefs`' own return order stays unchanged, so
   `matchWorkflowRef` / name-resolution are untouched. One extra `statSync` per
   folder (negligible; we already `readFileSync` the state per folder).
2. **[lib/picker.mts](../lib/picker.mts)** — add optional `syncedAt?: number` to
   `PickerEntry`; add a **pure, exported** `sortByRecency(entries)`:
   descending by `syncedAt`, entries without one (remote/unpulled) sort last,
   **name ascending** as the stable tie-break. Keep it pure so it's unit-testable
   like `filterEntries`/`mergeRemote`/`visibleWindow`.
3. **[n8n-decanter.mts](../n8n-decanter.mts)** — in the two picker builders
   (`pickerLoop` [~:279](../n8n-decanter.mts#L279), `pickOneWorkflow`
   [~:312](../n8n-decanter.mts#L312)) map `ref.syncedAt` onto each `PickerEntry`
   and `sortByRecency` the **local** list *before* `mergeRemote`. `mergeRemote`
   appends unpulled remotes after locals ([picker.mts:82](../lib/picker.mts#L82)),
   so the result is: pulled newest-first, then unpulled — exactly what we want.

### Scope

- **Picker only.** The `list` verb ([n8n-decanter.mts:439](../n8n-decanter.mts#L439))
  keeps its current (dir/alpha) order — changing scripted output is a separate,
  out-of-scope call. Note it as an optional follow-up.

---

## Feature 2 — Force-retry confirm on a forceable picker error

### Current behavior

`pickerLoop` runs the chosen verb and on any throw just logs it and loops back
([n8n-decanter.mts:289-296](../n8n-decanter.mts#L289-L296)).

### Design — a typed `ForceableError`, prompted only when honest

Push runs **two** gates: the compliance guard (hard error, `--force` does **not**
bypass — [push.mts:22-27](../lib/push.mts#L22-L27)) and the drift guard (the
*only* one `--force` bypasses — [push.mts:65-72](../lib/push.mts#L65-L72)). So the
force offer must fire **only** for the drift error — offering it for a compliance
failure would be a lie (`--force` can't fix it). Message-string sniffing is
brittle; use a **typed error** instead:

1. Add a small `ForceableError extends Error` (new `lib/errors.mts`, or beside the
   guards). `assertNoDrift` throws it (in place of the plain `Error` at
   [push.mts:69](../lib/push.mts#L69)) when `!force`. Nothing else changes — any
   future forceable gate can reuse it, and only errors marked forceable ever
   trigger the prompt.
2. **[n8n-decanter.mts](../n8n-decanter.mts) `pickerLoop` catch** — if
   `err instanceof ForceableError`, the error line is already logged; then ask a
   **special y/N confirm, default No**, e.g.:
   `retry with --force and overwrite remote changes? [y/N]`. On **yes**
   (`y`/`yes`, case-insensitive), re-dispatch the *same* verb with
   `{ ...PICKER_FLAGS, force: true }`. On **no / bare Enter / anything else**,
   behave exactly as today (back to the menu). Non-forceable errors keep today's
   log-and-return path.

### Prompt mechanics

- Reuse `createPrompt()` ([lib/prompt.mts](../lib/prompt.mts)) — already
  piped-stdin-safe. It runs **after** `runPicker` has restored the terminal (raw
  mode off, stdin paused in its `finally` — [picker.mts:294-302](../lib/picker.mts#L294-L302)),
  so a readline prompt is safe. **`close()` it before the next loop iteration**
  so `runPicker` cleanly re-attaches raw-mode/keypress on the next round.
- Rejected alternative: a raw single-key y/n *inside* `runPicker` — more coupling;
  the force decision belongs in the loop, where the verb's failure is known.

### Scope

- The interactive `pickerLoop` session only. `pickOneWorkflow` (no-ref
  single-select) merely resolves an id; its verb then runs on the **normal**
  non-interactive path, which already prints the `repeat with --force` hint — out
  of scope here.

---

## Tasks

1. `lib/state.mts` — `WorkflowRef.syncedAt` + `statSync` in `listWorkflowRefs`.
2. `lib/picker.mts` — `PickerEntry.syncedAt?`, pure exported `sortByRecency`.
3. `n8n-decanter.mts` — map `syncedAt`, `sortByRecency` locals before `mergeRemote`
   in both builders.
4. `lib/errors.mts` (new) — `ForceableError`; throw it from `assertNoDrift`
   (`lib/push.mts`).
5. `n8n-decanter.mts` `pickerLoop` — forceable-error branch: special y/N confirm
   (default No) → re-dispatch with `force: true`.
6. **Tests**
   - Unit ([test/unit](../test/unit/)): `sortByRecency` ordering (newest-first,
     no-`syncedAt` last, name tie-break); `ForceableError` is thrown by
     `assertNoDrift` when `!force` and detected by an `instanceof` check.
   - Interactive ([test/interactive.mts](../test/interactive.mts), injected
     streams): pick order reflects `syncedAt`.
   - TTY confirm (`/verify` recipe with **`expect`** — piped `script -q /dev/null`
     doesn't work per AGENTS.md): drive `pull`, edit code, drift the mock via
     `PUT /__remote`, open picker → `push` fails drift → answer `y` → assert the
     force push overwrites remote; a second run answering **Enter** → no force,
     back to menu.
7. **Docs (all surfaces, per AGENTS.md)**
   - `README.md` — feature bullet for the two picker behaviors (recency order +
     force-retry).
   - `docs/cli/overview.md` — the *Interactive picker* section
     ([:57](../docs/cli/overview.md#L57)): note newest-synced-first ordering and
     the drift force-retry confirm.
   - `CHANGELOG.md` `[Unreleased]` — **Changed** (picker orders pulled workflows
     newest-synced first) + **Added** (picker offers a force-retry confirm on a
     drift failure).
   - `PLAN.md` — record the picker force-retry flow and the recency-ordering
     **decision** (mtime as the signal, and *why not* a stored timestamp).

## Acceptance / verification

- `sortByRecency` unit test green; picker shows the most-recently pulled/pushed
  workflow at the top (interactive test).
- From the picker, a `push` that drifts prompts `[y/N]`; `y` overwrites remote,
  Enter returns to the menu; a **compliance** failure never prompts.
- `npm test` + `npm run typecheck` green.

## Notes

- **No data-model change** — deliberately (mtime, not a stored timestamp; see the
  decision above). PLAN.md gets the *decision + flow*, not a schema edit.
- **Non-goals:** re-ordering `list`; force-retry on the no-ref single-select path;
  any forceable gate other than push-drift (the type makes adding more trivial
  later).
