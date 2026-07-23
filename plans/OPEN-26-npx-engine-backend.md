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

**Sharpened by the shipped `test` verb (2026-07-23).** The generic "no Docker"
adoption story is now *partly* served by `test` (instance-side, no Docker — but
it needs a live instance, the per-workflow "Available in MCP" opt-in, and code
committed to the draft). So npx's distinct value is making `simulate`'s
**offline** differentiators dependency-free: verifying **uncommitted** local
code pre-push, running in **CI with no instance/credentials**, `--network-none`
isolation, and engine-**version rehearsal**. Two surfaces already offer
`simulate` unconditionally and dead-end without Docker today, which is extra
motivation for the default flip: the interactive picker lists `simulate` in
`PICKER_VERBS` with no engine gate (the Docker hard-error only fires *after*
selection), and the scaffolded Claude allowlist pre-approves
`n8n-decanter simulate` in every synced dir (#107) — so a Docker-less agent
machine hits the hard error on a pre-approved command.

**Also a `preflight` consumer (Plan 36 merged, #117).** `preflight`
runs `simulate` under its `--full` and `--offline` profiles — and
`preflight --offline` is explicitly *"air-gapped CI, no instance contact at
all."* Without Docker that profile can't run today; the npx backend is what
makes the whole read-only gate genuinely dependency-free, which is `preflight`'s
whole point as the CI gate. Add `preflight --offline`/`--full` to the "surfaces
that dead-end without Docker" list.

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
  config* (telemetry/version/template fetches disabled via env) — **not** a
  physical cutoff. Docker's `--network none` (Plan 7 task 4) stays the only
  *enforced* isolation, so it remains the opt-in hard mode.
  - **Correction (2026-07-23): the "empty task-runner stdlib allowlist" is
    net-new work, not a port.** The shipped Docker backend's `isolationEnv()`
    (`lib/engine.mts`) empties only the **external** module allowlist
    (`NODE_FUNCTION_ALLOW_EXTERNAL=`) — there is **no** builtin/stdlib
    allowlist knob set anywhere (no `NODE_FUNCTION_ALLOW_BUILTIN`). Docker's
    container boundary compensates for open builtins; a **host npx process has
    no such boundary**, so `fs`/`child_process` reachability from a Code node
    is exactly what the npx isolation env must actually close. The spike
    (Task 1) must verify which env vars n8n's task runner honors for builtins.
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
   **The seam to plug into:** `simulate` today hard-errors without Docker via
   `dockerAvailable()` before the run (`n8n-decanter.mts` /
   `lib/engine.mts`) — that check is exactly where backend selection routes
   npx-vs-Docker. Note `runSimulation`'s signature evolved with Plan 37
   (`{ version, source: 'capture'|'scenario', networkNone, viewer }`) and
   handles synthetic-pin scenarios + tier-2 loops — **none of that is
   backend-aware**, so the npx backend only needs `runEngine` parity.
4. **Isolation env for npx** — the **builtin/stdlib** cutoff is the load-bearing
   half here (see the corrected design decision): scrubbed env (no `N8N_*`
   leak), diagnostics/notification/template fetches off, and — the net-new
   part — actually close `fs`/`child_process` reachability for a host process
   that has no container boundary. Spike-verify the exact env var(s) n8n's task
   runner honors for builtins.
5. **`test:sim` over both backends.** Parametrize the opt-in suite: run npx when
   available, Docker when available, each skipping cleanly when its engine
   isn't. Keep it out of `npm test` (Plan 22). **Two of the suite's steps still
   need Docker even on the npx leg** — the **capture-server boot**
   (`test/sim.mts` boots an n8n in Docker to record captures) and the
   **viewer step** (`runSimulation(..., { viewer: true })` logs into a
   kept-alive container). Give the capture half an npx path (or seed from a
   committed `scenarios/` set), and **exclude the viewer step + its
   `VIEWER_CONTAINER` teardown on the npx leg** (viewer stays Docker-preferred).
6. **Viewer story.** Keep the viewer Docker-preferred per the decision above;
   when only npx is present, skip the URL with a note (or, stretch, a
   daemonized `npx n8n start`). The viewer is now automatic on interactive TTYs
   (`viewer = isTTY && !json && !networkNone`, no flag) — the npx "skip the URL"
   degradation slots in there; the Docker teardown hint
   (`docker rm -f decanter-sim-viewer`) is user-documented, so a daemonized npx
   viewer would need an equivalent teardown story.
7. **Docs + CHANGELOG.** The backend config/flag and the "no Docker needed"
   story are user-facing. **The "needs Docker" claim is spread across many
   surfaces to update when npx lands:** `docs/cli/simulate.md`,
   `docs/cli/overview.md` (offline table + "simulate needs Docker but never the
   n8n instance"), `docs/cli/test.md` (taxonomy table), `README.md` (feature
   bullet + compare cell), `template/AGENTS.md.example` (runtime-checks section
   **and** the scenario-loop "fast, no Docker" contrasts), and
   `docs/cli/scenario.md` (whose "`scenario check` is offline, no Docker
   needed" contrast weakens once `simulate` itself is Docker-free) —
   plus `[Unreleased]`.

## Acceptance / verification

- `simulate` runs headless via **npx with no Docker daemon**, and its diff +
  exit code match the Docker backend on the same capture **or scenario**.
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
  backend. [Plan 33](DONE-33-post-mcp-pivot-wave.md) Task 6 decided
  `simulate` stays as a differentiator with the instance-side `test` verb as
  the recommended default. **Both shipped and are documented** (2026-07-23):
  `test` is live (`lib/testrun.mts`), `docs/cli/simulate.md` opens with
  "reach for `test` first" and enumerates `simulate`'s offline differentiators.
  That *strengthens* this plan's case — with `test` now covering the
  instance-side runtime check, npx's job is to make `simulate`'s **offline**
  differentiators (pre-push *uncommitted* code, CI without an instance or
  credentials, `--network-none` isolation, engine-version rehearsal)
  **dependency-free**. The wave landed without touching `lib/engine.mts`'s
  backend surface, so the independence claim held.
- **CHANGELOG:** the npx backend + backend-selection config/flag are
  user-facing — Added/Changed under `[Unreleased]` when they land.
- Relationship: this unblocks Plan 7 closing on the Docker backend; Plan 7's
  gap-handling (task 6) is independent of which backend runs.
