# Plan 86 — `init` writes when it should have printed help, or refused

**Status:** Done
**Priority:** P1 — both defects are a handful of lines, offline, with the
correct behaviour already written elsewhere in the repo; one of them makes a
help request scaffold files into a directory the user never vetted.
**Source:** user field feedback 2026-09-02, report 1 ("Zwei echte Fußangeln"),
verified claim-by-claim against the code the same day. Same batch as
[Plan 87](87-auth-errors-point-the-wrong-way.md),
[Plan 88](../open/88-data-tables-stale-rows-and-refs.md),
[Plan 89](../open/89-rest-verbs-prerequisite-chain.md),
[Plan 90](../open/90-backup-source-instance-stamp.md) and
[Plan 91](../draft/91-guard-hint-for-credential-type-refusal.md). Task 2
finishes what [Plan 81](81-nested-syncdir-agent-wiring.md) started: 81
taught `loadConfig` to recognise a sync dir sitting *below* the cwd, but only
`loadConfig`.
**Snapshot:** 2026-09-02T04:57Z @ 3c5ee4d
**Model:** Sonnet — the design calls are made; both fixes have a precedent in
the codebase to copy.

`n8n-decanter init --help` does not print help — it runs `init`, because the
`--help` check only looks at argument slot 0. And `init` is the one verb with no
nested-sync-dir detection, so run from a repo root it scaffolds a second sync
dir on top of a working one. A user with the sync dir under `n8n/` in a larger
repo got config, template, `workflows/`, `shared/`, `tsconfig.json` and
`opencode.json` in the repo root, from a command they expected to be read-only.

## Why

`init` is the only verb that writes into a directory the user has not yet
vetted, and it is currently the verb with the *fewest* guards on the way in.
Both defects are about the same thing from two sides: an invocation the user
believed was safe performed a scaffold.

The second one stings extra because the detection already exists and is good.
`preflight` (via `loadConfig`) tells the user exactly the right thing:

> it is not missing — the sync dir sits BELOW the working directory … name the
> sync dir explicitly

The user quoted that message back as exemplary. It is one function call away
from `init`.

## Findings, as verified

1. **`--help` only works in argument slot 0.** `n8n-decanter.mts:319` reads
   `if (!command || command === "help" || args[0] === "--help")`. For
   `init --help`, `args[0]` is `"init"`, so the check misses and dispatch
   proceeds to the `init` branch.
2. **After slot 0, `--help` is not "unhandled" — it is silently discarded.**
   `positional` is `args.filter((a) => !a.startsWith("--"))`
   (`n8n-decanter.mts:236`), so `<verb> --help` is byte-indistinguishable from a
   bare `<verb>` by the time dispatch runs. There is **no per-verb help
   anywhere** in the CLI. On the read verbs that is merely noise; on `init` it
   is a write.
