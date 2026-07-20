# Plan 19 — Interactive workflow picker on bare invocation

| | |
|---|---|
| **Priority** | P2 |
| **Status** | Done |
| **Theme** | `n8n-decanter` with no verb and no ref in an inited project opens a TTY-only type-to-filter picker — pulled workflows green, unpulled remote ones yellow — then a verb menu; discovery moves from the shell into the CLI itself. |

## Why

Today discovery lives in `list` (line-oriented, script-friendly) and
`completion zsh|bash` (requires an rc-file `eval`, invisible until set up, and
only helps users who already know what they want to type). A bare
`n8n-decanter` in an inited project currently just prints usage — the moment a
human is most clearly *exploring* is the moment the CLI helps least. An
interactive picker turns that moment into: see everything (local and remote),
narrow by typing, act.

## Source

- Direct user request (2026-07-19); no Plan 0 entry existed.
- Extends [Plan 11](DONE-11-cli-look-and-feel.md)'s discovery surfaces and the
  PLAN.md "Discovery surfaces" paragraph.

## Design decisions

- **Trigger:** bare `n8n-decanter` (no verb, no refs, no flags) **and**
  `process.stdin.isTTY && process.stdout.isTTY` **and** `loadConfig` finds a
  `decanter.config.json` (`requireCredentials: false`). Every other bare
  invocation — piped, or no config in reach — keeps printing `usage()`
  unchanged. **The e2e suite and LLM harnesses run the CLI piped; their
  behavior must not change by construction.**
- **Stage 1 — workflows:** local entries from `listWorkflowRefs()` render
  instantly, green. `api.listWorkflows()` fires concurrently (when credentials
  exist) and appends unpulled entries: yellow **plus a dim `(not pulled)` text
  suffix** — the marker keeps the "no information via color alone" rule intact
  (`NO_COLOR`, monochrome terminals). Missing credentials or a failed fetch
  degrade to one dim notice line; the local-only picker still works.
- **Search:** type-to-filter — case-insensitive substring over name and id.
  `↑`/`↓` move, `Enter` selects, `Esc`/`Ctrl-C` quit clean. No fuzzy matching.
- **Stage 2 — verbs:** pulled workflow → menu `status / pull / push / watch /
  check` (`↑↓` + `Enter`, or first letter); `Esc` returns to stage 1.
  **Unpulled workflow → `Enter` runs `pull` directly** — no one-item menu; the
  footer hint says so while an unpulled entry is highlighted.
- **Execution:** the picker only produces `{verb, id}` and re-enters the
  normal dispatcher path — identical behavior to typing the command, including
  credential errors, typecheck-on-push, and exit codes.
