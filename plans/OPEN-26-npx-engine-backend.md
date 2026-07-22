# Plan 26 — npx engine backend for `simulate` (Docker-free)

**Priority:** P3 (accessibility win; a follow-up to [Plan 7](DONE-7-engine-true-simulation-suite.md), which shipped Docker-only)
**Status:** Not started
**Theme:** A dependency-free **`npx n8n@<ver>`** engine backend so `simulate`
runs without Docker — using the Node the CLI already requires. The headless
diff run is npx's natural home; the browsable viewer stays Docker-preferred.

## Why

[Plan 7](DONE-7-engine-true-simulation-suite.md) shipped `simulate` with a
**Docker-only** engine backend — so today `simulate` needs a running Docker
daemon. Plan 7 always *intended* npx to be the default (Docker the opt-in
hard-isolation mode); it shipped Docker first because that's what got validated
end-to-end.

npx removes the one heavy prerequisite: `npx n8n@<ver>` runs the same engine on
the Node the CLI already needs (≥ 22.18), so `simulate` would "just work"
wherever the CLI runs — laptops without Docker Desktop, locked-down machines, CI
runners where Docker-in-Docker is painful. That's exactly the tool's
agent/CI audience, so it's a real adoption lever. **The run is engine-true
either way — this is about *reach*, not correctness.**

## Source

- [Plan 7](DONE-7-engine-true-simulation-suite.md) "Design decision — the
  engine": npx was the intended default, split out here so Plan 7 can close on
  the shipped Docker backend.
- [Plan 15](DONE-15-docker-n8n-smoke-suite.md) / the Plan 7 spike: the
  `import:workflow` + `execute --rawOutput` route-B flow the npx backend reuses.

## Design decisions (carried from Plan 7)

- **`npx n8n@<ver>`** with `N8N_USER_FOLDER` in a scratch dir — throwaway
  SQLite/config, per-run version pinning via the `@<ver>` tag (the same
  `n8nVersion` config Plan 7 added), keeps n8n out of decanter's own dep tree.
- **Safety without a network cutoff.** npx's no-side-effects guarantee is
  *structural* (no I/O-capable node survives the transform) plus *sandbox
  config* (empty task-runner stdlib allowlist, telemetry/version/template
  fetches disabled via env) — **not** a physical cutoff. Docker's
  `--network none` (Plan 7 task 4) stays the only *enforced* isolation, so it
  remains the opt-in hard mode.
- **Viewer lifecycle is the hard part (not the webview itself).** `npx n8n
  start` serves the same editor UI as Docker — npx *can* have a webview. The
  catch is keeping it alive across CLI invocations: a kept-alive `npx n8n
  start` is a **host daemon** (detached `spawn(..., {detached:true}).unref()` +
  a PID/lockfile to reap+replace + free-port selection), messier and more
  orphan-prone than Docker's named detached container (`docker rm -f
  decanter-sim-viewer`). **Decision:** the viewer stays **Docker-preferred**;
  with only npx available, degrade gracefully — run the headless diff + exit
  code and **skip the URL** with a one-line note. A daemonized npx viewer is a
  stretch goal, not a blocker.

## Tasks

1. **Spike (timeboxed).** Probe `npx n8n@<ver>` against the Plan 7 route-B flow:
   install weight + first-boot cost (native sqlite, migrations), whether
   `import:workflow` + `execute --id --rawOutput` works the same, task-runner
   behavior (JS runner; `fetch` reachability), and warm wall time vs Docker.
   Record findings here. Checkpoint: parity with the Docker backend's output
   shape and a warm run in a reasonable budget.
2. **`lib/engine.mts` — npx backend.** Add an npx variant of `runEngine`
   (scratch `N8N_USER_FOLDER`, `import` + `execute --rawOutput`, parse the same
   result JSON into the existing `runData` map) behind the current
   `EngineOptions`. No change to `runSimulation`'s diff.
3. **Backend selection + default policy.** A backend setting (config/flag);
   **Docker stays the default until npx is validated**, then flip the default to
   npx with Docker as the `--network-none`/opt-in hard mode (Plan 7's intent).
4. **Isolation env for npx** (Plan 7 task 4's npx half): scrubbed env (no
   `N8N_*` leak), diagnostics/notification/template fetches off, empty
   task-runner stdlib allowlist.
5. **`test:sim` over both backends.** Parametrize the opt-in suite: run npx when
   available, Docker when available, each skipping cleanly when its engine
   isn't. Keep it out of `npm test` (Plan 22).
6. **Viewer story.** Keep the viewer Docker-preferred per the decision above;
   when only npx is present, skip the URL with a note (or, stretch, a
   daemonized `npx n8n start`).
7. **Docs + CHANGELOG.** The backend config/flag and the "no Docker needed"
   story are user-facing — docs page(s) + `[Unreleased]` entry when it lands.

## Acceptance / verification

- `simulate` runs headless via **npx with no Docker daemon**, and its diff +
  exit code match the Docker backend on the same capture.
- `test:sim` covers both backends and skips cleanly when either engine is
  absent; `npm test` stays green with neither installed.
- The viewer behavior with only npx present is documented (URL skipped or
  daemonized), and never leaves an orphaned host process silently.

## Non-goals

- Replacing Docker's enforced `--network none` — npx can't offer a physical
  cutoff; that stays Docker's job.
- A full daemonized npx viewer, unless the lifecycle story turns out cheap;
  Docker remains the viewer's happy path.

## Notes

- **Post-Plan-32 review (2026-07-22): unaffected by the MCP pivot** —
  `simulate` boots its own throwaway engine and never touches the sync
  backend. [Plan 33](BLOCKED-33-post-mcp-pivot-wave.md) Task 6 decided
  `simulate` stays as a differentiator (the new instance-side `test` verb
  becomes the recommended default), which *strengthens* this plan's case: npx
  drops `simulate`'s one heavy dependency. This plan stays independent of the
  Plan 33 wave.
- **CHANGELOG:** the npx backend + backend-selection config/flag are
  user-facing — Added/Changed under `[Unreleased]` when they land.
- Relationship: this unblocks Plan 7 closing on the Docker backend; Plan 7's
  gap-handling (task 6) is independent of which backend runs.
