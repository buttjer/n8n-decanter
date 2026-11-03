# Plan 31 — Sandbox `run` for untrusted node code (`--unsafe` to opt out)

**Priority:** P2 (real footgun for the primary audience)
**Status:** Not started — reworked and probe-verified, ready to implement
**Snapshot:** 2026-11-03T16:14Z @ da6d183
**Model:** Opus (safety-critical boundary; the failure mode is arbitrary local
code execution)
**Theme:** Give `node run` an actual execution boundary so agent-generated code
is **safe by default**, with `--unsafe` to opt back into full host access.

## Why

`node run` builds an `AsyncFunction` from a node body and invokes it **in the
CLI's own process** (`invoke` in [lib/run.mts](../../lib/run.mts)) —
`process`, `fetch`, `globalThis` and dynamic `import()` are all free, so a node
file can touch the filesystem, network and env. n8n runs Code nodes in a
locked-down task-runner sandbox; `run` does not.

The tool is built for AI coding agents, and the documented loop is an agent
`run`-ing a node file **it just wrote** — pre-approved by the scaffolded
allowlist (`Bash(n8n-decanter node:*)`). Today that is arbitrary local code
execution on the agent's host. The `$env` fix (v0.3.0: `$env` empty unless
`--allow-env`) set the precedent — safe by default, explicit opt-in for the
dangerous mode. This plan extends it from *data* to *execution*.

## Source

- The Plan 0 backlog item "**`run` executes node code with full host
  privileges — document and narrow it**" — superseded by an enforced boundary;
  its doc half (README + template `AGENTS.md`) still lands as the `--unsafe`
  caveat (Task 6).
- [Plan 43](../done/43-emulated-globals-surface.md) — `run`'s emulated-global
  surface is the *inside* of this boundary.

## Design decision — the isolation mechanism (DECIDED: A, 2026-07-22)

**Option A only, no config toggle** (operator, 2026-07-22): A and B are two
different execution backends, so a toggle means two implementations and two
test suites.

- **A — `node:worker_threads`, scrubbed realm (CHOSEN, probe-verified
  2026-11-03).** See "How A holds" below. Pure JS, no new dep, no Node flag.
  Raises the bar sharply; **not** a VM/container jail — that stays
  `simulate`'s Docker `--network none` job
  ([Plan 7](../done/7-engine-true-simulation-suite.md)).
- **B — Node permission model (`--permission`).** Not chosen; kept as the
  fallback rationale only. Engine-enforced and stronger, but it constrains a
  whole re-spawned CLI and complicates result hand-back. Revisit only if A's
  boundary is shown to leak.
- **C — `vm` module.** Rejected: not a security boundary (Node docs);
  `this.constructor.constructor("return process")()` escapes.

### How A holds (probe, 2026-11-03, Node 26.7)

A worker has `process`, `fetch` and module loading by default, so "run it in a
worker" alone proves nothing. The probe (a worker that scrubs **its own main
realm**, then runs bodies through the `AsyncFunction` constructor) showed what
does hold, and why:

- **Delete every global outside an allowlist, in the worker's own realm,
  before user code runs.** All 58 non-allowlisted globals deleted cleanly
  (`process`, `fetch`, `WebSocket`, `require`, `navigator`,
  `BroadcastChannel`, …); none was undeletable.
- **This is why `constructor.constructor` buys nothing**, unlike in `vm`:
  every function the body can reach — its own, the injected `$input.all`,
  Luxon's, jmespath's — belongs to the same scrubbed realm, so
  `$input.all.constructor.constructor("return process")()` evaluates against a
  global object that has no `process`. Do **not** run the body in a separate
  `vm` context inside the worker: that re-creates the two-realm escape.
- **`import()` is syntax and can't be deleted**, so it is blocked by a
  `module.registerHooks` resolve hook (Node ≥ 22.15, inside our ≥ 22.18
  floor) that throws once the worker has finished its own imports. Blocked
  both directly and via `Function("return import('node:fs')")`.
