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
| `verify.mts` | Scripted invariant oracle (no LLM): placeholder integrity, `.js` byte-equality, `.ts` marker-hash relation, `.decanter.json` git-history, `get_workflow_history` evidence. Exit 1 on any violation. |
| `report.mts` | **Renders a run's transcripts into ONE self-contained HTML report** — a chat-style timeline of each blind session (prompts, agent reasoning, every tool call + result, guard log, verdicts), with each file change diffed under the action that caused it. Renders a live run (`<manifest>`) or a committed archive (`--from <raw.tgz>`) identically. |
| `runs/<iso>-<runId>/` | **Committed round archives** — `raw.tgz` (the source of truth) + `report.html` (the view). See *Debugging* below. |
| `scenarios/S1–S5.md` + `STYLE.md` | Persona / goal / adaptive-beats / checklist + a machine-readable `## Orchestration` turn spine; blinding rules verbatim. |

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
