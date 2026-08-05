# Blind-agent field test (Plan 35)

Dev-only harness that puts the **whole product** — `init` → skills/MCP structure
work → Code-node authoring → `push` → runs — in front of **blind** Sonnet coding
agents acting as typical users against a real n8n in Docker, and captures what
happens. A UX/contract field test, **not** a CI suite (cost + nondeterminism
rule that out). Never part of `npm test`.

## Pieces

| File | Role |
| --- | --- |
| `stage.mts` | Boots + provisions a throwaway n8n (or `FIELD_N8N_URL`), seeds workflows + an S1 skeleton, scaffolds a **neutral** scratch project: `git init`, **packs + locally installs OUR built CLI** (no global link; `run.mts` puts `node_modules/.bin` on the session PATH), **pre-seeds a correct `.env`**, disables the nested session's sandbox, vendors the n8n skills pack (`skills-install.mts`). Prints a **manifest**. |
| `run.mts` | Orchestrator: replays each scenario's scripted turns as headless `claude -p --model sonnet` sessions (`--resume` per turn); post-init wires guard-stderr capture + the allow-extension; runs `verify.mts` after each. Diagnostics: `--smoke`, `--netcheck`, `--dry-run`. |
| `verify.mts` | Scripted invariant oracle (no LLM): placeholder integrity, `.js` byte-equality, `.ts` marker-hash relation, `.decanter.json` git-history, **fetched caches never committed**, **committed scenarios structurally valid**, **read-only scenarios left the draft `versionId` untouched** (`--expect-unchanged`), `get_workflow_history` evidence. Exit 1 on any violation. The local checks run *before* the instance is touched, so a broken-instance scenario still gets them graded. |
| `report.mts` | **Renders a run's transcripts into ONE self-contained HTML report** — a chat-style timeline of each blind session (prompts, agent reasoning, every tool call + result, guard log, verdicts), with each file change diffed under the action that caused it. Renders a live run (`<manifest>`) or a committed archive (`--from <raw.tgz>`) identically. |
| `runs/<iso>-<runId>/` | **Committed round archives** — `raw.tgz` (the source of truth) + `report.html` (the view). See *Debugging* below. |
| `scenarios/S1–S13.md` + `STYLE.md` | Persona / goal / adaptive-beats / checklist + a machine-readable `## Orchestration` turn spine; blinding rules verbatim. Structurally checked offline by `test/unit/field-scenarios.test.mts` (part of `npm test`). |

## Runs are isolated, and the runner enforces it

**Every scenario gets its own n8n instance and its own scratch project.** The
unit of isolation is a scenario **plus its declared `requires` chain** (S4 opens
on the workflow S2 creates, so those two share one stage); everything else is
staged fresh and torn down after.

```sh
node test/field-test/run.mts --isolate --seeds corpus-v1 S7 S10 S12
#   isolating 3 scenario(s) into 3 unit(s): S7, S10, S12
#   …stages, runs, archives and tears down each in turn
```

Passing several independent scenarios to **one** manifest is now **refused
before anything is spent**. This is not tidiness: round `ftrun-29773` ran S13
after S11 in the same workDir, and S13's agent opened with *"there is no contact
cleanup workflow locally; this repo only tracks weekly-digest-roll-up"* — S11's
pull had shaped what S13 measured, and the resulting FAIL read like a product
defect. A round is expensive; a contaminated one is expensive **and** misleading.

`--isolate` re-execs this script per unit rather than threading a second manifest
through it, so verify scoping, archiving and pre-hooks stay byte-identical to a
hand-driven single run — and each unit archives on its own, so a later failure
never costs the earlier units' evidence.

## Scenario × surface coverage

Which scenario exercises which part of the product, and — as importantly — what
nothing covers and why. S1–S6 and the wave-2a scenarios (S8, S9, S11, S13) are
**runnable today**; the corpus-dependent rest of S7–S13 are
[Plan 61](../../plans/open/61-field-test-scenario-wave-2.md)'s wave 2, written
ahead of the staging machinery they need (`run.mts` refuses a scenario whose
pre-hook or seed kind does not exist, so an unbuilt one cannot silently
"measure" an untouched environment).