- **A reachability walk found nothing.** BFS over every own key, symbol,
  getter result and prototype from `globalThis`, the injected `$input`,
  Luxon, jmespath, a `setTimeout`/`setImmediate` handle, `performance` and
  `crypto` (1,394 objects) found no `dlopen`/`binding`/`getBuiltinModule`/
  `_load`/`reallyExit`.
- Probe results: `process`, `globalThis.process`, `fetch`, `require`,
  `eval("process")`, `import("node:fs")`, `import("./x.mjs")`, both
  `constructor.constructor` forms → **blocked**; pure logic → **runs**.

Requirements the implementation must keep, or the above stops being true:

1. The worker entry is **strict** (an `.mts` module is). The probe's sloppy
   runner let `Error.prepareStackTrace` → `CallSite.getFunction()` hand back
   the runner function; strict frames return `undefined`.
2. Load Luxon and jmespath **before** the hook lock, then scrub, then lock.
3. Replace `console` with a fresh object of our own functions that forward
   each call to the parent over `postMessage` (keeps output ordered with the
   CLI's log lines; the worker's real `console` carries stream internals).
4. Create the worker with `env: {}` (defence in depth — `process` is gone
   anyway). `$env` under `--allow-env` is a snapshot the **parent** sends.
5. The allowlist is the ECMAScript built-ins plus pure web-standard ones
   (timers, `URL`, `TextEncoder`, `structuredClone`, `crypto`,
   `AbortController`, …). Anything with I/O stays out. Check it against what
   n8n's JS task runner puts in a Code node's scope (`Buffer` is a likely
   addition — the probe deleted it, but it is no capability) and keep the two
   aligned; that list is a fidelity question, not a security one, as long as
   nothing on it does I/O.

## Drift since 710d3f1 (2026-11-03 review)

