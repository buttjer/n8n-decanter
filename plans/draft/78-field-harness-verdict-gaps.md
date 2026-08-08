# Plan 78 — three harness gaps the first n=3 sweep exposed

**Status:** Draft
**Priority:** P1 (all three are small, offline, and each one silently corrupts a
round's evidence — the cheapest possible defects to leave in place)
**Source:** the triple sweep of 2026-08-08 (28 rounds, `ftrun-56329` …
`ftrun-86911`), archived in this same PR. Every finding here is a **harness**
defect; none is a product defect.
**Snapshot:** 2026-08-08T14:05Z @ 0da3fd3 *(reworked: findings 4 and 5 added
after the first `--n8n-tag` sweep — same shape, found the same way)*
**Model:** Sonnet — three well-specified mechanical fixes.

Running the same sweep three times turned two results that had been recorded as
facts into **variance**, and exposed five ways the harness loses, fakes or
overcharges for evidence: a failing `verify` writes no verdict at all,
`--container` spends a unit on a condition it cannot stage, one scenario's turn
names a workflow the seed pack makes ambiguous, the fenced credential is checked
nine times instead of once, and the archived manifest still carries a session
JWT. Most of them make a round read as *covered* when it was not — the exact
failure mode this harness keeps catching in itself.

## Why these are worth a P1

The sweep's headline is good: **25 of 25 mechanically graded scenario runs
passed with zero invariant violations**, and none of the three failures was the
product. But arriving at that sentence required reading console output that no
longer exists in two of the archives, because of finding 1. A round costs real
quota; evidence that silently doesn't survive archiving is the one bug class that
compounds.

## Findings

### 1. `verify` FAILs write no `verify-<S>.json` — the archive looks ungraded

When the verifier cannot resolve its scoped workflow (`no tracked workflow
folders under … matching <id>`), it reports `verify FAIL` **on the console** and
writes nothing. `run.mts` archives the round anyway, `report.html` renders no
verdict section, and the round is indistinguishable from S13, which declares
`verifyWorkflows: "none"` on purpose.

- **Reproduced live**, three times in one sweep (S3, S8, S14 in round A).
- **It explains the pre-existing archive too:** `ftrun-45973` (S8),
  `ftrun-89719` (S3), `ftrun-93801` (S10), `ftrun-93355` (S4) were all read as
  "no verdict, cause unknown" before this sweep. They are all this.

**Fix:** write the verdict file on every path, with `passed: false` and the
reason as a check. A round with no verdict file at all should make `run.mts`
exit non-zero and the report carry an explicit *ungraded* banner — a missing
verdict must never be quieter than a failing one.

### 2. `--container` spends a unit on S14, which it cannot stage

`FIELD_NO_SEED_ENV=1` removes the `.env` — but in container mode the `.env` is
exactly what gets rewritten to the in-network host
(`http://flows-ops-n8n-<id>:5678`). Without it the blind agent sees the host-side
`127.0.0.1:<ephemeral>` from the manifest, which does not resolve inside the
fence, and correctly reports connection refused.

The harness **already knows**: it prints `no … /.env — the agent's init must
supply the in-network host (avoid FIELD_NO_SEED_ENV in container mode)` — but
*after* the unit is spent, while S5/S6/S9 are dropped by name **before** any
spend.

**Fix:** give S14 the same up-front treatment as the host-only three —
`requiresSeedEnvOff` implies host-only under `--container`, named out loud in the
plan, dropped before the image build.

### 3. S8's turn 1 names a workflow the `wave2` pack makes ambiguous

Turn 1 says *"the weekly digest flow"*; `wave2` seeds both **Weekly digest
roll-up** (`realism`) and **Weekly revenue totals** (`s8-ladder`, the intended
target). `verifyWorkflows: ["s8-ladder"]` then fails when the agent picks the
other one — and the agent is not wrong, it answered truthfully for the workflow
it was asked about.

**Already fixed — PR #237, which sat open while every one of these sweeps ran.**
It names *"Weekly revenue totals"* outright in turn 1, does the same for S9, and
generalises the rule in `STYLE.md`: naming something the pack seeds is only half
of it, the name must also not fit anything *else* the pack seeds. Nothing here
proposes a fix; this entry exists to record what the sweeps added to it.

What they added is the **coin flip**, now on four data points instead of two.
#237 argues from `ftrun-45973` (wrong workflow) against `ftrun-38054` (right
one); sweep A picked wrong, and B, C and the 2.33.3 round all picked right from
the identical prompt. So the record this replaces — `a8dfa17`'s commit message
filing S8 as "a known scenario bug" — and the PASSes were never different
scenarios. They were the same one, resolved by chance.

