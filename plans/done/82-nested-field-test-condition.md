# Plan 82 — a field-test condition for the nested sync dir

**Status:** Done — harness complete (tasks 1-9), and the condition has been
measured: round 3 (`ftrun-468939`) is a valid S16 round, archived and committed.
The product finding it surfaced is carried forward as
[Plan 83](./83-missing-tools-nested-diagnosis.md).
**Priority:** P2
**Source:** Falls out of [Plan 81](../done/81-nested-syncdir-agent-wiring.md):
the tool side of the nested layout is fixed and shipped (#273/#275/#276), but
**no round has ever measured what a blind agent does in that world** — the
harness cannot stage it.
**Snapshot:** 2026-08-18T15:30Z @ 977d84e
**Model:** Sonnet — the design calls are made here; what remains is careful
breadth across the harness.

Every field-test round to date has staged exactly one world: the sync dir **is**
the agent's project root. That is the shape where the scaffolded wiring always
worked, so a round can neither reproduce the reported failure nor grade the fix.
This plan adds `FIELD_NESTED=1` — the sync dir as a subfolder of an ordinary
application repo, blind session launched at the **repo root** — plus scenario
**S16**, which measures the route an agent takes when the wiring below it is
invisible.

## Why

The user report behind Plan 81 was not "the CLI is broken" — every hand-run
command worked. It was **"my agent doesn't see any of this"**, and that is
exactly the class of finding the blind field test exists to catch. It went
unnoticed for as long as it did because the harness never built that world.

- [`stage.mts`](../../test/field-test/stage.mts) creates a flat
  `flows-ops-<pid>` under a per-run parent, and
  [`run.mts`](../../test/field-test/run.mts) launches the blind session inside
  it — sync dir == launch dir, always.
- Plan 81 shipped `--dir` / `N8N_DECANTER_DIR`, self-locating hooks, and an
  `init` note that prints two working shapes. **Whether any of that reaches an
  agent in the moment it matters is unmeasured.** The note in particular is
  printed once, at `init` time, in a session that then restarts — the easiest
  thing in the world to print into the void.

## Design decisions

- **One repo, not two.** The reported case is a sync dir inside a bigger repo,
  so `git init` moves to the **repo root** and the sync dir is simply a folder in
  it. The CLI's auto-commit keeps working (it runs `git` from the sync dir, which
  is inside the repo). Nesting a second repo would be a different, rarer shape
  and would quietly change what `pull`/`push` commit against.
- **The outer repo must look ordinary and carry NO decanter wiring** — no
  `.mcp.json`, no `.claude/settings.json`, no `decanter.config.json`, no `.env`.
  Planting any of it answers the question the round exists to ask.
