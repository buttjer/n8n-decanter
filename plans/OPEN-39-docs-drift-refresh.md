# Plan 39 — Docs & website drift refresh (post-#107/#114/#115)

**Priority:** P1 — several are **HIGH**: copy-paste-broken commands a user or
agent would follow verbatim and get `unknown verb` errors. Mechanical, offline,
clearly-right; no design decisions.
**Status:** Not started
**Theme:** Close the documentation/website drift a targeted audit (2026-07-23,
26 verified findings) found against the current code after the skills-first wave
(#107), the `scenario` fold (#109/#114), and the no-ref pull picker (#115). Pure
sync work — bring every user-facing surface back in step with the shipped CLI.
**Model:** Sonnet (well-specified, mechanical); the only care points are the
website demo edits (they source the recorded GIFs) and the three CLI error-hint
strings (a code touch, not docs).

## Why

The three-surface rule (README / `/docs` / CHANGELOG) plus the template and the
website are supposed to move in lockstep with the CLI. Three breaking waves
landed and left drift the per-PR checks didn't catch:

- **#107 (skills-first):** retired the structure/lifecycle verbs
  (`create`/`rename`/`archive`/`delete`/`duplicate`/`node create`/`node rename`)
  and made the **stdio `mcp connect` guard the auto-wired default** (with
  `mcp serve` demoted to the URL-harness variant). Docs/website still describe
  the `mcp serve` guard-proxy as *the* guard, and the template `.env` still
  lists retired verbs.
- **#109/#114 (`scenario`):** folded `mock`/`fixtures/`/`--pin` into the
  `scenario` verb and committed `scenarios/<slug>.json`. The data-model page
  never mentions it, and "fixture" survives as stale terminology.
- **Plan 27 (verb-first grammar, older) never fully propagated:** several docs
  pages, the template agent contract, **and three of the CLI's own error hints**
  still print **verb-last** commands (`n8n-decanter <ref> <verb>`) that the CLI
  rejects.

A blind agent (Plan 35) or a first-time user copying these commands hits a wall
immediately — hence P1.

## Source

- The 2026-07-23 docs/website drift audit (4-area sweep + per-finding
  adversarial verification; 26 findings survived). This plan is the fix list.
- Companion to the plan-rework pass in the same session (Plans 24/26/28/29/30/31/35).
- No `PLAN.md` design change — this is doc/copy sync, plus one small
  code touch (CLI error-hint strings + one stale code comment).

## Tasks

Grouped by theme. Each fix's file:line is the audit anchor (re-resolve at
execution — only `plans/` changed on this branch).

### A. Verb-last grammar → verb-first (HIGH — copy-paste-broken commands)

The CLI is strictly verb-first (`n8n-decanter <verb> [workflow…]`); positional[0]
must be a known verb or it throws `unknown verb`. Every command below is
verb-last today and **fails when followed**.

1. **`docs/cli/scenario.md`** — all **nine** examples (lines ~32, 35, 38, 112,
   113, 150, 151, 153, 154) are `n8n-decanter order-sync scenario create …` /
   `… simulate …`. Rewrite verb-first:
   `n8n-decanter scenario create order-sync "happy-path" --execution 4812`,
   `n8n-decanter scenario check order-sync happy-path`,
   `n8n-decanter simulate order-sync --execution 4812`,
   `n8n-decanter simulate order-sync --scenario happy-path`.
2. **`docs/cli/simulate.md`** — the "Filling gaps" block (lines ~140–143):
   `scenario create <workflow> "<slug>" --execution <id>`,
   `scenario check <workflow> <slug>`, `simulate <workflow> --scenario <slug>`.
3. **`docs/cli/publish.md`** — "The standard loop" (lines ~35, 37):
   `n8n-decanter push wf` and `n8n-decanter publish wf` (the trailing
   `push --publish` comment stays valid).
4. **`template/AGENTS.md.example`** — the scenario-loop fenced block (lines
   ~414–418) is verb-last; agents following it verbatim get `unknown verb`.
   Rewrite verb-first (preserve the trailing-comment alignment):
   `simulate "<workflow>" --execution <id>`,
   `scenario create "<workflow>" "<slug>" --execution <id>`,
   `scenario check "<workflow>" <slug>`,
   `simulate "<workflow>" --scenario <slug>`.
