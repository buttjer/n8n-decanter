# Plan 62 — Field test: the three conditions no round has ever measured

**Priority:** P2 — the harness is finished and proven ([Plan 35](../done/35-blind-agent-field-test.md),
22 archived rounds); these are staging *conditions* it supports but has never
been run under. Each one hides a claim we currently make without evidence.
**Status:** Not started
**Snapshot:** 2026-07-27T12:05Z @ 0be700c
**Theme:** Every archived round so far handed the blind agent two things a real
user's agent does not get: a **resolvable bare `n8n-decanter`** on PATH and a
**pre-seeded, correct `.env`**. Both crutches are now opt-out flags that nobody
has opted out of. Plus `watch` (S5) — written, never executed.
**Model:** Opus to orchestrate + grade; **Sonnet stays the blind cast** (Plan 35's
maintainer call).

## Why

- **The PATH crutch already hid one real bug.** Plan 58 Task 1's guard
  silent-fail survived every round precisely because `run.mts` prepended the
  workDir's `node_modules/.bin`. The crutch is now explicit and printed
  (`PATH policy`), and `FIELD_NO_PATH_HELP=1` drops it — but **no round has run
  that way**, so "the agent reached the CLI" remains conditional on help the
  field doesn't supply. The guard route itself is already unassisted
  (`npx --no-install`, Plan 58); what's unmeasured is the agent's **`Bash`**
  surface.
- **`init`'s flags have never met a blind agent.** #144 added
  `--host`/`--token`/`--api-key` because interactive `init` cost round 1 twenty+
  attempts, and #142 fixed `https://`-for-local-host. Both were verified by unit
  tests and by the maintainer — **never by a round**, because the stage pre-seeds
  `.env` and `init` just reuses it. `FIELD_NO_SEED_ENV=1` is the condition that
  would actually re-run the failure.
- **S5 (`watch`) is written and unexecuted.** It is the one authoring loop no
  blind agent has touched, and it changed shape since it was written (the
  browser-reload proxy was removed in #128 — `watch` now pushes on save and
  prints the editor deep link, relying on n8n's native reflection of draft
  edits). Either measure it or retire the scenario; leaving it staged-but-unrun
  is the worst of the three.

## Tasks

1. **Unassisted-PATH round** — `FIELD_NO_PATH_HELP=1`, host mode, S1 + S2.
   Confirm the header prints `UNASSISTED PATH`, then grade the *recovery*: does
   the agent reach `npx n8n-decanter …` on its own (S6 rounds 3–4 did so
   unprompted with a `which … || npx …` probe), or does it stall / fall back to
   raw MCP? A stall here is a **product** finding about invocation form, not a
   harness failure — [Plan 58](58-guard-route-robustness.md) Task 4 owns the fix.
2. **Cold-`init` round** — `FIELD_NO_SEED_ENV=1`, S1, with the MCP token handed
   over in-character the way a user pastes one. First blind exercise of #144's
   flags and #142's scheme handling. Grade turns-to-`.env`, whether the agent
   finds the non-interactive path at all, and whether the guard reaches the
   instance afterwards (`fetch failed` was the original symptom).
3. **S5 or retire it** — run `watch` host-mode/unsandboxed (`fs.watch` dies both
   sandboxed and on container bind-mounts, so this one can never be fenced), or
   fold S5's checklist into S1/S2 and delete the scenario. **Decide explicitly**;
   record the decision in the scenario file either way.
4. **Fold the results back** — append the round reports to *this* plan (Plan 35
   is closed), commit each `raw.tgz` + `report.html`, and route any finding to a
   plan the way Plan 35's ledger did.

## Acceptance / verification

- One round per condition, archived and committed under
  `test/field-test/runs/`, each with its `verify-*.json` verdict.
- Each round's own record states the condition it ran under (the `PATH policy`
  line, `noCli`/seed flags in the manifest) — a reader must not have to infer it.
- The S5 decision is written down in `scenarios/S5.md`.
- Findings routed 1:1, or an explicit "nothing found".

## Non-goals

- **Not more scenarios** — that's Plan 61 (unmerged, PR #160), which widens
  *what* is tested. This plan finishes *how* the existing scenarios are staged.
- **No product fixes here** — same rule as Plan 35: findings go to the
  maintainer, fixes get their own plan/PR.
- **No re-grading of Plan 35's archived rounds.** They measured the CLI of their
  day; three of them (`90305`, `92069`, `99503`) already cover the current
  `preflight`/`diff` surface.

## Notes

- **Cost:** ~3–5 Sonnet sessions plus grading — the small envelope, not a wave.
- Tasks 1 and 2 are host-mode by construction (Task 1 measures the host PATH;
  Task 3's `fs.watch` needs a real filesystem), so they run **unsandboxed and
  supervised**, unlike the fenced default.
- Task 2 is worth running **before** the next release that touches `init` — it
  is the only check that the non-interactive path is discoverable rather than
  merely present.