- **`completion` stays — decided 2026-07-19.** It serves a different moment
  (mid-command tab completion for users who know what they're typing), costs
  ~40 lines, and removal would be **Breaking:** for anyone with the `eval` in
  their rc file. The DECISIONS-NEEDED entry is resolved: keep, presented
  below the picker in README/usage.
- **No new dependencies:** raw mode via `readline.emitKeypressEvents` +
  `stdin.setRawMode(true)`; colors through the existing `lib/style.mts`;
  repaint via cursor-up + clear-line ANSI. Terminal state (raw mode, cursor)
  is restored in `finally` and on SIGINT — a wedged terminal is a hard bug.

## Tasks

1. **`lib/picker.mts`** — pure core + thin IO, unit-testable:
   - pure: entry model `{id, name, pulled}`, `filterEntries(entries, query)`,
     and a key reducer `(state, key) → state/action` covering both stages;
   - IO: raw-mode keypress loop, windowed render (~10 visible rows, scrolls),
     dim footer (`type to filter · ↑↓ move · enter select · esc quit`),
     terminal restore on every exit path.
2. **Dispatcher wiring** (`n8n-decanter.mts`): the current `!command` branch
   gains the TTY+config gate → run picker → continue into the existing verb
   switch with the picked `{verb, id}`; all other paths untouched.
3. **Remote fetch:** concurrent `api.listWorkflows()`, entries appended on
   arrival; on error a dim one-line notice (same truncated-message style as
   `resolveRef`'s warn).
4. **Docs:** README discovery section leads with the picker; `usage()` gets a
   bare-invocation line; **PLAN.md "Discovery surfaces" paragraph updated in
   the same PR**; CHANGELOG `Added` entry.
5. **Tests:** `test/unit/picker.test.mts` for filter + reducer; an e2e
   assertion that piped bare invocation still prints usage (add if absent);
   manual TTY checklist under Acceptance.
6. ~~*(decision-gated)*~~ Decided 2026-07-19: `completion` kept (see Design
   decisions); DECISIONS-NEEDED entry resolved and removed.

## Acceptance / verification

- In an inited dir on a real terminal: bare `n8n-decanter` shows pulled
  workflows green first, unpulled yellow `(not pulled)` once the fetch lands;
  typing filters live; `Enter` on a pulled workflow opens the verb menu and
  the chosen verb behaves identically to typing it; `Enter` on an unpulled
  workflow pulls it.
- `Esc`/`Ctrl-C` at every stage exits (0 / 130) with raw mode off and the
  cursor visible — terminal not wedged.
- `n8n-decanter | cat` and bare invocation without a config print today's
  usage text unchanged; `npm test` stays green (the piped e2e suite must
  never see the picker).
- A `NO_COLOR=1` run stays fully legible — `(not pulled)` carries the
  pulled/unpulled distinction without color.
- `package.json` dependencies unchanged.

## Non-goals

- Fuzzy matching, multi-select, or looping back into the picker after the
  verb finishes (run once, exit).
- Replacing `list` — it stays the script/agent-friendly surface.
- Automated pty-driven UI tests — manual TTY verification, same precedent as
  [Plan 12](DONE-12-structural-watch.md)'s interactive conflict prompt.

## Notes

- CHANGELOG: `Added` — interactive picker; plus `Changed`/`Removed` depending
  on the `completion` decision.
- The picker hands resolved ids to the dispatcher, so the tiered ref
  resolution (exact id → exact name → unique prefix) is untouched.
- The style layer's one rule (escapes only on a TTY) is unaffected — the
  picker exists only on a TTY by construction.
- **Verification record (2026-07-20):** 17 unit tests on the pure state
  machine; full `npm test` green including the new piped bare-invocation e2e
  step; pty-scripted drive via `script -q` (Plan 12 precedent) confirmed:
  live filter typing, verb menu, `❯ status <id>` dispatch through the real
  dispatcher (credentials error, exit 1), Esc quit (exit 0), Esc-back from
  the verb stage, `NO_COLOR` run fully legible, raw mode + cursor restored
  (`\x1b[?25h` present), green/bold rendered under `TERM=xterm-256color`.
  A lone Esc registers after ~500 ms — Node's readline escape-decoder
  timeout, standard terminal behavior, not a bug.
- **Pending manual verification:** one human-driven session against a live
  n8n (real keyboard, remote workflows appearing yellow, picking one to
  pull) — same caveat style as Plan 17's pending notes. The yellow/unpulled
  render path is unit-covered (`mergeRemote`, `(not pulled)` suffix) but has
  not been watched live.
- **Follow-up (2026-07-20, user request — released in 0.2.3):** the "run
  once, exit" non-goal was overturned. The picker is now a session loop
  (`pickerLoop` + the verb switch extracted into `dispatch()`): after a verb
  finishes or fails, the same workflow's verb menu re-opens with the cursor
  on the verb just run; the remote list is fetched once per session, the
  local list re-scanned each round; exit code = last verb. Also added: dim
  `░` skeleton placeholder rows while the remote list loads, the init logo
  banner on picker start, and a stdin-EOF → quit guard (a closed input
  can't wedge the process). Verified by the extended pty drive (resume
  menu ×2 renders, name-based trace line, skeleton + failure notice,
  exit 1 after a failed last verb / 0 on plain quit) plus 5 new unit tests
  on `initialState` resume handling.