- **Plan 24 (#352): `.js` nodes with imports are bundled.** `run` already
  calls `compileNode` for any managed source, so the sandbox runs **the
  bundle**. The bundle is self-contained by construction: `compileNode`
  refuses Node builtins and un-opted npm packages, so a bundle has no
  `require`/`import` left for the sandbox to block. One new edge: an opted-in
  npm dep that reads `process.env.NODE_ENV` at load time now throws inside
  the sandbox. That is the friendly-error path (Task 4), not a reason to stub
  `process`; record what n8n's runner does with the same dep in the test.
- **Plan 66 (#258) / Plan 63 (#216):** per-output fixtures and branch
  signposts live inside `buildGlobals`. They move into the worker unchanged —
  `buildGlobals` runs worker-side, so no change to them.
- **Plan 56 (#149):** the scaffold is `template/.claude/settings.json.example`
  (project scope). **Plan 58 (#176):** it now also allows
  `npx n8n-decanter node:*`. Both matter for Task 7.
- **Plan 59 (#179):** `check`/`status`/`simulate` became `preflight`/`diff`;
  doc paths below are updated to match.
- **Optimise for the latest n8n** (2026-10-23): nothing here is
  version-specific — `run` never talks to n8n.

## Tasks

1. **Extract the execution boundary.** Isolate `invoke` behind one interface
   so the default path goes through the sandbox and `--unsafe` keeps today's
   in-process `AsyncFunction`. Both `runOnceForAllItems` and the per-item loop
   go through it.
2. **Implement the sandbox.** A new `lib/runsandbox.mts` (worker entry) per
   "How A holds". `buildGlobals` holds functions and Luxon instances, so it is
   **not** structured-cloneable: post the parsed `Fixture`, the node context
   (`node`, `staticData`), the code, the mode and, under `--allow-env`, the
   env snapshot; call `buildGlobals` **worker-side**. Only the fixture and the
   return value cross the clone boundary. Run the whole per-item loop inside
   **one** worker per invocation. Keep semantics: `undefined` per-item returns
   dropped; `$env`/`--allow-env` unchanged. A return value that isn't
   cloneable (a function, a class instance) gets a clear error naming the
   item, not a `DataCloneError`.
3. **`--unsafe` flag.** Default sandboxed; `--unsafe` = today's behaviour,
   with a one-line notice ("running with full host access — no sandbox").
   Wire it through the `node run` handler, `--help` usage line and
   `__complete`.
4. **Friendly boundary errors.** A `ReferenceError` for a removed global
   (`process`, `fetch`, `require`, …) and the hook's refusal of `import()`
   become one message: "`<name>` is not available in sandboxed `node run` —
   pass `--unsafe` to allow host access." Same shape as Plan 43's `signpost`.
5. **Tests**, at the CLI surface (per the `verify` skill) plus a unit suite
   for the worker:
   - An **escape suite** that tries each probe vector and asserts it is
     blocked: `process`, `globalThis.process`, `fetch`, `require`,
     `eval("process")`, `import("node:fs")`, relative `import()`,
     `this.constructor.constructor(…)`,
     `$input.all.constructor.constructor(…)`, the same via
     `DateTime.constructor.constructor(…)`, and `import()` built through the
     `Function` constructor.
   - The **reachability walk** as a test: no reachable object exposes
     `dlopen`/`binding`/`getBuiltinModule`/`_load`.
   - `Error.prepareStackTrace` + `getFunction()` returns no runner function.
   - Same node blocked by default, succeeds under `--unsafe`.
   - A pure-logic node: byte-identical output in both modes; per-item mode
     preserved; `$env` empty by default, pinned by fixture, inherited under
     `--allow-env`.
   - A bundled `.js` with a `shared/` import (Plan 24) runs sandboxed.
   - Assert with regexes (ANSI).
6. **Docs + CHANGELOG + PLAN.md.** `docs/cli/node-run.md` (new flag, the
   boundary, the "not a full jail" caveat), `docs/cli/overview.md` (flag line
   + offline-verbs table), README (`## Commands` row and feature bullet if the
   wording changes), `[Unreleased]` **Breaking:** (default execution changes),
   PLAN.md (the `run` boundary model). Re-qualify "safe to run unsupervised"
   where it appears — `docs/agents/offline-loop.md`,
   `docs/agents/overview.md`, `template/AGENTS.md.example`,
   `template/CLAUDE.md.example` — so it is true by default and `--unsafe`
   says it isn't.
7. **Scaffolded permissions.** `Bash(n8n-decanter node:*)` and
   `Bash(npx n8n-decanter node:*)` would silently pre-approve
   `node run … --unsafe`. Add **`ask`** rules to
   `template/.claude/settings.json.example` (`ask` beats `allow`) for both
   the bare and the `npx` form, and an `"ask"` pattern to
   `template/opencode.json.example`'s `bash` map. Confirm with the installed
   Claude Code that a mid-pattern `*` (`Bash(n8n-decanter node run *--unsafe*)`)
   matches; if it doesn't, record that and name the residual risk in the
   template `AGENTS.md` instead. Mirror whatever lands in the repo's own
   counterparts (housekeeping step 8 checks the match).

## Acceptance / verification

- Default `node run` **cannot** read the host env, reach the network, or
  `import()` any module; the same node succeeds under `--unsafe`.
- Every escape in Task 5 is a test, and they all fail closed.
- A pure-logic node produces byte-identical output sandboxed and `--unsafe`.
- Both run modes go through the boundary; `$env`/`--allow-env` unchanged.
- A blocked capability yields the friendly, actionable error.
- Docs, README, CHANGELOG, PLAN.md and the template reflect the new default
  and flag (grep `node run` across them per AGENTS.md).

## Non-goals

- A hard container/VM jail; `simulate` (`preflight --simulate`) owns that.
- CPU/memory limits or a timeout for a runaway body. A worker makes them cheap
  (`resourceLimits`, `terminate()`), but they are a separate decision.
- Sandboxing anything but `run` — `push`/`watch` don't execute node bodies.
- Changing the emulated-global *surface* (Plan 43).

## Notes

- **Breaking:** a node relying on host `process`/`fetch` now needs
  `--unsafe`. While 0.x, breaking → minor bump.
- Post-Plan-32 (2026-07-22): `node run` is offline and never touches the sync
  backend; the instance-side `test` verb runs in n8n's own sandbox and is out
  of scope.
- The #107 empty-file-seeding loop makes the Why concrete: an agent writes a
  new node, verifies it with `node run`, and the first push seeds it.
- The probe script lives in the session that reworked this plan, not the
  repo; Task 5's escape suite replaces it.