- **Two deliberate omissions in the outer `package.json`:** no `workspaces` key
  (it would move where `npm install` puts `node_modules`, confounding
  discoverability with a packaging quirk) and no `tsconfig.json` (both
  `scripts/typecheck.mts` and the sync-dir upward search find that file **by
  name**, so one at the root would silently become the node files' config).
- **`workDir` keeps meaning THE SYNC DIR** in both shapes; the new `launchDir`
  says where the blind session starts. Every existing consumer — verify, report,
  teardown, the credential checks — then keeps working untouched, and archived
  rounds stay comparable.
- **Host mode only**, like `FIELD_NO_CLI=1`: container mode bind-mounts the work
  dir at `/work` and shadows `/work/node_modules`, both of which assume
  sync dir == launch dir.
- **The unset path must stay byte-identical.** This is an added condition, not a
  redesign — otherwise every archived round loses its comparability.

## Tasks

1. **`FIELD_NESTED=1` in `stage.mts`** — build the outer app repo, put the sync
   dir inside it, move `git init` to the root, commit the outer files first so
   the history reads like a real project. *(Partially landed by the interrupted
   build: the env-var docs, `writeOuterAppRepo`, the teardown handling and the
   widened `scaffold()` signature exist; the branch inside `scaffold()` itself
   does not, and `npm run typecheck` currently fails on exactly that.)*
2. **Manifest:** add `nested` and `launchDir`. Teardown removes the outermost
   dir; keep the existing guarantee that it can never take the tmp root with it.
3. **`run.mts`:** launch the blind session in `launchDir` (falling back to
   `workDir` for older manifests), keep the PATH prepend pointed at the **sync
   dir's** `node_modules/.bin` and say so in the printed `PATH policy`, and
   refuse S16 unless the manifest is `nested` — the same pairing guard S6 has
   against `noCli`.
4. **Credential guards stay meaningful:** the checks asserting no `.env` /
   `.decanter-auth.json` in the agent's reach must keep covering the sync dir and
   additionally cover the repo root (a credential at the launch dir would be a
   worse leak, not a lesser one).
5. **Scenario `S16.md`** — persona: a developer whose team keeps the workflow
   sync dir as a subfolder of the application repo, who opens their agent at the
   repo root because that is where the code is, and wants one Code node changed.
   **The text must not name `--dir`, `N8N_DECANTER_DIR`, or the `init` note** —
   naming the answer is not measuring it.
6. **`test/field-test/README.md`** — the new flag beside `FIELD_NO_CLI=1`, the
   world it builds, and the S16 pairing.
7. **Shadow the ambient install in ordinary host mode** (found by round 1, see
   below): prepending the staged `node_modules/.bin` does not stop `npx` from
   resolving a globally installed `n8n-decanter`, so a round can silently grade
   the *published* CLI instead of the build under test. Reuse `sanitizedPath()`
   — already there for `noCli` / `FIELD_NO_PATH_HELP` — then prepend the staged
   bin, so bare and `npx` invocations both hit the right binary.
   **Two corrections from doing it:** shadowing alone does NOT suffice — `npx`
   then fetches the published build from the registry, and it prefers its own
   `_npx` cache besides (verified: the cache held a published copy with no
   nested branch). What works is a harness-owned npm **prefix** whose global
   install IS the staged build — symlinks, no packing, no network — so npm's
   lookup ends before cache or registry. And it is **narrower than first
   written**: a flat round is fine, since the agent stands in the sync dir and
   `npx` finds the local package. Only the launch-dir-without-the-package case —
   this condition — was contaminated.
8. **Never let a second round overwrite the first's archive.** The path derives
   from stage timestamp + run id, so two rounds against one stage collide, and
   the newer one silently replaces committed, irreproducible evidence.
9. **Refuse a live re-run against a stage that already ran the scenario.** The
   second agent arrives at finished work and the round reports a PASS it did not
   earn. `FIELD_REUSE_STAGE=1` stays as the deliberate override.

## What the round measures

- Does the agent notice the decanter wiring below it at all?
- With the `n8n-instance` tools absent, does it take a route that keeps code in
  files — start in the sync dir, or wire the root — or does it **bypass to raw
  n8n MCP and edit `jsCode` inline**, the failure this product exists to prevent?
- Does Plan 81's `init` note actually reach anyone, or is it printed at a moment
  nobody reads?

## Acceptance / verification

- `FIELD_NESTED` unset → staging and running are byte-identical to today.
- With it set: the repo root holds no wiring, `.mcp.json` and
  `.claude/settings.json` exist only in the sync dir, and the blind session's cwd
  is the repo root.
- `run.mts` refuses `S16` against a non-nested manifest, naming the missing flag.
- `npm run lint`, `npm run typecheck`, `node --test test/unit/field-*.test.mts`
  green. A real round is a separate, deliberate act — it costs API calls and
  archives to `test/field-test/runs/`.

## Round 1 — `ftrun-441347` (2026-08-18, sonnet, n8n 2.30.7): verify PASS, and one harness finding

Archived at
[`test/field-test/runs/2026-08-18T14-33-18Z-ftrun-441347/`](../../test/field-test/runs/2026-08-18T14-33-18Z-ftrun-441347).

**The condition staged correctly and the agent passed.** Turn 1 opened with
`ToolSearch: n8n workflow` returning nothing — the guarded `n8n-instance` server
genuinely did not exist for a session started at the repo root, which is the
whole point. The agent then found the project below it (`find … -maxdepth 3`),
read `flows/CLAUDE.md` + `AGENTS.md` + `decanter.config.json`, and worked
**through the CLI, in files**: `pull`, edit, `preflight --offline`, `push`,
`test`, `diff`. No raw-MCP `jsCode` write. Verify: 0 violations, remote code
byte-equal to the local file, `.decanter.json` touched only by decanter.

**But the round did NOT measure the code under test, and that is a harness bug.**
The agent drove the CLI as `npx n8n-decanter …`, and **`npx` resolved the
maintainer's ambient GLOBAL install** — the published 0.10.1, without
[Plan 81](../done/81-nested-syncdir-agent-wiring.md)'s changes — not the packed
local build the stage installs. Reproduced directly:

```
$ cd <repoRoot> && ./flows/node_modules/.bin/n8n-decanter list --remote
✗ decanter.config.json not found (searched from <repoRoot> upward)
  it is not missing — the sync dir sits BELOW the working directory: <repoRoot>/flows
  n8n-decanter <verb> --dir=flows …

$ cd <repoRoot> && npx n8n-decanter list --remote
✗ decanter.config.json not found (searched from <repoRoot> upward)     ← one line: the OLD build
```

Host mode only *prepends* the sync dir's `node_modules/.bin`; `npx` does not
honour that prepend. So:

- **What this round tells us is still real** — an agent in this layout finds the
  project and keeps code in files, and it recovered on its own (`pwd`, then
  `cd flows && …`). It did that against the **old** single-line error, which is
  a mildly encouraging finding in its own right.
- **What it cannot tell us** is whether the new guidance helps: the agent never
  saw it. That question is still open.
- **Every `npx`-driven round is potentially contaminated the same way** — this is
  not specific to the nested condition. `run.mts` already has `sanitizedPath()`
  (it shadows ambient installs and points `npm_config_prefix` at an empty dir)
  but uses it only for `noCli` / `FIELD_NO_PATH_HELP`.

**Follow-up (task 7):** in ordinary host mode, shadow the ambient install the way
those conditions do and *then* prepend the staged bin, so both `n8n-decanter` and
`npx n8n-decanter` resolve to the build under test — then re-run S16.

## Round 2 — `ftrun-441347-r2`: **INVALID (stage reuse)**, kept as evidence

Re-run of S16 against the **same stage**, to re-measure it against the fixed CLI.
It is not a measurement: round 1 had already done the work, so the agent arrived
to a written file, a pushed workflow and a git history that already contained
the change. It made **zero writes and no push** (`git log` unchanged), read the
tidy world, and the harness reported a clean `verify PASS` for round 1's work.
Archived as `…-r2-INVALID-stage-reuse` so the name carries the warning; it is
evidence about the trap, not about the product.

Two harness gaps, both now closed (tasks 8 + 9):

- **The archive path collided.** It derives from the stage timestamp + run id, so
  round 2 silently **overwrote round 1's committed `raw.tgz` + `report.html`** —
  the exact evidence a round exists to leave behind. A second live round now
  takes `-r2`, `-r3`, …; a `--archive` re-render keeps the original identity on
  purpose (same round, re-rendered).
- **Nothing refused the re-run.** `groupScenarios` already keeps *different*
  scenarios off one stage, for precisely this reason; the same scenario twice was
  the hole. A live round against a stage that already ran the scenario is now
  refused before anything is spent, with `FIELD_REUSE_STAGE=1` as the deliberate
  override.

## Round 3 — `ftrun-468939` (2026-08-18, sonnet, n8n 2.30.7): the valid measurement

Fresh stage, fixed PATH, so the agent genuinely ran **this** working copy. Verify
PASS: file written, `preflight --offline`, `node run` against a fixture, `push`,
`test` — 0 violations, remote byte-equal to the local `.js`, change committed.

**The headline: the new `--dir` guidance was never needed.** Not once in either
valid round did the agent hit the "sits BELOW" error — it oriented first
(`ls`, `.mcp.json`, `CLAUDE.md` → `AGENTS.md`), then `cd`'d into the sync dir and
worked from there. **Agents take Option A on their own**, which is exactly what
the `init` note now recommends. The override is the safety net for a *configured*
root entry, not the path an agent stumbles onto.

**The finding worth acting on: the agent misdiagnosed the cause.** It noticed the
`n8n-instance` tools were missing and explained it — from our own `AGENTS.md` —
as "`init` must have run in an earlier session; MCP servers are wired at session
startup". Plausible, taught by us, and **wrong here**: in a nested layout no
restart will ever produce those tools, because the wiring is below the launch
dir. The agent shrugged it off ("it turned out not to matter") and used the CLI
instead, so the round still passed — but a less lucky agent follows that advice
into a loop. **Follow-up: the missing-tools guidance must name the nested
possibility beside the restart one** (drafted as Plan 83).

Second, smaller observation from the same answer: it expected `pull` to need the
workflow pre-registered in `decanter.config.json`'s `workflows` array and was
surprised that name resolution against the live instance worked anyway. Not a
defect — a docs nuance.

## Notes

- No CHANGELOG entry: the field-test harness is dev-only tooling, not a
  user-facing surface.
- Rounds committed (raw + report): `ftrun-441347` (round 1, graded published
  code — see its caveat), `…-441347-r2-INVALID-stage-reuse` (kept only as
  evidence of the trap), and `ftrun-468939` (round 3, the valid measurement).
