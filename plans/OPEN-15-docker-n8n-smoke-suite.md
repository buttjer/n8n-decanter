# Plan 15 — Docker n8n smoke suite (dev-only)

**Priority:** P2
**Status:** Not started
**Theme:** An opt-in integration suite for *developing this tool*: spin up a
real n8n in Docker, drive the CLI against it, and prove the things no mock
can — that bundled nodes execute in the real Code-node sandbox, and that the
API semantics PLAN.md records still hold. Never shipped to users, never part
of `npm test`.

## Why

A growing pile of verifications waits on "a live session against Malte's
instance": Plan 14's bundled-code runtime smoke, Plan 12's structural-watch
semantics against real PUTs, the tags/pinned-data round-trip check
([Plan 0](BACKLOG.md)), the n8n 2.x publish semantics PLAN.md documents from
source reading, and Plan 3 C's executions-API shape spike. A pinned n8n
container answers them repeatably — locally and as an optional CI job —
without touching anyone's production instance, and re-answers them on every
n8n version bump.

**Scope decision (user, 2026-07-18): dev-only.** This is repo test
infrastructure. Users of n8n-decanter never see it: `test/` is outside the
npm tarball's `files` whitelist, nothing in the CLI grows a Docker
dependency, and the suite is invoked only by an explicit
`npm run test:smoke`.

## Source

- [DECISIONS-NEEDED](DECISIONS-NEEDED.md) entry 1 (2026-07-18), decided:
  go, dev-only scope.
- Absorbs the live-verification residue of
  [Plan 12](INPROGRESS-12-structural-watch.md),
  [Plan 14](INPROGRESS-14-bundle-shared-code-into-ts-pushes.md), the
  tags/pinned backlog item, and feeds
  [Plan 3](INPROGRESS-3-local-run-and-diff-fidelity.md) C's spike.

## Design

- `test/smoke-n8n.mts`, run via **`npm run test:smoke`** — a separate,
  sequential step-runner script (same `test/harness.mts` style as e2e).
  `npm test` stays Docker-free; the script fails fast with a clear message
  when the Docker CLI or daemon is missing.
- **Container**: `docker run -d -p 127.0.0.1::5678 n8nio/n8n:<pinned>`
  (empty host port = random; read it back via `docker port`). The tag is
  pinned in one constant at the top of the script (pick the current 2.x at
  implementation time; bumping it is how "does a new n8n break us?" gets
  asked). Wait for `/healthz`; always `docker rm -f` in a `finally`.
- **Auth bootstrap** (the fiddly part, and the reason this is a plan):
  automate the owner-setup + API-key flow over n8n's *internal* REST
  (`/rest/owner/setup`, login cookie, `/rest/api-keys`) — the public API
  can't create its own key. This is version-sensitive by nature; treat
  breakage on a version bump as signal, and keep the bootstrap isolated in
  one helper so it's the only thing that needs patching.
- **Workflow seeding**: the public API has no create endpoint (PLAN.md);
  seed via n8n's import CLI inside the container
  (`docker exec … n8n import:workflow`) or the internal REST — decide at
  implementation, prefer whichever survives version bumps better.

## Tasks

1. **Harness**: container lifecycle (pull-if-missing, start, health-wait,
   teardown-in-finally), auth bootstrap helper, temp sync dir wired to the
   container (`.env`, `decanter.config.json`, `git init`).
2. **Round-trip smoke**: seed a workflow with Code nodes → `pull` → assert
   layout → byte-identical `.js` push → pull again → in sync. Covers the
   real PUT normalization the e2e mock only imitates.
3. **Bundled-node execution proof** (Plan 14's missing acceptance): convert
   a node to `.ts` importing a `shared/` helper (and one allowlisted fake
   npm package), push, activate via the **public API**
   (`POST /api/v1/workflows/:id/activate` — no internal REST needed here),
   then **execute it for real**: a Webhook → Code → Respond-to-Webhook
   workflow, POST to the production webhook, assert the response contains
   the value the shared helper computes. This is the only test anywhere
   that proves the hoist→wrap→bundle artifact runs inside n8n's actual
   sandbox (task-runner or vm).
4. **Publish semantics check** (PLAN.md's researched claims): push to an
   unpublished workflow → stays draft; activate/publish via the public API,
   push again → goes live immediately; `push`/`status` publication-state
   lines match reality.
5. **Tags/pinned-data round-trip** (backlog item): tag + pin data on a
   workflow in n8n, untouched pull → push, assert both survive. Check the
   box in [Plan 0](BACKLOG.md) when it holds.
6. **Structural watch spot-check** (Plan 12 residue): scripted
   `workflow.json` edit under `watch` (in-process, like the e2e watch step)
   against the real API — clean push, then a forced remote structural
   change → conflict detected. UI-side editor behavior stays manual.
7. **Executions capture** (Plan 3 C spike input): run the webhook workflow,
   fetch `GET /api/v1/executions?includeData=true`, and **save a trimmed
   response shape** into the plan as the ground truth Plan 3 C designs
   against.
8. **CI (optional job)**: separate workflow job (`smoke`) on
   `workflow_dispatch` + a weekly cron — not on every push; Ubuntu runners
   have Docker. Failure notifies without blocking merges.
9. **Docs**: CONTRIBUTING gets a "running the smoke suite" paragraph; no
   CHANGELOG entry (dev infra); CLAUDE.md commands block mentions
   `npm run test:smoke` needs Docker.

## Acceptance / verification

- `npm run test:smoke` passes locally against the pinned tag with only
  Docker installed; leaves no containers behind (also on failure).
- `npm test` remains Docker-free and green without the daemon running.
- Task 3 proves a bundled node returns computed values through a real
  webhook execution; tasks 4/5 flip their PLAN.md open questions / backlog
  box from "believed" to "verified", with dates.
- CI job runs green on dispatch.

## Non-goals

- Nothing user-facing: no new CLI verbs, no Docker dependency in the
  package, nothing in the tarball.
- Not Plan 7 (offline engine replay) — this is integration against a real
  instance; Plan 7 stays its own, later concern.
- No UI automation (browser) — editor-side checks (Plan 4's plugin, watch
  conflict prompts in a real terminal) stay manual.

## Notes

- The auth bootstrap over internal REST is deliberately quarantined: it is
  the unstable surface — and it is also **unspiked** (endpoint paths are
  from n8n-internals knowledge, not verified against the pinned image), so
  task 1 doubles as the spike; budget the first stretch of implementation
  for it. Everything downstream of the API key uses the public API only
  (activation included), keeping the fragile surface to owner-setup +
  key creation. If a version bump breaks only the bootstrap, that is
  maintenance; if it breaks tasks 2–5, that is news about n8n-decanter.
- Dev-machine prereqs (checked 2026-07-18): Docker Desktop is installed on
  the dev Mac; the daemon must be running. Agent sessions run docker fully
  sandboxed — `.claude/settings.local.json` allowlists the
  `~/.docker/run/docker.sock` unix socket + `~/.docker` reads (verified
  with an end-to-end pull/run). Registry pulls need no network allowlist
  entries: they happen inside the daemon, outside the sandbox.
- Version pin doubles as a compatibility statement: bump the tag, run the
  suite, record the result in PLAN.md's open-questions section.
