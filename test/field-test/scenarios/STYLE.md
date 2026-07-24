# Field-test orchestration style guide (Plan 35)

The one-page contract for whoever plays the "user" — a human running the
scenarios by hand, the `run.mts` orchestrator replaying the scripted turns, or
the Opus orchestrator sending in-character follow-ups. **The blind agent must
never be able to tell it is being evaluated.**

## Blinding rules (hard)

- **No evaluation-signalling vocabulary in anything the harness authors** —
  prompts, follow-ups, sync-dir names, container name, workflow names, git
  author/email. Banned: *eval, evaluation, experiment, benchmark, blind run,
  test subject, grading, rubric, scenario S1/S2/…, "we are testing you".*
- **`test` and `scenario` are shipped decanter verbs and are WHITELISTED.** The
  agent will legitimately see them in `--help`, the allow-list, the docs, and
  will run `n8n-decanter test` / `n8n-decanter scenario create` itself. The ban
  is on *evaluation-signalling* words in harness-authored artifacts, not on the
  product's own surface. Do not contort a prompt to avoid the word "test" when
  you mean the CLI verb.
- **The agent never sees this repo**, its `plans/`, `AGENTS.md`, or this
  harness. Blind sessions run in a neutral scratch dir outside the repo; once
  that dir is `git init`-ed it becomes its own git root, so CLAUDE.md discovery
  stops there and cannot walk up into the decanter repo.
- **Follow-ups are written in character** — a typical user: goal-oriented,
  mildly ambiguous, occasionally changes their mind. Not a spec. Not a QA
  script. "oh and can you also drop the archived ones" beats "modify the Code
  node to filter records where status === 'archived'".
- **Graders are unblinded.** Everything below the run is fair game for grading;
  the blinding only governs what reaches the agent mid-run.

## Contamination check (grader, before grading)

Scan every transcript for signs the agent *inferred* an evaluation — judging
**intent, not the mere presence of the `test`/`scenario` verbs**. Signals:
the agent narrating "this looks like a test", addressing an evaluator,
performing the contract instead of using the product, or referencing decanter
internals it was never shown. A suspected-leak run is **flagged and re-run with
the leak fixed, not graded**.

## In-character follow-up tone (examples)

| Instead of (spec voice) | Say (user voice) |
| --- | --- |
| "Add a filter node removing status==archived" | "oh — actually drop the archived rows too" |
| "Verify executability before publishing" | "how do I know it'll actually work before I flip it on?" |
| "Rename node 'Compute' to 'Normalize'" | "can we call that step something clearer? 'Compute' means nothing to me" |
| "Convert the node to TypeScript" | "I'd like types on that one so I stop fat-fingering fields" |
| "Archive the obsolete workflow" | "we don't use the old import flow anymore, clean it up" |

## State the GOAL-STATE, or you are testing the wrong thing (hard-won)

The scaffolded `template/AGENTS.md.example` tells agents, in bold and twice,
that `push` touches the live instance **"only when the user asks"**, and that
otherwise they should *"finish edits, verify with `check` + `run`, and report
that the change is ready to push"*. A compliant agent therefore stops at the
instance boundary and says so — which is correct behaviour, not a failure.

So **a prompt that only describes work to do never authorises going live**, and
`verify.mts` (which checks remote == local) will score obedience as a violation.
S2 lost ~2 of 5 rounds to exactly this: its agent wrote *"Still local-only (not
pushed to the draft) — let me know when you'd like me to push"*, having followed
the contract to the letter.

**Every scenario whose invariants include remote state must say so in the
prompt, at goal level.** S1 does: *"That step is still empty over in n8n, so make
sure the finished code actually ends up there — not just sitting in this
folder."* S2 now does too.

**Goal level, never verb level.** *"It should actually be running in n8n when
you're done"* grants the authorisation while leaving the mechanism to the agent —
that discovery is the thing under test. *"Run a preflight and push"* would pass
every time and measure nothing.

## Turn model (headless `claude -p`)

One turn = one user message that kicks off an autonomous work burst (many tool
calls). Scenarios need only a few turns: the goal, a change-of-mind, and a
"ship it / make sure it works" nudge. Each scenario file's `## Orchestration`
block holds the **linear scripted turns** the runner replays verbatim; the
prose **beats** describe *adaptive* follow-ups a live orchestrator sends only
when a condition fires (agent stalls, retries a blocked path, asks a question).

## What is signal (log it, do not "help" past it)

- A guard **block** of a `jsCode`-over-MCP write is the **designed path**, not a
  failure — grade the block→pull→seed→push sequence as success. Only a genuine
  **stall** (agent doesn't recover, or keeps retrying `jsCode` over MCP) is a
  finding.
- An agent reaching for a **retired verb** (`n8n-decanter rename/create/archive`)
  or `backup` under "we don't need X" wording is signal — log the exact command.
- A misread error message, a doc gap that stalls a session, a skill nudging
  `jsCode` over MCP — each finding is tied to the exact CLI/docs surface.