3. **`findConfigBelow` has exactly one caller.** It is defined at
   `lib/config.mts:130` and called at `lib/config.mts:221`, inside `loadConfig`'s
   "no config in reach" failure path. `lib/init.mts` never calls it. `init` also
   runs *before* `loadConfig` by design (`n8n-decanter.mts:336`: "must run before
   loadConfig: a fresh directory has no config/.env yet"), so it cannot inherit
   the check for free — it has to ask.

## Tasks

1. **Make `--help` win from any position.** Replace the slot-0 test at
   `n8n-decanter.mts:319` with `args.includes("--help")` (`-h` too, if it is
   free). It must be evaluated **before** the `init` branch at
   `n8n-decanter.mts:336`, and before any verb dispatch — the point is that no
   verb runs.
2. **`init` refuses (or asks) when a sync dir already sits below the target.**
   Call `findConfigBelow` on the resolved target directory at the top of
   `init()` (`lib/init.mts:560` area, before anything is written). On a hit:
   - non-interactive / flag-driven → **throw**, naming the found path and the
     `--dir=` form, mirroring `lib/config.mts:226-232` so the two messages read
     as one voice;
   - interactive → prompt ("a sync dir already exists at `<path>` — scaffold a
     second one here anyway?"), defaulting to no.
   `findConfigBelow` is depth- and time-capped already (`maxDepth = 3`,
   `maxDirs = 400`, `maxMs = 250`), so this costs nothing on a miss.
3. **Decide whether `init` should also refuse a target that is a git repo root
   with no `decanter.config.json` below it.** Probably not — that is the
   legitimate "sync dir is the repo" shape. Named here so the next reader knows
   it was considered and rejected, not overlooked.
4. **Per-verb help.** With task 1 in, `<verb> --help` prints the global usage,
   which is honest but not useful. Print the verb's own usage block instead —
   `usage()` (`n8n-decanter.mts:73-108`) already has one line per verb; scoping
   it is a formatting change, not new content. Lower priority than 1-3 and
   splittable into its own PR.

## Acceptance / verification

- `node n8n-decanter.mts init --help` in an **empty temp dir** prints usage and
  leaves the directory **empty** — assert on the directory listing, not just on
  stdout. This is the regression test that matters; the current code fails it.
- The same for every other verb: `<verb> --help` exits 0, prints usage, and
  makes no network call.
- `init` in a temp dir containing `sub/decanter.config.json`: non-interactive
  run exits non-zero, names `sub`, and writes nothing; piped-stdin interactive
  run declines by default.
- `init` in a clean temp dir is unchanged (the existing e2e bootstrap must not
  move).
- Drive it through the real CLI as a subprocess per the root `AGENTS.md`
  "Verifying changes at the CLI surface" recipe — task 1's whole point is
  argument parsing, which an imported function call would not exercise.

## What shipped

All four tasks, in one PR.

1. `--help`/`-h` is tested with `args.includes(…)` and answered **before** the
   namespace dispatch, the `init --dir` guard, the picker and every verb —
   earlier than the old slot-0 check sat, because `backup --help` used to die in
   the namespace branch ("unknown backup command") before reaching help at all.
   `__complete` is exempt: it is the completion scripts' hidden helper and lists
   `--help` among its own candidate words.
2. `refuseNestedSyncDir` in `lib/init.mts` runs before `mkdirSync`, so a refusal
   does not even create the target directory. Non-TTY and flag-driven runs throw;
   a terminal is asked and defaults to no. `findConfigBelow` is now exported for
   it (`lib/config.mts`), and its doc comment records the second caller.
3. Decided as the plan predicted: **no** refusal for a git-root target with no
   config below it. That is the legitimate "the sync dir is the repo" shape.
4. Per-verb help landed here rather than as a follow-up. `usage()` became a small
   section/entry data structure so the full listing and one verb's block render
   from one source and cannot drift; the scoped view carries only the notes its
   own lines earn (`<workflow>` resolution, the picker sentence for ref verbs,
   `<execution-id>`), and `init --help` prints why `--dir` is not its flag rather
   than the global `--dir` note it would otherwise advertise. `help <verb>` is
   the same question as `<verb> --help`.

Three e2e steps pin it, all through the real CLI as a subprocess:

- one loops **every** verb parsed out of the CLI's own `VERBS` set (`--help`,
  `-h` and `help <verb>` must agree, all exit 0) and asserts the mock server saw
  **zero** requests plus an untouched directory after `init <dir> --help`;
- one exercises the nested refusal piped and flag-driven, plus the two shapes
  that must stay allowed (re-init in place, init below an existing sync dir);
- one drives the **TTY branch on a real pty**, which is the only way to reach
  it — bare Enter declines, a non-yes answer declines, and `y` scaffolds the
  second sync dir for real while leaving the existing one alone. util-linux
  `script -qec … /dev/null` supplies the pty and no `expect` is involved; the
  step skips off Linux, where BSD `script` cannot take piped stdin. The recipe
  in the root `AGENTS.md` said to reach for `expect` and is corrected to this,
  including the trap that cost the most time: answers must be written **one
  prompt at a time**, because the guard's prompt session closes with its own
  question and a reader that is already gone takes any buffered lines with it.

## Notes

- **CHANGELOG:** `Fixed` — "`<verb> --help` now prints help instead of running
  the verb (`init --help` scaffolded a sync dir)"; `Added` — "`init` refuses to
  scaffold on top of a sync dir that already exists below the target".
- **Docs:** the `--help` fix is behaviour users will look up; check
  [docs/cli/overview.md](../../docs/cli/overview.md) and the `init` page for any
  sentence that implies per-verb help already works.
- **PLAN.md:** no data-model change; nothing to update unless task 4 lands a new
  help surface worth describing.
- Task 4 may be deferred without blocking the plan's close, if it is split into
  its own follow-up and recorded here.
