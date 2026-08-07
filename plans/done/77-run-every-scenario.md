# Plan 77 — run every scenario, every time

**Status:** Done — shipped 2026-08-07
**Priority:** P2
**Source:** maintainer, 2026-08-07: *"ich will in Zukunft alle Szenarien ständig
ausführen"* — stated as an obvious standing intent, after I had assumed S9/S10
were occasional and recommended leaving two gaps unbuilt on that basis.
**Snapshot:** 2026-08-07T12:36Z @ e349dd0
**Model:** Sonnet — small, mechanical.

The blind field test is only worth its cost if it runs. Fourteen scenarios
existed and there was **no way to ask for all of them**: `run.mts`'s default was
a hardcoded `["S1","S2","S3","S4"]` left over from Plan 35's original four.

## What was actually in the way (and what wasn't)

**Isolation was never the obstacle** — `--isolate` already stages a fresh n8n
plus a fresh scratch project per unit and tears it down after. That is the whole
design. Three smaller things were:

1. **No `--all` selector.**
2. **`--seeds` was one global value.** S8/S9 need `wave2`'s kinds and S7/S10/S12
   the corpus ones, so they could not be named in one command — even though
   `--isolate` re-execs `stage.mts` **per unit** and could always have given each
   unit its own pack. No all-encompassing mega-pack was needed; that was a wrong
   turn in the first analysis.
3. **Stage *shape* was global too**, and this one only surfaced once the dry-run
   printed the plan: S6 needs `FIELD_NO_CLI=1`, S14 `FIELD_NO_SEED_ENV=1`. As
   env vars for the whole run they would either be missing (the prerequisite gate
   refuses the scenario) or applied to **every other unit** — which is worse.

## What shipped

- **`--isolate --all`** — every `S*.md`, numerically ordered, grouped into units
  by the existing `requires` chain (14 scenarios → 13 units; S2+S4 share).
- **Per-unit seed pack**, chosen as the *smallest* pack covering that unit's
  `requiresSeedKinds`, so an ordinary scenario still gets `builtin` and does not
  pay for a corpus fetch. `stage.mts --list-packs` is the oracle — the pack
  contents stay defined where the packs are, rather than duplicated into
  `run.mts` for it to drift from. `--seeds <pack>` still pins everything.
- **Per-unit stage shape** — `FIELD_NO_CLI` / `FIELD_NO_SEED_ENV` derived from
  the scenario's own declaration and set for that one stage.
- **`--isolate --dry-run` boots nothing.** It prints the plan — unit, pack, turn
  count, host-only, pre-hook, required flags — and exits. Passing `--dry-run`
  through to the children (the old behaviour) staged thirteen instances to answer
  *"what would you run?"*.
- **`--all --container` drops the host-only scenarios by name, out loud**, and
  prints the command to run them separately. A silent skip that reads as
  "covered" is the exact failure this harness keeps finding in itself.
- Unit test: every declared seed kind is seeded by *some* pack, checked against
  the same `--list-packs` oracle — so a kind no pack provides fails offline
  instead of at sweep time.

```
$ node test/field-test/run.mts --isolate --all --dry-run
isolating 14 scenario(s) into 13 unit(s): …
   1. S1       seeds builtin    3 turn(s)
   2. S2+S4    seeds builtin    6 turn(s)
   3. S3       seeds builtin    2 turn(s)  — preHook remote-drift
   4. S5       seeds builtin    2 turn(s)  — host-only
   5. S6       seeds builtin    3 turn(s)  — host-only, needs FIELD_NO_CLI=1
   …
  13. S14      seeds builtin    3 turn(s)  — needs FIELD_NO_SEED_ENV=1

dry run: nothing staged, nothing spent. Drop --dry-run to execute.
```

## Cost, honestly

~13 units × 5–12 min ≈ **1.5–2.5 h wall clock**, ~38 Sonnet turns. Still **not a
CI gate** (Plan 35's standing rule: cost + nondeterminism) — this is a
pre-release ritual you start and walk away from. Each unit archives on its own,
so a failure late in the sweep never costs the earlier units' evidence.

## What routine execution now makes worth building

Recorded, not built here — with the reason they matter *at cadence*, which is
what changed:

- **The two unstaged S9 beats** (a deliberate type error, `$vars`). A beat that
  is written but not staged is a note when it is read once and a **standing
  false claim** when it runs weekly. Both need seed changes.
- **The `backup restore` comparison in `verify.mts`** (Plan 61 task 9, left
  unbuilt because the verifier cannot tell which instance workflow is the
  restore). With S10 in every sweep, a silent restore failure — the most
  expensive case in the tool — goes ungraded every time.

## Non-goals

- Not a CI job. Not a scheduler. `--all` is a command you run.
- Not grading automation: `verify.mts` gives the mechanical verdict, the
  transcript read stays human/Opus.
