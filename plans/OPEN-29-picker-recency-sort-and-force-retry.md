# Plan 29 — Picker polish + brand-orange CLI logo

**Priority:** P2 (three small, well-scoped CLI polish wins; touches the picker,
`state.mts`, `style.mts`/`init.mts`, one typed error, tests, docs — no
data-model change)
**Status:** Not started
**Theme:** Three CLI improvements: (1) the interactive picker lists pulled
workflows **newest-synced first**; (2) a picker-run verb that fails on a
**forceable** (drift) error offers a special **retry-with-`--force`** confirm
(default **No**) instead of only printing the error; and (3) the CLI banner logo
renders the **website's brand orange**, not ANSI red.
**Model:** Sonnet (well-specified; the design-sensitive spots are the
`ForceableError` type, the TTY confirm test, and the truecolor/fallback logo
color).

> **Post-Plan-32 review (2026-07-22):** all three features survive the MCP
> pivot; verified against the post-pivot code: `writeState` still rewrites
> `.decanter.json` unconditionally on every pull/push (the mtime recency
> signal holds — a no-op sync stays byte-identical, so no git churn), and the
> per-node drift guard is still the only forceable gate
> (`assertNoDrift`/`codeDrift` in `lib/push.mts` — throw the typed error
> there). **New since the pivot:** the picker has a *third* state —
> MCP-unavailable remotes (red `⊘`, sorted last, Plan 32 Task 8).
> `sortByRecency` applies to the **local** list before `mergeRemote`, which
> already appends available-then-unavailable remotes, so the three-group
> order (pulled → available remote → unavailable remote) is preserved for
> free — keep it that way; unavailable entries carry no `syncedAt`. The
> unavailable-selection guidance path (`ENABLE_MCP_VERB`) is not an error and
> must never trigger the force-retry prompt. Inline line refs predate the
> Plan 32 rewrite — re-resolve at execution time.