5. **`n8n-decanter.mts` — CODE touch (three error-hint strings).** Line ~706
   prints `n8n-decanter <ref> simulate …` and lines ~719/778 print
   `n8n-decanter ${refs[0]} executions` — all verb-last, all fail if followed.
   Fix to `n8n-decanter simulate <workflow> [--execution <id> | --scenario <slug>]`
   and `n8n-decanter executions ${refs[0]}` (the sibling hint at line ~749 is
   already correct — match it). *(Not docs, but same root cause and same PR;
   covered by the existing e2e/CLI tests — no new behavior.)*

### B. Guard surface: `mcp serve` guard-proxy → `mcp connect` (MEDIUM/LOW)

Since #107 the scaffolded default is the stdio `mcp connect` guard; `mcp serve`
is the URL-harness HTTP variant. Reword these to lead with `mcp connect`:

6. **`docs/agents/overview.md:37`** — "the `mcp serve` guard-proxy makes that
   boundary safe" → "how the MCP guard (`mcp connect`; `mcp serve` for URL-only
   harnesses) makes that boundary safe by construction" (the page even links
   `/docs/cli/mcp-connect/` two lines down).
7. **`website/src/pages/index.astro:36`** — the "Agent-native" card says
   "`mcp serve` is a localhost guard-proxy that holds your credentials". Reword
   to lead with the pre-wired guard: "the scaffolded `.mcp.json` spawns
   `mcp connect`, a guard that holds your credentials so agents never see them
   (`mcp serve` is the HTTP variant)". **Keep** the card's closer ("decanter
   never calls an LLM itself — your agent and subscription do 100%").
8. **`website/src/pages/index.astro:51,53`** — the comparison rows say
   "guard-proxy" / "guard-proxied"; mirror README.md:158/160's "pre-wired
   `mcp connect` guard" / "over n8n's MCP (through the `mcp connect` guard)".
9. **`template/.env.example:4`** — the comment lists retired verbs
   "create / archive / rename / node …" as the MCP surface. Replace with
   "pull / push / watch / status / publish / unpublish — and the
   `mcp connect` / `mcp serve` guard" (omit `check` — it's local-only).

### C. Website demo drift (MEDIUM/LOW — sources the recorded GIFs)

`website/src/components/TerminalDemo.astro` is the source of `docs/terminal-demo.gif`
(embedded at README.md:28) — **re-record the GIF after these edits** (vendored
recorder; keep `loopMs` matched to the terminal cycle, ~12450 ms, unchanged
since frame durations don't change).

10. **Line ~81 — push says "3 nodes live".** Push is draft-first; only
    `publish` goes live. Change to draft wording, short enough for the box, e.g.
    `✓ Invoice Sync pushed — 3 nodes — draft updated (0.4s)` (optional dim
    follow-up line `run "publish" to go live`). *(The `AgentDemo` push line is
    already correct — "pushed to the draft".)*
11. **Line ~45 — verb menu includes `test`.** The real picker menu has no
    `test`. Remove `"test"` from the demo's `verbs` array. (Animation-safe: the
    cursor only reaches index 2 = `push`.) **After #117 merges** the real menu is
    `status/pull/push/watch/check/preflight/executions/simulate` (8 verbs, adds
    `preflight`) — match whatever `PICKER_VERBS` is at execution time (the demo
    need not show all of it, but must not show a verb the menu lacks).
12. **Lines ~53–56 — picker rows show trailing `pulled` / `not pulled` words.**
    The real picker replaced trailing words with `●`/`○` glyphs + a single dim
    footer legend `● pulled · ○ not pulled`. Drop the per-row words, keep the
    glyph, add the footer legend; move `type to filter` onto the dim query line
    under the title (not the footer hint); hint text `enter select · esc quit`
    (both demo frames sit on pulled workflows).

### C2. Website ↔ README `preflight` sync — LIVE DRIFT since #117 merged (MEDIUM)

**Not from the main audit** (which ran pre-`preflight`): #117 added `preflight`
to the README's compare row + framing but **touched no `website/` file**, so as
of its 2026-07-23 merge the website's `index.astro` — the static mirror of the
README compare table + feature cards — **now lags the README** on preflight.
Bring it back in step:

12a. **`website/src/pages/index.astro` "Preflights" comparison row (~line 48)** —
     currently `"Preflights (check / simulate / test)"` + "…offline check +
     simulate, instance-side test; each diffed vs a real capture". Mirror the
     post-#117 README row: title `(check / simulate / test / preflight)` and
     append "— and `preflight` scores the whole ladder into one read-only,
     CI-gateable verdict".
12b. **The "Preflights" feature card (~lines 25–26)** — text names only "check,
     simulate, and test". Add `preflight` as the scored, read-only gate over the
     three (one clause, matching the README capability bullet #117 adds). Weigh
     whether `preflight` warrants its own headline card, since #117 leads with it
     as a headline capability — judgment call, not required.
12c. **No GIF change** — these are static copy, not the `TerminalDemo` component,
     so no re-record. *(The demo picker menu is Task 11 above.)*

### D. Data-model & config doc gaps (MEDIUM/LOW)

13. **`docs/concepts/sync-layout.md`** — the folder-per-workflow tree (lines
    ~9–17) never mentions committed `scenarios/<slug>.json`. Add
    `scenarios/happy-path.json  # committed pin-data set` to the tree and a
    short section: scenarios are committed full-workflow pin sets replayed via
    `test`/`simulate --scenario`, tracked in git (contrast the gitignored
    `executions/` sibling); link `/docs/cli/scenario/`.
14. **`docs/concepts/sync-layout.md:69`** — "stale-fixture warning" → "stale-**capture**
    warning" (the code is `warnStaleCaptures`; "fixture" is retired terminology).
    **Also fix the same stale phrase in the code comment** at `lib/pull.mts:151`
    ("executions stale-fixture warning") in the same pass.
15. **`docs/concepts/configuration.md`** — the key table (lines ~25–35) and the
    JSON example (~11–23) omit the real `n8nVersion` key. Add a row:
    `n8nVersion` | unset | n8n version `simulate`'s engine-true runner pins to
    (e.g. "2.31.4"); `--n8n-version` overrides per run — see `/docs/cli/simulate/`.
    (Adding it to the example JSON is optional but on-style.)
16. **`docs/concepts/configuration.md:44`** — the MCP-credentials verb list
    omits `test` (which drives MCP `test_workflow`). Add **only** `test` to the
    line-43 list ("…publish, unpublish, test — and the `mcp connect`/`mcp serve`
    guard"); do **not** re-add `scenario create --scaffold` there — it is
    already stated as an exception at line ~65 (avoid the double-statement).

### E. Compliance-guard doc gaps + nits (LOW)

17. **`docs/cli/check.md`** (and its "full list of checks" sibling
    `docs/concepts/push-gates.md:20–22`) — the guard list omits three shipped
    rules. Add: a **hard error** for a leftover legacy `fixtures/` dir *containing
    `.json` files* (Plan 37); and two **warnings** (fold into the existing
    "warn without blocking" sentence at check.md:29, not the hard-error bullet
    list) — inline `pythonCode` on a Python Code node, and a committed scenario
    whose `workflowData` embeds **inline** Code-node source (non-empty `jsCode`
    not starting with `//@file:`). *(Attribution: only the `fixtures/` error is
    Plan 37; the two warnings are Plan 33 "snapshot-invariant honesty".)*
18. **`docs/cli/overview.md:34`** — the command index annotates
    `scenario create … [--scaffold]` as "(offline)", but `--scaffold` needs the
    MCP connection (`prepare_test_pin_data`). Mark the base verb offline and note
    `--scaffold` requires MCP, or drop the blanket "(offline)".
19. **`docs/getting-started/quickstart.md:16`** — "never overwrites existing
    files" predates modification-aware re-init. Reword: "Re-running is safe:
    files you've edited are left alone (untouched template files can be refreshed
    after a confirm; `--force` resets everything)" — keep the existing
    `/docs/cli/init/` link.
20. **`docs/cli/watch.md:4` / `docs/cli/test.md:4`** — both carry frontmatter
    `order: 7`, so the sidebar tie resolves by accident. Move one to a free slot
    (9 or 10) — e.g. keep `test` at 7 (or move it, since it caused the collision)
    and give `watch` a distinct order.

## Acceptance / verification

- **No verb-last command survives** in `docs/`, `template/`, or the CLI's own
  error strings — grep for `n8n-decanter [a-z0-9-]* \(scenario\|simulate\|push\|publish\|executions\|check\|status\)`
  patterns and confirm each hit is verb-first (or a legitimate `<verb> <ref>`).
- **No "guard-proxy"/"`mcp serve` is the guard" framing** remains as *the*
  default in docs/website; `mcp connect` leads, `mcp serve` is named the variant.
- The website terminal demo matches the real picker (glyph rows + footer legend,
  the exact `PICKER_VERBS` menu at execution time) and draft-first push wording;
  **`docs/terminal-demo.gif` re-recorded**.
- **Post-#117:** the website's "Preflights" compare row **and** feature card name
  `preflight` (matching the README `preflight` changes #117 lands), so
  `website/index.astro` no longer lags the README on preflight.
- `docs/concepts/sync-layout.md` documents `scenarios/`; `configuration.md`
  lists `n8nVersion` and `test`; `check.md`/`push-gates.md` list the three
  guard rules; the quickstart re-init claim and the `order:` collision are fixed.
- `npm test` + `npm run typecheck` + `npm run lint` green (the only code touch
  is the three error-hint strings + one comment — behavior unchanged, covered by
  existing tests). A `[Unreleased]` CHANGELOG entry is **not** required (these
  are doc/copy fixes; the error-hint correction is a user-facing **Fixed** line
  worth adding).

## Notes

- **Website GIFs:** Tasks 10–12 change what `TerminalDemo.astro` renders, so the
  recorded `docs/terminal-demo.gif` must be regenerated (see the demo-GIF
  recording procedure; `AgentDemo` is unaffected). This is the one non-mechanical
  step — do it last and eyeball the result.
- **Scope discipline:** this plan is *drift repair only* — no new capabilities,
  no `PLAN.md` design change. The audit's `cleanNote`s confirmed the rest of the
  website (hero, 5/6 feature cards, comparison table, AgentDemo, nav/llms
  generation) and most docs pages are already current.
- **Plan 36 (`preflight`, PR #117) merged 2026-07-23 — re-verified against the
  merged `main`.** #117 edits four files this plan also touches
  (`docs/cli/simulate.md`/`check.md`/`overview.md`, `template/AGENTS.md.example`),
  but **it fixed none of these findings** — all survive: `simulate.md`'s "Filling
  gaps" block is still verb-last, `check.md` still omits the three guard rules,
  `overview.md`'s `scenario create --scaffold` is still tagged "(offline)", and
  `AGENTS.md.example`'s scenario loop is still verb-last (only its line moved,
  now ~423). So this plan stands as written. Do **not** touch `preflight`'s own
  surfaces — `docs/cli/preflight.md`, the overview `preflight` verb row, the
  `AGENTS.md.example` gate step — they are **owned by #117**. Re-resolve the
  remaining line anchors at execution (they are pre-#117).
- **PR #118 (guarded-MCP-gateway reframe) merged 2026-07-23 — re-verified.**
  #118 reworded structure copy across six files this plan also touches
  (`docs/concepts/sync-layout.md`, `docs/concepts/push-gates.md`,
  `docs/cli/status.md`, `template/AGENTS.md.example`,
  `website/src/pages/index.astro`, `website/src/lib/llms.ts`) — but again
  **fixed none of these findings**: the website "Agent-native" card still says
  "`mcp serve` is a localhost guard-proxy" (Task 7), the comparison rows still
  say "guard-proxy"/"guard-proxied" (Task 8), `sync-layout.md` still never
  mentions `scenarios/` (Task 13), and `push-gates.md`/`AGENTS.md.example`'s
  gaps stand. What it **did** change is the *surrounding framing* — structure is
  now "decanter's guarded MCP gateway", not "n8n's job". So when executing the
  website/`AGENTS.md` tasks, **reconcile the `mcp serve`→`mcp connect` wording
  with #118's new gateway copy** rather than the pre-#118 text, and re-resolve
  anchors again (they shifted in all six files). Plan still stands whole.
- **This plan is the one-time cleanup; [Plan 40](OPEN-40-docs-surface-drift-guardrail.md)
  is the ratchet** that stops the verb-last / surface-mismatch class recurring.
  Land this plan's grammar fixes first (or together) so Plan 40's CI check goes
  green.
- **One-code-comment sibling:** `lib/pull.mts:151`'s "stale-fixture warning"
  comment rides along with Task 14 (same terminology fix), keeping code and docs
  consistent.
