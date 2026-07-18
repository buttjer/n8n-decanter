# Decisions needed — open questions for Malte

Items an agent cannot settle alone: they need your preference, your
infrastructure, or your go-ahead. Each entry says what's proposed, what the
options cost, and what happens if you do nothing. Delete entries once
decided (move the outcome into the relevant plan).

## 1. Docker-based n8n smoke suite (proposed Plan 15)

**Question (2026-07-18):** should the repo ship an opt-in integration suite
that spins up a real n8n in Docker and drives the CLI against it?

**Why:** several verifications currently wait on "a live session with your
instance": Plan 14's bundled-code runtime smoke, Plan 12's structural watch
against real PUT semantics, Plan 4's editor plugin aside, the
tags/pinned-data round-trip check, and Plan 3 C's executions-API spike. A
dockerized n8n covers most of them repeatably — locally and as an optional
CI job — without touching your instance.

**Sketch:** `test/smoke-n8n.mts`, opt-in (`npm run test:smoke`, never part
of `npm test`): start `docker run n8nio/n8n` (pinned tag), automate the
owner-setup + API-key REST calls, then: pull/push round-trip, push a
bundled `.ts` node, trigger it via a Webhook workflow and assert the
response (proves the bundle *executes* in the real sandbox), verify
tags/pinned data survive an untouched round-trip, and exercise the publish
semantics PLAN.md records. Plan 7 (engine-true simulation) is *not* the
vehicle — that's offline replay, this is integration.

**Needs from you:** (a) go/no-go; (b) is Docker acceptable as a dev/CI
dependency (CI would run it as a separate optional job); (c) which n8n
version tag to pin (your instance's?).
**If undecided:** everything keeps waiting on a manual live session.

## 2. Compressing / minifying oversized bundled nodes

**Question (2026-07-18):** you asked about compression when a bundled node
reaches 100 KB. Note the threshold is a **warning, not a failure** — pushes
succeed; n8n's payload ceiling is orders of magnitude higher. `.js` nodes
are never bundled and never warn.

**Recommendation: no compression.** A self-decompressing node would need
zlib (a builtin Code nodes can't rely on) or a bundled JS inflater (which
adds back most of the size), plus runtime `eval` — and it would destroy
`status --diff`, `.remote.js` conflict readability, and debuggability. The
honest lever, if size ever hurts in practice, is an **opt-in esbuild
`minify` knob** (typically 30–60 % smaller, still plain JS; costs: unreadable
code in the n8n UI and garbled line numbers). Auto-minifying above a
threshold is worse than either (output shape flips when a node crosses it).

**Needs from you:** whether to add "opt-in minify knob" to the backlog, or
drop the idea until a real workflow hits the warning.
**If undecided:** nothing changes; the warning stays informational.

## 3. Release blocker status — FYI, no input needed

The `dist/template` packaging bug (init resolved `../template` relative to
`dist/lib/`, which the npm tarball doesn't contain) is **fixed** via a
package-root walk (`packageRootFrom`, unit-tested for both layouts). One
consequence for [Plan 13](OPEN-13-open-source-release.md): the earlier
tarball smoke test only exercised `uuid` and missed this — before
publishing, re-run it and include `init` (checklist updated there).
