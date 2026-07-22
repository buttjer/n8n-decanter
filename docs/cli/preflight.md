---
title: preflight
description: The whole verification ladder as one scored, read-only, CI-gateable gate — nothing it does can touch the published version or the outside world.
order: 9
---

```sh
n8n-decanter preflight [workflow…] [--quick|--full|--offline] [--json]
                       [--fail-on=warn] [--fail-fast] [--require=<ids>]
                       [--execution <id> | --scenario <slug>] [--trigger <node>] [--no-fetch]
```

**`preflight` runs every safe check there is** — local static → instance
read-only → pinned draft runs — ordered fast→slow, and condenses them into a
scored verdict with actionable feedback for humans *and* agents. It adds **zero
new execution paths**: it orchestrates and scores the same machinery `check`,
`status`, `test`, and `simulate` already run, so the one thing an agent needs
before `push`/`publish` is a single structured gate instead of four commands
with four output formats.

With no workflow it runs every workflow in your config (or opens the
[picker](/docs/cli/overview/#interactive-picker) on a terminal); the exit code
aggregates across them.

## The ladder — every check, fast → slow

Each check has a **stable id** (agents key on it). Nothing here builds a new
execution path — every row reuses the verb named in "Machinery".

| Tier | Check | Verifies | Can produce |
| --- | --- | --- | --- |
| **static** (offline, ms) | `layout` | compliance guard: placeholders, connections, duplicate names/ids, orphans, dangling `$('…')` refs | fail / warn |
| | `types` | typecheck of the node files | fail / skip |
| **sync** (instance, read-only) | `connect` | MCP reachable, auth valid (exercises OAuth refresh) | fail |
| | `access` | workflow is *Available in MCP* | fail |
| | `parity` | local code == the draft (the subject the runtime tier verifies) | warn |
| | `drift` | remote code moved off the last sync | warn / **fail on CONFLICT** |
| | `snapshot` | structure snapshot current | warn |
| | `lifecycle` | draft vs published version, publication state | info |
| | `history` | recent production runs: error rate, most recent failure | warn |
| | `capture` | a capture/scenario exists to pin from, and matches the draft | warn |
| **runtime** (executes, minutes) | `test` | pinned run **on the instance**, per-node diff vs the capture | fail |
| | `simulate` | pinned replay on a **local** engine, per-node diff | fail |

Checks **stream as they complete**, so a fast red surfaces in the first second
even when the runtime tier takes minutes. `--fail-fast` stops after the first
failure (the rest are skipped, and say so); the default always completes the
card.

## Profiles — deterministic, no magic escalation

| Invocation | Tiers | For |
| --- | --- | --- |
| `preflight --quick` | static + sync | the every-edit loop, pre-commit |
| `preflight` (default) | static + sync + `test` | the pre-publish gate |
| `preflight --full` | default + `simulate` | maximum coverage (also verifies *local* code when `parity` warns) |
| `preflight --offline` | static + `simulate` | air-gapped CI — no instance contact at all |

An auto-escalation variant (run `simulate` only when it would add signal) was
**rejected**: surprise Docker boots and nondeterministic wall time are worse
than one explicit `--full`. Every skipped check prints its reason and the
unlock (`simulate: pass --full`), so nothing is ever silently narrower than it
looks.

## Executions are the ground truth

`preflight` brings your real run data into the gate:

- **Pins and diffs.** The runtime tier pins from and diffs against a capture
  (`--execution <id>`, default newest) or a committed
  [scenario](/docs/cli/scenario/) (`--scenario <slug>`).
- **Auto-fetch.** Before the runtime tier, `preflight` fetches the newest
  capture when `N8N_API_KEY` is set and the local capture is missing or stale —
  so a bare `preflight` verifies against *fresh* reality. It's a read
  (captures land in the gitignored `executions/` dir); `--no-fetch` disables it,
  and without a key it's skipped with guidance.
- **History as a health signal.** The `history` check reads recent production
  executions (over MCP `search_executions`, or the REST executions API when
  `N8N_API_KEY` is set) and reports the error rate — a live workflow that's been
  failing is a **warn**, never a fail (the draft isn't guilty of the past).

## Scoring & verdict

Each check reports `pass` / `warn` / `fail` / `skip` / `info`, a duration, a
message, and — for a warn or fail — the exact **remediation** command.

- **Verdict** (deterministic): any `fail` → **`not ready`** (exit 1); else any
  `warn` → **`caution`** (exit 0); else **`ready`** (exit 0). `--fail-on=warn`
  promotes a caution to exit 1. Exit codes stay 0/1.
- **Score 0–100** (the trend line; the verdict is the gate): starts at 100, each
  `fail` costs 40 (a `CONFLICT` `drift` costs 30), each `warn` costs 10, floored
  at 0. The weights are starting values, tuned freely; the verdict rules are the
  stable contract.
- **Coverage is first-class honesty.** The card always says which checks ran vs
  skipped and why — a 100 with no runtime run reads as `ready` with the coverage
  gap named, never a bare green. **`--require=<ids>`** (a comma list of check
  ids, e.g. `--require=test`) turns a *skip* of that check into a **fail** — the
  CI teeth for "must have runtime coverage".

## The report — for humans and agents

The human card streams a line per check, then the score/verdict/coverage and the
remediation for anything that warned, failed, or was skipped:

```txt
preflight: order-sync · default profile
  ✓ layout    layout compliant
  ✓ connect   MCP reachable, auth valid
  ! parity    local code differs from the draft in 1 node(s) — the runtime verdict covers the draft
  ✓ test      3 node(s) ran on the instance, all matched the capture (1 pinned)  (2.1s)
score 90/100 · verdict: caution · 11/12 checks ran
  ! parity: local code differs from the draft … → n8n-decanter push order-sync
  ⤷ skipped simulate: simulate not in the default profile — pass --full (or --offline) to add simulate
```

`--json` emits **one document** (an array when several workflows are targeted):
`workflow`, `id`, `profile`, `subject` (`draftVersionId`, `publishedVersionId`,
`parity`), `checks[]` (`id`, `tier`, `status`, `message`, `remediation`,
`durationMs`), `score`, `verdict`, and `coverage` (`ran`, `skipped[] {id,
reason, unlock}`). The stable ids + remediation strings are the agent contract —
teach an agent `preflight --json` as its one gate before `push`/`publish`.

## Safety contract

**`preflight` never mutates: no push, no publish, no restore, no draft write.**
Its only instance interactions are reads and the pinned draft `test` run.

- Unlike [`test`](/docs/cli/test/)'s terminal flow, `preflight` **never offers to
  push local code first** — a gate must not mutate what it gates, so `test` is
  always invoked in its never-mutate mode and CI/terminal behavior are
  identical. The `parity` check + its remediation cover the "but I wanted to test
  local" case (`push` first, or `--full` to `simulate` local).
- The `test` stage runs the **draft tip only**, external touchpoints pinned from
  the capture; a pin gap aborts before anything runs; the published version is
  untouched.
- The `simulate` stage runs headless in a throwaway container with
  **`--network-none` always on** and credentials stripped.
- The sync tier and auto-fetch are reads only; captures land in the
  self-gitignored `executions/` dir.

## Preflights — which one when?

`preflight` is the umbrella over the three individual preflights; reach for one
directly for a focused check, or `preflight` for the whole gate:

| | Where it runs | Reach for it when |
| --- | --- | --- |
| [check](/docs/cli/check/) | locally, static | one offline layout + type check |
| [simulate](/docs/cli/simulate/) | local engine (Docker) | one offline engine replay |
| [test](/docs/cli/test/) | your instance | one instance-side pinned run |
| **`preflight`** | all of the above, scored | the pre-publish gate — one command, one verdict |

Requirements match the checks it runs: the static tier needs nothing; the sync
and `test` tiers need the [MCP connection](/docs/cli/init/) and the workflow's
*Available in MCP* flag; `simulate` needs Docker; auto-fetch and the REST
`history` fallback need `N8N_API_KEY`. Anything unavailable is **skipped with an
unlock**, never a hard error — a workflow with zero captures still gets a
static+sync verdict, labeled as such.