> **Post-#107/#115 review (2026-07-23):** still valid; three touch-ups.
> (1) **#115 gave `pickOneWorkflow` a real `mergeRemote` call** — for `pull`
> only (it fetches `searchWorkflows` and merges; other ref verbs stay
> local-only; offline degrades to local). So Feature 1's "sort the local list
> before `mergeRemote` in **both** builders" now maps onto **three** merge
> sites: `pickerLoop`'s builder, `pickOneWorkflow`'s pull branch, and — the
> one easy to miss — `runPicker`'s own async-arrival merge (the first
> `pickerLoop` round has no `remoteCache` yet, so remotes merge *inside*
> `runPicker`). Sorting the `local` array in the builders still covers all
> three (the in-picker merge appends fresh remotes after the already-sorted
> entries) — just don't try to sort inside `runPicker`.
> (2) **Draft-first prompt copy:** since Plan 32 a forced push overwrites the
> **draft** only, and the drift error the prompt follows says "…or repeat with
> `--force` to overwrite the draft" — so Feature 2's confirm copy and its TTY
> test must say **draft**, not "remote changes", and assert against the mock's
> *draft* state (the published version is untouched).
> (3) **`push` is the only prompt-triggering verb:** `watch`'s inner
> `pushSingleNode` calls are wrapped in watch's own log-and-continue catch and
> never reach the picker loop, and `pull`/`status`/`check`/`executions`/
> `simulate` hit no drift gate — so the `ForceableError` branch and its test
> only ever exercise `push`. **(Assuming Plan 36 merged, #117):** `preflight`
> joins the picker menu (`status/pull/push/watch/check/preflight/executions/simulate`
> — now 8 verbs), but it is **read-only/never-mutates**, so it is *not*
> drift-capable and never triggers the force-retry prompt either — `push`
> stays the sole `ForceableError` source. `sortByRecency` still applies to the
> **local** list only, unaffected by the added verb.

## Why

The interactive picker ([lib/picker.mts](../lib/picker.mts), Plan 19/23) lists
pulled workflows in `listWorkflowRefs` order — folder order (alphabetical), which
ignores what the user has actually been working on. When a picker-run verb fails
on the drift guard, the loop only logs the error and drops back to the menu, so
the user has to leave the picker and re-run `push --force` by hand — even though
the CLI already tells them `--force` would fix it.

And the terminal banner colors the "n8n" mark ANSI **red**
([init.mts:56](../lib/init.mts#L56)) while the **website** colors the exact same
block wordmark **orange** (`--color-accent-500`, [Header.astro:8](../website/src/components/Header.astro#L8)) —
so the CLI and the site disagree on the brand color.

All three are ordinary CLI polish, not decanter differentiators, so this stays in
the normal backlog — **not** the distinctive-features group.

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
   (`pickerLoop`, `pickOneWorkflow`) map `ref.syncedAt` onto each `PickerEntry`
   and `sortByRecency` the **local** list *before* it is handed off. Post-#115
   there are three merge points; sorting the `local` array covers all of them:
   `pickerLoop`'s builder-level `mergeRemote`; `pickOneWorkflow`'s **pull-only**
   `mergeRemote` branch (and its offline-degradation catch, which keeps the
   sorted local list); and `runPicker`'s internal async-arrival `mergeRemote`
   (which appends fresh remotes *after* the already-sorted entries). Because
   `mergeRemote` appends unpulled remotes after locals, the result is: pulled
   newest-first, then unpulled available, then unavailable — exactly what we
   want. **Do not sort inside `runPicker`.**

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
   `retry with --force and overwrite the remote draft? [y/N]`. On **yes**
   (`y`/`yes`, case-insensitive), re-dispatch the *same* verb with
   `{ ...PICKER_FLAGS, force: true }`. On **no / bare Enter / anything else**,
   behave exactly as today (back to the menu). Non-forceable errors keep today's
   log-and-return path. **Copy says "draft", not "remote changes"** — since
   Plan 32 a forced push overwrites the *draft* only (the published version is
   untouched), and this prompt directly follows the drift error line
   ("…repeat with `--force` to overwrite the draft"), so the wording must match.
   In practice `push` is the only `ForceableError` source that reaches this
   catch (watch's inner pushes self-handle; the other picker verbs hit no drift
   gate).

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

## Feature 3 — Brand-orange CLI logo (match the website)

### The mismatch

The banner wordmark is shared by design — the website renders the CLI's
block-minifont ([Header.astro comment](../website/src/components/Header.astro#L4-L8)).
But the two color it differently:

- CLI: `style.red(row.slice(0, 6))` — ANSI **red** ([init.mts:56](../lib/init.mts#L56)).
- Website: the `n8n` glyphs fill `var(--color-accent-500)` = **`oklch(0.7 0.15 60)`**
  ([theme.css:16](../website/src/styles/theme.css#L16)), an **orange** ≈
  `rgb(225, 132, 40)` / **`#E18428`**.

`style.red` (and every other `styleText` named color) has no orange, so matching
the site needs a **24-bit truecolor** SGR — `styleText` can't emit that.

### Implementation

1. **[lib/style.mts](../lib/style.mts)** — add `brand(text)` to `Style`. It emits
   the website orange as a truecolor escape `\x1b[38;2;225;132;40m…\x1b[39m`, but
   **only** with the same gating `styleText` applies today: skip color when the
   stream isn't a TTY or `NO_COLOR` is set, and honor `FORCE_COLOR`. Reuse the
   stream's own capability check (`stream.hasColors(2**24)` / `getColorDepth()`,
   which `styleText` uses internally) so gating stays identical.
   **Graceful degradation:** truecolor terminal → exact `#E18428`; 256-color
   (`hasColors(256)`) → nearest xterm-256 orange (`\x1b[38;5;208m`); ≤16-color →
   fall back to today's `style.red`, so legacy terminals don't regress.
2. **[lib/init.mts:56](../lib/init.mts#L56)** — swap `style.red(...)` for
   `style.brand(...)` in the logo loop. **Leave the other reds alone** — the diff
   `-` lines ([status.mts:85](../lib/status.mts#L85)) and the error prefix
   ([n8n-decanter.mts:41](../n8n-decanter.mts#L41)) are semantic red, not brand.
3. **Single source of truth for the value** — define the RGB (and the derivation
   from `oklch(0.7 0.15 60)` / `--color-accent-500`) once, in a commented constant
   in `style.mts`, so a future accent re-tune has an obvious spot to update on both
   sides.

### Scope / notes

- Cosmetic/branding only — no command-surface change, so **no `docs/cli` edit**.
  A CHANGELOG **Changed** line ("CLI logo now uses the brand orange, matching the
  website") is enough.
- The exact orange is derived from the site's accent-500; if the terminal can't do
  truecolor it degrades but stays warm (256-color orange, then red).

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
6. `lib/style.mts` — `brand()` (truecolor `#E18428`, 256/16-color fallbacks,
   `styleText`-parity gating) + commented RGB constant; the logo loop in
   `lib/init.mts` uses it. **Pick and document one canonical value:**
   `oklch(0.7 0.15 60)` (the site's `--color-accent-500`, still in
   `website/src/styles/theme.css`) converts to ≈ `#E18528` / `rgb(225,133,40)`,
   one green-channel step off the plan's `#E18428` — within rounding, but the
   `style.mts` constant should carry a single derived value with the oklch
   source in the comment.
7. **Tests**
   - Unit ([test/unit](../test/unit/)): `sortByRecency` ordering (newest-first,
     no-`syncedAt` last, name tie-break); `ForceableError` is thrown by
     `assertNoDrift` when `!force` and detected by an `instanceof` check.
   - Interactive ([test/interactive.mts](../test/interactive.mts), injected
     streams): pick order reflects `syncedAt`.
   - TTY confirm (`/verify` recipe with **`expect`** — piped `script -q /dev/null`
     doesn't work per AGENTS.md): drive `pull`, edit code, then **drift the
     mock's in-memory draft driver-side** between `expect` sends (coordinated
     via marker files per AGENTS.md — there is no `/__remote` control endpoint;
     the e2e suite mutates its in-process mock's workflow object directly, and
     the `/verify` mock is now the MCP JSON-RPC/SSE surface), open picker →
     `push` fails drift → answer `y` → assert the force push overwrites the
     **draft** (published untouched); a second run answering **Enter** → no
     force, back to menu.
   - `brand()`: `FORCE_COLOR` → emits the truecolor SGR; `NO_COLOR` / non-TTY →
     plain text; assert the banner logo uses `brand`, not `red`.
8. **Docs (all surfaces, per AGENTS.md)**
   - `README.md` — the README was slimmed to a 186-line shop window (Plan 38),
     so these two polish behaviors may not clear its curation bar. Prefer a
     **one-line tweak** to the existing bare-picker line (or no README change),
     not a new feature bullet; there are three picker touchpoints already
     (demo-GIF caption, the "bare `n8n-decanter` opens a picker" line, and the
     "`list --remote` and the picker show what's still missing" line). *(Logo
     color is cosmetic — no README/docs surface change.)*
   - `docs/cli/overview.md` — **both** picker paragraphs (the bare-picker
     *Interactive picker* section **and** the #115-added "No-ref → picker"
     paragraph documenting `pull`'s remote-merged single-select): note
     newest-synced-first ordering and the drift force-retry confirm. Add a
     matching one-line note to `docs/cli/pull.md`'s no-ref picker paragraph.
   - `CHANGELOG.md` `[Unreleased]` — **Changed** (picker orders pulled workflows
     newest-synced first; CLI logo now uses the brand orange, matching the
     website) + **Added** (picker offers a force-retry confirm on a drift
     failure).
   - `PLAN.md` — record the picker force-retry flow and the recency-ordering
     **decision** (mtime as the signal, and *why not* a stored timestamp).

## Acceptance / verification

- `sortByRecency` unit test green; picker shows the most-recently pulled/pushed
  workflow at the top (interactive test).
- From the picker, a `push` that drifts prompts `[y/N]`; `y` overwrites the
  draft, Enter returns to the menu; a **compliance** failure never prompts.
- The banner's "n8n" mark renders orange on a truecolor terminal (matching the
  website), degrades to a 256-color orange / red on lesser terminals, and stays
  plain under `NO_COLOR` / when piped.
- `npm test` + `npm run typecheck` green.

## Notes

- **No data-model change** — deliberately (mtime, not a stored timestamp; see the
  decision above). PLAN.md gets the *decision + flow*, not a schema edit.
- **Non-goals:** re-ordering `list`; force-retry on the no-ref single-select path;
  any forceable gate other than push-drift (the type makes adding more trivial
  later).
