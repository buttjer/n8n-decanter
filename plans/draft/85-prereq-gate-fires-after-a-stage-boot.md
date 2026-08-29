# Plan 85 — the scenario-prerequisite gate fires one stage boot too late

**Status:** Draft
**Priority:** P3
**Source:** Observed while running `--isolate S4` for
[Plan 84](../done/84-generated-node-header.md)'s field round (2026-08-29).
Same bug *shape* as the credential pre-flight already fixed in
[Plan 78](../done/78-field-harness-verdict-gaps.md) finding 4 — which named this
very gate as the standard it was matching.
**Snapshot:** 2026-08-29T14:12Z @ 1cbf788
**Model:** Haiku — the change is a hoist, and the hard thinking is already
recorded below.

`node test/field-test/run.mts --isolate S4` boots a throwaway n8n, *then*
discovers that S4 requires S2, refuses, and tears the instance down again. The
check reads scenario files only — it needs no stage to answer — and `run.mts`'s
own comments say a gate that fires unmet should cost nothing. Hoist the ordering
half next to the credential pre-flight and the boot goes away.

## Why

**The refusal itself is correct and must stay.** `4a8bb1a` settled that:
*"Refusing beats auto-including the prerequisite, which would silently double
the spend."* This note is **not** a request to auto-expand the `requires` chain
— that is the rejected alternative, and re-proposing it would undo a deliberate
call. `--isolate --all` already groups `S2+S4` into one unit correctly. Only the
explicit-subset case pays for the mistake.

**What is actually wrong is placement.** In the `--isolate` loop
(`test/field-test/run.mts:236`), `stage.mts` is `execFile`d — booting n8n,
provisioning it, packing and installing the CLI — and only the *child* spawned
on the next line calls `assertPrerequisites`. So the gate runs after the
expensive part, not before it.

**The same shape was already fixed 30 lines above, citing this gate.** The
credential pre-flight at `run.mts:200` carries this comment:

> `containerSetup` checks this per unit, after that unit has already booted an
> n8n. A sweep with no credential therefore boots and tears down one instance
> per unit to print the same message that many times — nine, the first time
> this was run. […] **Same contract as the scenario-prerequisite gate: unmet
> means nothing is spent.**

That contract is exactly what the prerequisite gate no longer meets in
`--isolate`. The credential check was hoisted to run once before the first
stage; this one never was.

**`--dry-run` cannot warn you either.** The `--isolate --dry-run` branch prints
the plan and `process.exit(0)`s at `run.mts:195`, before any prerequisite
checking. So `--isolate S4 --dry-run` reports a valid-looking 1-unit, 3-turn
plan for a round that cannot execute — and the dry-run's whole purpose is
showing you a plan you can pay for.

## Scope

1. **Split `assertPrerequisites` (`run.mts:585`).** The ordering loop (`for
   const need of sc.requires ?? []` — does every prerequisite appear earlier in
   the list?) reads only `ids` and `loadScenario`: **no manifest, no stage**.
   The remaining checks (`requiresNoCli` vs `manifest.noCli`, `requiresNested`,
   `requiresSeedEnvOff`, `requiresWorktree`, `requiresSeedKinds`, and the
   `containerMode` refusals) genuinely need the manifest and stay where they
   are.
2. **Call the manifest-free half in the `--isolate` pre-flight**, beside the
   credential check at `run.mts:206` — once, before the first `stage.mts`
   spawn. Per unit, not per requested id: `groupScenarios` has already
   partitioned them, and a unit is exactly the list whose order matters.
3. **Call it in the `--dry-run` branch too** (`run.mts:181`), so a plan that
   cannot run is refused at $0 and zero seconds instead of being printed as if
   it were payable.
4. **Keep the message and the `try:` suggestion byte-identical** — it is good,
   it names the fix, and `4a8bb1a` tuned it deliberately.

## Verification

- `node test/field-test/run.mts --isolate S4` refuses **without** `docker ps`
  ever showing a container for it, and with no `stage …` / `torn down …` lines.
- `node test/field-test/run.mts --isolate S4 --dry-run` refuses with the same
  message instead of printing a 1-unit plan.
- Unchanged: `--isolate S2 S4` runs (one `S2+S4` unit), `--isolate --all`
  still plans 16 units, and the non-isolate `run.mts <manifest> S2 S4` path
  behaves exactly as before.
- `test/unit/field-scenarios.test.mts` only checks that `requires` names
  resolve to real scenarios; the gate's *placement* has no test. A unit test is
  awkward here (the logic sits in a top-level `if (argv.includes("--isolate"))`
  block, not an exported function) — extracting the ordering check into an
  exported helper is what makes it testable, and is worth doing as part of
  task 1.

## Non-goals

- **No auto-expansion of the `requires` chain.** See Why — explicitly rejected.
- No change to the refusal wording, exit codes, or `assertIsolation`.
- Not a correctness bug in any round that has run: every archived round was
  either well-formed or refused. The cost is one wasted boot/teardown cycle and
  a `--dry-run` that over-promises.