**Leaving it unmerged through the series turned out to be the right accident.**
All five sweeps ran on byte-identical scenario files; merging mid-series would
have made S8 in rounds A–C incomparable with D and E, for a fix worth one unit.

### 4. `--container` checks its credential per unit, *after* staging

Found running the first `--n8n-tag` sweep (2026-08-08). `test/field-test/.env`
holds the Anthropic credential and is gitignored, so a **fresh worktree never
has one** — and container mode discovers that in `containerSetup`, which runs
*after* the unit's stage. The sweep booted and tore down **nine n8n instances to
print the same message nine times**, and only the raw Node stack made it legible.

The scenario-prerequisite gate already does this right ("prerequisites unmet —
nothing was spent", checked before the image build). The credential is not on
that path.

Sharper than a papercut, because **the repo's own worktree rule steers you into
it**: every repo-modifying task is supposed to run in a worktree, and a fresh
worktree cannot run a fenced sweep until someone copies an ignored file into it.

**Fix:** check the credential **once, before the first stage**, with the same
"nothing was spent" wording; say plainly that `.env` is gitignored and name the
copy. And catch a unit's failure into one readable line rather than letting an
`execFile` rejection print a stack per unit.

### 5. The archived manifest still ships an unredacted `ownerCookie`

`run.mts` builds its secrets list from `[mcpToken, apiKey]` and overwrites only
those two, so the n8n **owner session JWT travels into git verbatim** — 40 of the
64 archives before this round, and every one written since. The README states
secrets are scrubbed at archive time, so this is a contract violation rather than
a judgement call.

Practical risk is ~nil (a throwaway container on an ephemeral localhost port,
long expired). Fixing it is one line; leaving a public repo full of session JWTs
is not worth the argument.

**Fix:** add `ownerCookie` to the redaction, and re-pack the existing archives.

### 6. Finding 1 keeps costing, and the Opus round shows what it hides

The `--model opus` round (2026-08-08) produced the **first two FAILs the harness
has ever recorded on a round that was not itself broken** — and they landed on
opposite sides of finding 1:

- **S4 wrote a verdict** (`violations: 1`, the missing-file check), so the defect
  is legible from the archive alone.
- **S12 did not.** The console said `verify FAIL`; the archive says nothing.
  Diagnosing it needed the run's stdout, which lives in a scratch file that is
  not part of the round.

Two FAILs, one readable in six months and one not. That is the cost of finding 1
stated as cheaply as it will ever be stated, and it argues for fixing it before
the next model or version round rather than after.

## Tasks

1. `verify.mts` / `run.mts` — always emit a verdict file; missing verdict ⇒
   non-zero exit + an explicit banner in `report.html`.
2. `run.mts` — treat `requiresSeedEnvOff` as host-only under `--container`,
   refused before spend, listed by name in the `--dry-run` plan.
3. ~~`scenarios/S8.md` — disambiguate turn 1~~ — **done, PR #237.**
4. Backfill: re-render the four pre-existing no-verdict archives once task 1
   lands, so the archive stops carrying unexplained blanks.
5. `run.mts` — credential check once, before the first stage; one readable line
   per failed unit instead of a stack.
6. `run.mts` — redact `ownerCookie`; re-pack the archives that carry one.

## Acceptance

- A scenario whose verifier cannot resolve its scope produces a **`passed:
  false`** verdict file, and the sweep exits non-zero.
- `--isolate --all --container --dry-run` names S14 among the dropped host-only
  scenarios, and stages nothing for it.
- Three consecutive S8 rounds act on `s8-ladder` *(should already hold via #237
  — worth confirming on the next round rather than assuming)*.
- `--container` with no credential refuses **before the first stage**, booting
  nothing.
- No archived `manifest.json` contains an `n8n-auth=` JWT.

## Notes

- **No `CHANGELOG.md` entry** — dev-harness only, nothing user-facing.
- Deliberately **not fixed inside the sweep**: A, B and C had to run on identical
  code for the quota to mean anything. The findings were recorded and the code
  left alone.
- Related: [Plan 62](../done/62-field-test-unrun-conditions.md) found the same
  shape twice before (a staging flag that silently stopped staging its
  condition). Finding 2 is a third instance, and finding 1 is that shape applied
  to the *verdict* rather than the *condition*.
