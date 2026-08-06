# Plan 62 — Field test: the three conditions no round has ever measured

**Priority:** P2 — the harness is finished and proven ([Plan 35](../done/35-blind-agent-field-test.md)
plus [Plan 61](61-field-test-scenario-wave-2.md); 33 archived units); these are
staging *conditions* it supports but has never been run under. Each one hides a
claim we currently make without evidence.
**Status:** Not started
**Snapshot:** 2026-08-05T19:20Z @ 08e61dc *(previous: 2026-07-27T12:05Z @ 0be700c)*
**Theme:** Every archived round so far handed the blind agent two things a real
user's agent does not get: a **resolvable bare `n8n-decanter`** on PATH and a
**pre-seeded, correct `.env`**. Both crutches are now opt-out flags that nobody
has opted out of. Plus `watch` (S5) — written, never executed.
**Model:** Opus to orchestrate + grade; **Sonnet stays the blind cast** (Plan 35's
maintainer call).

## What changed since the original snapshot (2026-07-27 → 2026-08-05)

The conditions are unchanged and still unmeasured. **How you run them is not** —
reworked here so an executing agent does not drive the harness of a week ago.

| Then | Now |
| --- | --- |
| Plan 61 "unmerged, PR #160" | **merged**; waves 2a *and* 2b built, scenarios S1–S13, corpus seed packs |
| one stage, many scenarios | **runs are isolated and the runner enforces it** — `--isolate` stages a fresh instance per scenario (or per `requires` chain) and tears it down; passing independent scenarios to one manifest is refused before spending |
| `verify.mts` = byte-equality + git history | also: **read-only scenarios must not move `versionId`**, fetched caches never committed, committed scenarios structurally valid |
| — | `--seeds <pack>`; `--hook=<name>` plays one pre-hook with no claude spend |
| — | **STYLE.md hard rule**: a turn may only name what the pack seeds (two units were lost to this) |
| "run UNSANDBOXED" | **partly obsolete** — see the Notes; today's nine units were driven from a sandboxed shell and completed |

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

1. **Unassisted-PATH round** — `FIELD_NO_PATH_HELP=1`, S1 + S2:

   ```sh
   FIELD_NO_PATH_HELP=1 node test/field-test/run.mts --isolate S1 S2
   ```

   S1 and S2 are independent, so `--isolate` gives each its own instance — which
   is what this condition needs anyway: PATH recovery in S2 must not inherit
   whatever S1's agent installed. Confirm each unit's header prints
   `UNASSISTED PATH`, then grade the *recovery*: does the agent reach
   `npx n8n-decanter …` on its own (S6 rounds 3–4 did so unprompted with a
   `which … || npx …` probe), or does it stall / fall back to raw MCP? A stall
   here is a **product** finding about invocation form, not a harness failure —
   [Plan 58](58-guard-route-robustness.md) Task 4 owns the fix.

   *(Env reaches the inner run by construction: `--isolate` re-execs without an
   `env` override, so the child inherits it.)*
2. **Cold-`init` round** — `FIELD_NO_SEED_ENV=1`, **S14**, with the MCP token
   handed over in-character the way a user pastes one:

   ```sh
   FIELD_NO_SEED_ENV=1 node test/field-test/run.mts --isolate S14
   ```

   S1's turns assume a working project, so the condition needed a scenario whose
   *turns* carry the credentials — `scenarios/S14.md`, added by this plan. It is
   the only scenario using the spawn-time-only `{{HOST}}`/`{{MCP_TOKEN}}`
   placeholders.

   The flag is read by **`stage.mts`**, which `--isolate` spawns — so the
   isolated form is the one that carries it. First blind exercise of #144's
   flags and #142's scheme handling. Grade turns-to-`.env`, whether the agent
   finds the non-interactive path at all, and whether the guard reaches the
   instance afterwards (`fetch failed` was the original symptom).

   **Expect a wrong turn worth grading, not just a stall.** Two rounds have now
   watched an agent meet a credential failure and conclude *"this project was
   never set up"* — [Plan 74](../done/74-mcp-disabled-403.md) fixed the guard's
   401 wording and the scaffold's `.env` note because of it. Cold `init` is the
   condition where that conclusion would be **correct**, so it is the round that
   says whether the new wording over-corrected.
3. **S5 or retire it** — run `watch` host-mode/unsandboxed (`fs.watch` dies both
   sandboxed and on container bind-mounts, so this one can never be fenced), or
   fold S5's checklist into S1/S2 and delete the scenario. **Decide explicitly**;
   record the decision in the scenario file either way. S5 also needs the
   `verifyWorkflows` audit every wave-2 scenario got: it predates
   `"none"`, `readOnly` and the seed-kind gate, and it is the last scenario
   never checked against a real stage.
4. **Fold the results back** — append the round reports to *this* plan (Plan 35
   is closed), commit each `raw.tgz` + `report.html`, and route any finding to a
   plan the way Plan 35's ledger did.

## Acceptance / verification

- One round per condition, archived and committed under
  `test/field-test/runs/`, each with its `verify-*.json` verdict. With
  `--isolate` that is **one archive per unit**, so a unit lost to an API outage
  costs only itself (that happened on 2026-08-05 and cost one unit, not a round).
- Each round's own record states the condition it ran under (the `PATH policy`
  line, `noCli`/seed flags in the manifest) — a reader must not have to infer it.
- The S5 decision is written down in `scenarios/S5.md`.
- Findings routed 1:1, or an explicit "nothing found".

## Non-goals

- **Not more scenarios** — that was [Plan 61](61-field-test-scenario-wave-2.md),
  which widened *what* is tested and is now built. This plan finishes *how* the
  existing scenarios are staged.
- **No product fixes here** — same rule as Plan 35: findings go to the
  maintainer, fixes get their own plan/PR.
- **No re-grading of Plan 35's archived rounds.** They measured the CLI of their
  day; three of them (`90305`, `92069`, `99503`) already cover the current
  `preflight`/`diff` surface.

## Notes

- **Cost:** ~3–5 Sonnet sessions plus grading — the small envelope, not a wave.
  Add ~1.5 min of stage boot per unit now that each gets its own instance.
- **Host mode, but the "unsandboxed" part is narrower than it was written.**
  Task 1 measures the host PATH and Task 3 needs `fs.watch`, so neither can be
  fenced. But "run UNSANDBOXED" as a blanket rule is now contradicted by
  evidence: today's nine units — including seven full stage boots, Docker, and
  the nested `claude -p` sessions — were driven from a **sandboxed** shell and
  completed. The one thing still known to die sandboxed is `fs.watch`, i.e.
  **Task 3 only**. Do not widen that back out without re-measuring.
- **These conditions compose with any scenario at no extra turn cost.** Each is
  an env flag on an otherwise ordinary isolated run, so a future wave can carry
  one along instead of paying for a dedicated round — but the *first* run of
  each should be dedicated, so a finding is unambiguous about which crutch
  removal caused it.
- **Why this plan is the one that answers "are the results authentic?"** The
  product carries no harness awareness — verified 2026-08-05: zero `FIELD_*`,
  `NODE_ENV`, `CI` or test-mode branches in `lib/` or the CLI entrypoint (the
  only `field-test` mentions there are comments explaining why a fix exists).
  What *is* shaped is the **environment**, and these two flags are the only
  shaping that makes things **easier** than the field. Until they are dropped in
  a real round, "an agent copes unaided" stays a claim rather than a finding.
- Task 2 is worth running **before** the next release that touches `init` — it
  is the only check that the non-interactive path is discoverable rather than
  merely present.
