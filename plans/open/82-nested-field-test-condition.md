# Plan 82 — a field-test condition for the nested sync dir

**Status:** In progress — **the harness (tasks 1-6) is complete and verified
against a real staged round**; the plan stays open until a round has actually
been run and archived, which is what it exists for.
**Priority:** P2
**Source:** Falls out of [Plan 81](../done/81-nested-syncdir-agent-wiring.md):
the tool side of the nested layout is fixed and shipped (#273/#275/#276), but
**no round has ever measured what a blind agent does in that world** — the
harness cannot stage it.
**Snapshot:** 2026-08-18T14:40Z @ f9bbe66
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

## Notes

- No CHANGELOG entry: the field-test harness is dev-only tooling, not a
  user-facing surface.
- The first round run under this condition should be committed (raw + report)
  like every other round — an agentic round is expensive and irreproducible.