| Surface | Covered by | Status |
| --- | --- | --- |
| `pull` / `push` / `diff` / drift guard / TS conversion / MCP structure + reconcile | S1–S4 | runnable (only 3 archived rounds on the post-Plan-59 verb surface) |
| CLI discoverability from a fresh clone | S6 (`FIELD_NO_CLI=1`) | runnable — 6 rounds, 6 PASS |
| `watch` | S5 | written, **never run** → [Plan 62](../../plans/open/62-field-test-unrun-conditions.md) |
| `preflight` (`--json`, `--require`, `--fail-on`, `--fail-fast`, coverage block) | **S8** | **runnable** — stage `--seeds wave2` |
| `scenario create --execution` / `check`, `executions`, `test` after push | **S8** | **runnable** ([Plan 65](../../plans/done/65-three-gate-scenario-mismatch.md) landed) |
| `preflight --simulate` / `--offline` / `--viewer`, loop preview, `node run` | **S9** | **runnable** host-only, `--seeds wave2` — land [Plan 63](../../plans/done/63-field-feedback-bugfixes.md)/[66](../../plans/draft/66-multi-output-pins.md) first |
| `backup create` / `restore` / `list`, `backupLimit` | **S10** | needs the corpus pack + `fill-backup-store` |
| `publish` / `push --publish` / `unpublish`, live-vs-draft, guard publish gate (#200) | **S11** | **runnable** |
| bulk no-ref verbs, non-TTY no-picker contract, `list --json`, `data-tables`, git hygiene | **S12** | needs the corpus pack + a seeded data table |
| error-message routing: MCP unavailable / 401 / 403 / layout violation / misrouted config | **S13** | **runnable** (the 403 message landed with [Plan 74](../../plans/done/74-mcp-disabled-403.md)) |
| workflows decanter did not create (legacy nodes, credentials, punctuation, scale) | **S7** | needs the corpus seed pack |
| `init` OAuth browser consent | — | **not covered, deliberately**: e2e + unit own it; a browser consent flow is not gradeable headless |
| `init` cold path (no pre-seeded `.env`) | — | **not covered yet**: `FIELD_NO_SEED_ENV=1` exists, no round has used it → Plan 62 |
| `completion` | — | **not covered, deliberately**: shell-integration surface, no agent-facing behaviour to grade |
| `mcp serve` (HTTP guard transport) | — | **not covered**: the scaffold wires `mcp connect`; the HTTP variant has no blind-agent path today |

### Seed packs and pre-hooks

**Seed packs** (`stage.mts --seeds <pack>`, or `FIELD_SEED_PACK`):

- `builtin` *(default)* — the four workflows every archived round staged.
  Unchanged on purpose: a fifth workflow changes what `list --remote` shows,
  which is an input to S1's discovery beat and S6's fresh-clone measurement.
- `wave2` — `builtin` plus `Weekly revenue totals` (`s8-ladder`: two chained
  Code nodes, so a run gives the second one a real **input** sample) and
  `Order backlog in chunks` (`loop-preview`: a `splitInBatches` loop, the one
  graph whose local replay is viewer-only).

**Pre-hooks** are the harness playing a second actor before a scenario's first
turn. Play one on its own — no claude spend — with:

```sh
node test/field-test/run.mts <manifest> --hook=<name>
```

| hook | what it stages |
| --- | --- |
| `remote-drift` | a colleague's raw-MCP `jsCode` edit (S3) |
| `seed-capture` | runs the `s8-ladder` workflow so a **real** execution exists to fetch (S8) |
| `publish-then-drift` | publishes, then drifts the **draft** while live keeps running (S11) |
| `break-published-draft` | publishes, then leaves the draft with a dangling `$('…')` — the Plan 64 publish gate must refuse it (S11) |
| `revoke-mcp-access` | takes a workflow out of MCP (S13) |
| `rotate-mcp-token` | invalidates the session's token server-side → 401 (S13) |
| `disable-mcp` | switches MCP off instance-wide → **403**, see [Plan 74](../../plans/done/74-mcp-disabled-403.md) (S13) |
| `inject-layout-violation` | an orphan file in `code/` — the compliance error `--force` does not bypass (S13) |
| `misroute-mcp` | rewrites `.mcp.json` to point straight at n8n, taking the guard out of the path (S13) |

A scenario naming a hook that does not exist, or a seed kind this stage never
created, is **refused before any spend** — `run.mts` used to silently no-op an
unknown hook and run the turns against an untouched environment.

## Run it (UNSANDBOXED)

Nested `claude` needs the Anthropic API and must reach the local n8n, and
`fs.watch` dies under a sandbox — **run in a normal terminal**. If you drive this
from a coding agent whose Bash is sandboxed, exclude the field-test commands from
its sandbox (e.g. Claude Code `sandbox.excludedCommands`:
`node test/field-test/run.mts *`, `node test/field-test/stage.mts *`).

```sh
npm run field-test:stage                       # boots n8n, links our CLI, prints MANIFEST=<path>
node test/field-test/run.mts <manifest> --smoke      # (debug) one claude turn works? → READY
node test/field-test/run.mts <manifest> --netcheck   # (debug) can the agent reach n8n? → 200
node test/field-test/run.mts <manifest> S1 S2 S3 S4  # the blind round (or a subset)
                                               #   → auto-renders + archives to
                                               #     test/field-test/runs/… (commit it)
npm run field-test:report <manifest>           # re-render a live run
npm run field-test:report -- --from test/field-test/runs/<dir>/raw.tgz   # …or an archived one
npm run field-test:verify <manifest>           # re-run the invariant checks any time
node test/field-test/stage.mts --down <manifest>     # teardown (container + scratch dirs)
```

## Container mode (`--container`) — safe UNATTENDED runs

Host mode runs the blind `claude` **unsandboxed on your machine** with auto-`Bash`
— fine when you're watching, but risky unattended. `--container` runs each blind
session inside a Docker container that is **egress-fenced to `anthropic.com`
only** (a tinyproxy allowlist sidecar) with **no host filesystem and no host env
beyond a single auth credential**. Even an injected/looping agent can reach only
Anthropic + the throwaway n8n. See `docker/docker-compose.yml` — it *is* the
isolation contract. Design + validation notes live in the Plan 35 "Container
mode" section.

### Auth — subscription or API key

Set **one** of these in `test/field-test/.env`; `run.mts` picks it and exports
exactly that one into the container (the token wins if both are set). Nothing is
mounted and no browser runs inside the fence — that's why both shapes are plain
env vars.

| var | billing | cap |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | your Claude **subscription** — mint with `claude setup-token` | **none** — `FIELD_RUN_BUDGET_MIN` is the only backstop |
| `ANTHROPIC_API_KEY` | pay-per-token API | the key's own spend cap |

A subscription round costs **throughput, not dollars**: it draws on your 5-hour
windows, so an unattended round competes with your own interactive usage. The
unused variable is left **absent** rather than empty — an empty key is worse than
no key, since the CLI would try to use it.

Run `--smoke` first (one turn, ~a cent) to prove auth works through the fence
before committing to a full round.

```sh
cp test/field-test/.env.example test/field-test/.env   # then set ONE credential (see above)
npm run field-test:stage                                     # prints MANIFEST=<path>
node test/field-test/run.mts <manifest> --container --precheck   # $0 plumbing check: baked CLI loads + n8n reachable
node test/field-test/run.mts <manifest> --container --smoke      # one fenced claude turn → READY
node test/field-test/run.mts <manifest> --container S1 S2 S3 S4  # the fenced blind round
node test/field-test/stage.mts --down <manifest>                 # teardown
```

- The key is read via `docker compose --env-file test/field-test/.env`; it
  flows only into the `agent` service (never the proxy, never a log, never git).
- The CLI + `typescript` are **baked into a per-run image at build time** (the
  fence has no npm registry); the host's macOS `node_modules` are shadowed so
  nothing platform-wrong runs. `FIELD_RUN_BUDGET_MIN` (default 60) is a total
  wall-clock kill so an unattended round can't run — or bill — forever.
- `S5` (`watch`) stays host-only (`fs.watch` on container mounts is unreliable).
- Invoke `run.mts`/`stage.mts` **directly** (not via `npm run …`) when driving
  from a sandboxed agent, so the `node test/field-test/*` sandbox exclusion
  applies and `docker build` can run.

`run.mts <manifest> S1 --dry-run` prints the filled turns and spawns nothing.

**Verify scope (`verifyWorkflows`).** A scenario declares which workflows it owns;
`run.mts` resolves that to ids and passes them to `verify.mts`. `"all"` verifies
every tracked folder; an **array** selects by manifest `kind`, plus the
pseudo-kind **`"created"`** for a workflow the *agent* built (on the instance,
absent from `seeded` — S2 makes one, so neither S2 nor S4 can name it up front).

> This field was declared in every spine and **never read** until 2026-07-26 —
> verify always checked everything. That is why S4 reported S3's drift as its own
> failure. Scope a scenario to what it owns and the summary means what it says.

**Deliberate drift (`preHook: "remote-drift"` + `--expect-drift`).** S3 edits a
node over raw MCP *on purpose* and the agent is supposed to refuse to push over
it — so the drift **persists by design**, and byte-equality scored it as two
violations. `run.mts` now tells the verifier which workflow that is, and those
two checks pass either way, recording which happened. Byte-equality genuinely
cannot separate "correctly refused", "pulled and resolved", and "blindly
`--force`d" — that judgement is the grader's, from the transcript.

**Scenario prerequisites.** Some scenarios act on state an earlier one built —
**S4 requires S2** (it opens with "let's tidy *the orders workflow*", which is
the workflow S2 creates). A full `S1 S2 S3 S4` round satisfies that implicitly;
a *subset* does not. Running `S4` alone used to produce the most expensive kind
of wrong answer: the agent hunts for a workflow that isn't there, never pulls,
and `verify.mts` reports `no tracked workflow folders` — a FAIL that reads like a
product defect but is an operator error. Prerequisites are now declared in the
scenario spine (`"requires": ["S2"]`) and checked **before the image build and
before any turn**, so an unmet subset costs nothing:

```
$ node test/field-test/run.mts <manifest> --container S4
scenario prerequisites unmet — nothing was spent:
  S4 requires S2 to run first (it acts on state S2 creates)
try: node test/field-test/run.mts <manifest> S2 S4
```

## Debugging

- **Diagnostics first.** `--smoke` proves headless `claude -p` works (auth, flags,
  stream parsing); `--netcheck` proves the blind session can reach n8n. Run both
  before a full round when something looks off.
- **Artifacts** (in `<harnessRoot>`, a sibling dir the agent never enters):
  `transcripts/<S>/turn-N.jsonl` (stream-json), `verify-<S>.json`, `guard.log`,
  and `report.html`. The **report** is the fastest way to read a session.
- **Every round auto-archives, into git** — at the end of a run `run.mts` renders
  the report and writes **`test/field-test/runs/<iso>-<runId>/`**:

  | file | what |
  | --- | --- |
  | `raw.tgz` | the **source of truth** — `transcripts/`, `verify-*.json`, `guard.log`, a credential-free `manifest.json`, and `work.git` (a bare clone: the whole `workflows/` history) |
  | `report.html` | the rendered view, readable straight from the repo |

  **Commit both** — being committed is what makes a round prune-proof (a
  `git worktree remove` can't take it with it) and keeps a round's evidence in
  the PR that produced it. `run.mts` does not commit for you.

  Rendering is reproducible from the tarball alone, with no live run around:

  ```sh
  node test/field-test/report.mts --from test/field-test/runs/<dir>/raw.tgz
  ```

  So **what you look at can change later without re-running** — a new view
  re-renders from the raw. Only two things are deliberately *not* archived: the
  working tree (reconstructable from `work.git`) and the vendored skills pack
  (identical every run; provenance is in `manifest.skills`). Together with
  storing the workflow history as git deltas instead of per-turn tree copies,
  that's ~1.5 MB of loose files per round down to **~75 KB compressed**.
- **`run.mts --archive <manifest>`** re-archives a finished round without
  re-running it — the recovery path if archiving failed, and how the archive
  mechanics get exercised for $0. `FIELD_ARCHIVE_DIR` overrides the destination.
- **Secrets are scrubbed at archive time**, not at render time: the manifest's
  MCP token / API key are replaced with `‹redacted›` throughout the payload
  before it is packed, because the archive lands in git.
- **The shipped `report.html` is rendered *from* `raw.tgz`**, so every round
  self-tests its own archive — and a renderer failure can no longer cost you the
  raw, since packing happens first.
- **Each turn's prompt is recorded verbatim** (`transcripts/<S>/turn-N.prompt.txt`).
  It is passed to `claude -p` as argv and so appears nowhere in the stream-json
  transcript; without the record, a re-render would caption turns from scenario
  files that get reworked between rounds. A retroactively archived round
  (`--archive`) is marked `scenariosAsRun: false` and its report says so.
- **`npm test` covers all of this without spending a cent**
  ([`test/unit/field-report.test.mts`](../unit/field-report.test.mts)): a synthetic
  harness — hand-written transcript, verify verdict, guard log, a small git repo —
  driven through the real `report.mts`/`run.mts`, asserting the rendered diffs,
  the progression, redaction, and that `--from` reproduces the shipped report
  byte-for-byte **after the live run is deleted**. The machinery that preserves an
  expensive round must never be first exercised by an actual round.
- **Guard evidence** (`guard.log`): a blocked `jsCode`-over-MCP write shows as a
  guard warn-line; an empty/connection-only log means the agent went file-first.

## Env knobs

| Var | Effect |
| --- | --- |
| `FIELD_N8N_TAG` | n8n image (default matches `test/smoke-n8n.mts`). |
| `FIELD_N8N_URL` / `FIELD_MCP_TOKEN` / `FIELD_API_KEY` | target an existing instance instead of booting one. |
| `FIELD_DECANTER_SPEC` | install a published version / tarball / git ref instead of packing the local repo. |
| `FIELD_NO_SEED_ENV=1` | omit the pre-seeded `.env` to exercise `init`'s cold host-prompt path (reproduces the https finding). |
| `FIELD_TURN_TIMEOUT_MS` | per-turn kill timeout (default 15 min). |
| `FIELD_KEEP=1` | keep the container on `--down`. |

## Round-1 findings (preliminary — full grading deferred)

First blind round (Sonnet, 2026-07-23) against real n8n 2.30.7. **S1 and S2
passed cleanly** — a blind agent ran the full `init → pull → author → push →
publish` flow (S1) and **built an entire 6-node workflow with structure via the
guard and every Code node via files+push, byte-equal, zero rogue `jsCode`** (S2).
Contamination check clean (no agent inferred an evaluation). Findings surfaced
along the way, ranked for the maintainer's triage:

1. **Discoverability (P1).** With no project-level `n8n-decanter`, a blind agent
   never finds it — it hand-rolls raw n8n MCP instead. *(Harness now installs the
   CLI into the project so it has the breadcrumb; the underlying discoverability
   gap is the finding.)*
2. **`init` writes `https://` for a local `http://` host (P1, product).** Breaks
   the guard (which reads `.env` directly → `upstream request failed`) and the
   CLI. Reproduce with `FIELD_NO_SEED_ENV=1`.
3. **`init` is hard for agents to drive (P2, product).** The interactive stdin
   prompts took 20+ attempts to get through; no non-interactive flag path.
4. **`.js → .ts` conversion leaves `.decanter.json` stale (P2, product).** The
   agent swapped the file + re-pointed the `//@file:` placeholder correctly, but
   the node→file map still pointed at the deleted `.js` (needs a `pull` reconcile,
   or push should re-key it).
5. **Positive:** decanter's scaffolded `AGENTS.md` steered the agent **file-first**
   for code before it ever tried `jsCode` over MCP — the guard never needed to
   block (answers Plan 50's "does the nudge bite?" — the contract pre-empts it).

Detailed per-turn grading + the S3 drift-guard scenario (its preHook/prompt
alignment was fixed after round-1b) are the next exploration pass.

## Layout (blinding)

The agent's cwd is `workDir` (neutral name). All harness artifacts live in a
**sibling** `harnessRoot` the agent never enters, so the manifest's metadata
can't leak into a blind session. `git init` in `workDir` stops CLAUDE.md
discovery there, so the decanter repo can't leak in either.
