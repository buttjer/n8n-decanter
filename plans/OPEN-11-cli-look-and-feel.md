# Plan 11 — CLI look & feel

**Priority:** P1 (style layer, progress, logo) / P2 (name resolution, completion, `list`)
**Status:** Not started
**Theme:** Make the CLI pleasant for humans — color, progress, name-based
arguments, shell completion, a small logo — without changing one byte of the
plain, line-oriented output that LLMs, scripts, and the e2e suite consume.

## Why

- Output today is bare `console.log` lines with two hardcoded ANSI colors
  (`n8n-decanter.mts:17-21`). Humans get no visual hierarchy; worse, the ANSI
  codes are emitted **unconditionally**, so they leak into pipes — the e2e
  suite has to `stripAnsi` (`test/e2e.mts:480`). LLM-friendliness is currently
  *worse* than it should be, not better.
- Workflows are addressed only by id. Ids are opaque; humans (and LLMs reading
  a repo) know workflows by *name*, and the name is already on disk as the
  folder name plus in `.decanter.json`.
- Multi-workflow `pull`/`push` gives no sense of progress, and network calls
  are silent until they finish.

## Source

Direct user request (2026-07-18): "optimize the CLI look & feel — autocomplete
by workflow names, more progress indication, color and highlighting, keep it
minimalistic, ASCII logo in init, must remain LLM compatible." No Plan 0 entry.

## Design decision — LLM compatibility (the "possible?" answer)

Yes, cleanly. **One rule: styling and transient output exist only when the
target stream is a TTY.** Concretely:

- All color goes through Node's built-in `styleText` (`node:util`), which
  already respects `NO_COLOR`, `FORCE_COLOR`, and TTY detection per stream —
  zero new dependencies (Node ≥ 22.18 is already required).
- Piped/redirected output (LLM harnesses, scripts, the e2e suite) gets plain
  line-oriented text — the same words, minus escape codes. Color is additive
  decoration; **no information is ever carried by color alone**.
- Progress counters/durations are plain text and appear in both modes;
  transient same-line rewrites (`\r`) and the logo are TTY-only.
- Nothing new is interactive. Name resolution *errors* on ambiguity (listing
  candidates) instead of prompting; `init`'s prompts already survive piped
  stdin (`lib/init.mts` `createPrompt`).
- Shell completion lives in the user's shell, invisible to non-interactive use.

Net effect: humans get color and progress; LLMs get *cleaner* output than
today (no more leaked ANSI).

## Tasks

1. **Style layer** — new `lib/style.mts`: thin wrapper over
   `util.styleText` with per-stream gating (`{ stream: process.stderr }` for
   warn/error) plus the tiny vocabulary used everywhere:
   - Glyphs: `✓` success (green), `!` warning (yellow, as today), `✗` error
     (red, replaces `x`), dim for metadata (paths, ids, durations), bold for
     workflow/node names.
   - Rewire the `log` object in `n8n-decanter.mts:17-21`; extend `Log`
     (`lib/types.mts:75`) with `ok(m)` for green success lines (`check` "OK",
     `pushed`, `in sync`, `typecheck OK`). Callers keep `info` for neutral
     text. Update e2e assertions that match the old `x ` prefix.
2. **Progress indication** — in the multi-id loop
   (`n8n-decanter.mts:96-110`): dim `[2/5]` prefix when more than one
   workflow; `(0.4s)` dim duration suffix on pull/push result lines. TTY-only:
   a transient `pulling <name>…` line rewritten in place when the result
   arrives; piped output gets result lines only (as today).
3. **Workflow-name arguments** — `resolveWorkflowRef(root, ref)` in
   `lib/state.mts`: exact id → exact folder/workflow name (case-insensitive)
   → unique name prefix; ambiguity or no match → error listing candidates.
   Wire into the dispatcher for `pull`/`push`/`status`/`check`/`rename`/
   `watch`. For `pull` of a not-yet-pulled workflow, fall back to the API:
   add cursor-paginated `listWorkflows()` to `lib/api.mts`
   (`GET /api/v1/workflows`, client-side name match — no reliance on the
   server-side `name` filter's exact-match quirks). Known edge: a workflow
   literally named like a verb loses to verb detection
   (`n8n-decanter.mts:53`) — document "use the id then".
4. **`list` verb** — offline: one line per pulled workflow — bold name, dim
   id, dim relative dir (data from `listWorkflowDirs` + `readState`).
   `list --remote` additionally shows remote workflows not pulled yet (via
   `listWorkflows()`). Doubles as the id/name discovery surface for humans
   *and* LLMs ("what can I address?").
5. **Shell completion** — `completion zsh|bash` prints a completion script to
   stdout (user appends to their rc); the script calls a hidden `__complete`
   verb that emits verbs, flags, and local workflow names/ids (offline,
   credentials-free; silently empty when no config is found). This is the
   actual "autocomplete by workflow names".
6. **Logo + init polish** — `lib/init.mts`: on TTY print logo + version
   (from `package.json`); piped runs print one plain `n8n-decanter v0.1.0`
   line instead (e2e drives init via pipe and must stay stable). Candidate
   (final art is a taste call):

   ```
        __
       |  |
       |  |        n8n-decanter v0.1.0
      /    \       n8n workflows ⇄ git
     / n8n  \
     \______/
   ```

7. **Help & docs** — USAGE (`n8n-decanter.mts:23-41`): bold verbs, dim
   explanations via the style layer; add `list` and `completion`; document
   name arguments. README + CHANGELOG entries (Added: name args, `list`,
   `completion`, logo; Changed: color only on TTY / `NO_COLOR` respected;
   Fixed: ANSI no longer leaks into piped output).

## Acceptance / verification

- Piped output of every verb contains **zero** ANSI escapes; e2e replaces the
  `stripAnsi` tolerance at `test/e2e.mts:480` with an assertion that none
  occur. `NO_COLOR=1` on a TTY does the same.
- `n8n-decanter "My Workflow" push` ≡ `n8n-decanter <id> push`; ambiguous
  prefix and unknown name each fail with a candidate list (exit 1, no prompt).
- `list` shows name + id + dir for every pulled workflow offline;
  `list --remote` marks not-pulled ones.
- `completion zsh` / `completion bash` scripts source cleanly; `__complete`
  emits workflow names after a pull.
- Resolver gets unit tests (on Plan 9's `node:test` harness once it lands);
  e2e gains steps for name-based push and `list`.
- `npm test` and `npm run typecheck` green.

## Non-goals

- No interactive pickers, TUI frameworks, or spinner/color dependencies —
  zero new deps; `styleText` covers color.
- No `--json` output mode (would be a separate backlog item if wanted).
- No watch-mode output redesign (Plan 10 touches watch testability; avoid
  collisions).

## Notes

- Tasks 1–2 and 6 are small and self-contained (P1); 3–5 add surface area and
  an API call, hence P2. Task 3 before 4/5 (they share `listWorkflows()` and
  the resolver).
- **PLAN.md**: name-based addressing and the new verbs change the CLI surface
  — raise the PLAN.md update with the user at implementation time (per
  CLAUDE.md), not before.
- Cross-links: [Plan 9](DONE-9-tests-stability-refactoring.md) (unit-test
  harness for the resolver), [Plan 10](OPEN-10-hardening-bigger-refactors.md)
  (`status` exit codes pair naturally with `list`).
