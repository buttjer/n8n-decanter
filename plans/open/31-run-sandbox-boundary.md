# Plan 31 — Sandbox `run` for untrusted node code (`--unsafe` to opt out)

**Priority:** P2 (real footgun for the primary audience; needs a small design
choice on the isolation mechanism)
**Status:** Not started
**Model:** Opus (safety-critical boundary; the failure mode is arbitrary local
code execution)
**Theme:** Give `node run` an actual execution boundary so agent-generated code
is **safe by default**, with `--unsafe` to opt back into full host access.

## Why

`node run` builds an `AsyncFunction` from a node body and invokes it **in the
CLI's own process** ([lib/run.mts:179](../../lib/run.mts#L179)) — `process`,
`fetch`, `globalThis`, and dynamic `import()` are all free identifiers, so a
node file can touch the filesystem, network, and env. n8n runs Code nodes in a
locked-down task-runner sandbox; `run` does not.

For a human running *their own* code this is fine. But the tool's tagline is
**"built for AI coding agents,"** and the canonical loop is an agent `run`-ing a
node file **it just generated**. That makes today's behavior arbitrary local
code execution on the agent's host — the single highest-severity correctness
issue in the repo. The backlog already tracks the *documentation* half; this
plan adds the *enforcement* half the proposal flagged as **[new]** and gated on
a user decision (now given).

The `$env`-leak fix (BACKLOG, done v0.3.0: `$env` empty unless `--allow-env`)
set the precedent — **safe-by-default, explicit opt-in for the dangerous mode.**
This plan extends the same principle from *data* exposure to *execution*
capability.

## Source

- [Plan 0 backlog](../draft/) "**`run` executes node code with full host
  privileges — document and narrow it**" — this plan supersedes the doc-only
  recommendation with an enforced boundary (the doc note still lands as the
  fallback for `--unsafe`). That item names **README + template `AGENTS.md`**
  as its doc surfaces, so the `--unsafe` fallback note is obligated to touch
  the template files, not just `/docs` (see Task 6).
- A plan-mode session artifact (the old "PROPOSAL.md item 5", the **[new]**
  "Better" tier) — the item flagged as needing a user decision before
  graduating. *(There is no `PROPOSAL.md` in the repo; the surviving repo-side
  source is the BACKLOG item above, which already links back to this plan.)*
- Pairs with the `run` faked-context fidelity item (BACKLOG, `$jmespath`): the
  emulated-global surface is the *inside* of this boundary.

## Design decision — the isolation mechanism (DECIDED: A, 2026-07-22)

The boundary must block `process`/`fetch`/`import()`/`globalThis` while keeping
the emulated n8n globals (`$input`, `$json`, `DateTime`, …) and the returned
value. **Decided: option A, single mechanism — no config toggle between A and
B.** The two are not one code path with a setting; they are distinct execution
backends (A runs the body in-process in a worker; B re-spawns the whole CLI as a
child `node --permission …` and marshals node file/fixture/result across a
process boundary), so "support both behind a config" would mean two full
implementations + two test suites, not a small switch (user decision
2026-07-22: not worth it → ship A only).

- **A — `node:worker_threads` with a scrubbed context (CHOSEN).** Run the
  body in a worker whose globals are curated: no `process`, `require`, or
  `import`; `fetch`/network off; only the serialized `buildGlobals` payload
  injected. Structured-clone boundary means the fixture and return value cross
  cleanly. Pure-JS, no new dep, no flag on the Node binary. Accepted trade-offs:
  worker startup cost per run; care needed that no capability leaks through the
  global set; it raises the bar sharply but is **not** a hard VM/container jail
  — that stays `simulate`'s Docker `--network none` job ([Plan 7](../done/7-engine-true-simulation-suite.md)).
- **B — Node permission model (`--permission`/`--allow-fs-read` etc.).** Not
  chosen. Re-spawn `run` as a child `node` with `--permission` denying fs/net —
  engine-enforced and stronger, but process-level (constrains the *whole*
  re-spawned CLI, complicating result hand-back) and the flag surface is still
  stabilizing across Node 22/24. Kept here only as the rationale for A; revisit
  only if A's boundary proves insufficient.
- **C — `vm` module.** Rejected: `vm` is explicitly **not a security boundary**
  (Node docs) — `this.constructor.constructor("return process")()` escapes.

## Tasks

1. **Extract the execution boundary.** Isolate `invoke`
   ([lib/run.mts:177](../../lib/run.mts#L177)) behind a small interface so the
   default path routes through the sandbox and `--unsafe` keeps today's
   in-process `AsyncFunction`. Both `runOnceForAllItems` and the per-item
   `runOnceForEachItem` loop must go through it.
2. **Implement the sandbox (option A).** Worker with a curated global set;
   return the node's value (or per-item array) across the structured-clone
   boundary. Preserve current semantics: `undefined` per-item returns are
   dropped, `$env`/`--allow-env` behavior unchanged *inside* the sandbox.
   **Marshaling caveat:** `buildGlobals`' return value is **not**
   structured-clone-serializable — it holds functions (`$input.all/first/last`,
   `$`, `$getWorkflowStaticData`, `$jmespath`), Luxon `DateTime`/`Duration`/
   `Interval` instances, and `console`. So do **not** `postMessage` the built
   globals; send the serialized `Fixture` + context (`nodeName`, `staticData`,
   `allowEnv`) and call `buildGlobals` **worker-side** — only the fixture and
   the return value cross the clone boundary. Run the per-item
   `runOnceForEachItem` loop **inside one worker per invocation** (not one
   worker per item) so startup cost stays O(1).
3. **`--unsafe` flag + surfacing.** Default = sandboxed; `--unsafe` = full host
   access (today's behavior). Print a one-line notice on `--unsafe` ("running
   with full host access — no sandbox"). Wire it through the `node run` handler
   and `__complete`.
4. **Friendly boundary errors.** When sandboxed code reaches for a blocked
   capability (`process`, `fetch`, `import()`), fail with a clear "not available
   in sandboxed `run` — pass `--unsafe` to allow host access" message rather
   than a bare `ReferenceError`/`TypeError`.
5. **Tests.** Unit + e2e at the CLI surface (per `verify` skill): a node that
   reads `process.env`/does `fetch` is **blocked by default** and **succeeds
   under `--unsafe`**; a pure-logic node returns identical output in both modes;
   per-item mode preserved. Assert with regexes (ANSI).
6. **Docs + CHANGELOG + PLAN.md.** New flag and the default-sandbox behavior are
   user-facing and change a flow. **The correct doc surface is
   `docs/cli/node-run.md`** (the verb is `node run`; there is no `run.md`),
   plus `docs/cli/overview.md` (the flag line **and** the offline-verbs table),
   README (`## Commands` row + feature bullet + the comparison-table cell if
   its wording changes), `[Unreleased]` (**Breaking:** — default execution
   semantics change), and **PLAN.md** (the `run` execution-boundary model).
   **Retract the "safe to run unsupervised" overstatement wherever it now
   appears** — the sandbox is what *makes it true by default*, and `--unsafe`
   must re-qualify it: `docs/agents/offline-loop.md` ("fully offline … safe for
   agents to run without supervision"), `docs/agents/overview.md` (the
   agent-policy row "`check`, `node run`, `scenario` | Offline and safe — run
   freely"), `docs/cli/node-run.md`'s "no credentials, no network" phrasing,
   and the template surfaces the backlog item obligates:
   `template/AGENTS.md.example` ("two offline tools … no credentials, no
   network" + the `node run` doc + the verify-offline line) and
   `template/CLAUDE.md.example`. The retained plain-text "not a full jail"
   caveat is the doc half of the superseded backlog item.
7. **Scaffolded-allowlist decision (NEW).** `template/.claude/settings.local.json.example`
   pre-approves `Bash(n8n-decanter node:*)`, whose prefix match will silently
   auto-approve `node run … --unsafe` the moment this ships — re-opening the
   full-host-access footgun on pre-approved commands. Decide (and record):
   either narrow the scaffold rule so `--unsafe` still prompts, or call the
   residual risk out explicitly. This is the permission surface, distinct from
   the CLI notice in Task 3.

## Acceptance / verification

- Default `node run` **cannot** read the host env, hit the network, or `import()`
  arbitrary modules; the same node succeeds under `--unsafe`.
- A pure-logic node produces byte-identical output sandboxed and `--unsafe`.
- Per-item and all-items modes both routed through the boundary; `$env` /
  `--allow-env` semantics unchanged inside it.
- Blocked-capability access yields a friendly, actionable error.
- Docs/README/CHANGELOG/PLAN.md all reflect the new default + flag (grep the verb
  surface per AGENTS.md).

## Non-goals

- A hard container/VM jail. Option A raises the bar, not an impenetrable wall;
  enforced network/fs isolation stays `simulate`'s Docker `--network none` job
  ([Plan 7](../done/7-engine-true-simulation-suite.md)).
- Sandboxing anything but `run` — `push`/`watch` don't execute node bodies.
- Changing the emulated-global *surface* (that's the `$jmespath`/fidelity
  backlog item); this plan only changes *where* the body runs.

## Notes

- **Post-Plan-32 review (2026-07-22): unaffected by the MCP pivot** —
  `node run` is fully offline/local and never touches the sync backend. The
  instance-side `test` verb ([Plan 33](../done/33-post-mcp-pivot-wave.md) Task 5,
  **shipped** in `lib/testrun.mts`) runs code in n8n's own sandbox and doesn't
  change this plan's scope: `node run` remains the local fast path, and *that*
  is the one needing a boundary. Plan 37's `scenario` rewrite (#109/#114) did
  **not** touch `run.mts` or its `[fixture.json]` format — `node run` fixtures
  are a separate surface from the committed `scenarios/` pin sets, confirming
  this plan's "unaffected" self-assessment.
- **The #107 empty-file-seeding flow makes this plan's Why concrete, not just a
  tagline:** the documented authoring loop now has `pull` land a Code node
  added over MCP as an **empty** `code/` file, the agent write the code, verify
  with `node run` + `check`, and the **first push seed** the node's source. So
  "an agent `run`-ing code it just generated" is a documented,
  allowlist-pre-approved step — sharpening the priority case for a default
  boundary.
- **Breaking:** the default flips from "full host access" to "sandboxed," so a
  node relying on host `process`/`fetch` now needs `--unsafe`. While 0.x, a
  breaking change is a minor bump per AGENTS.md.
- Mechanism decided (2026-07-22): **option A only, no A/B config toggle** —
  supporting both would be two backends + two test suites, not a small switch.
  No open decisions remain; the plan is ready to implement.
