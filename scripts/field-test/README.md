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
| `report.mts` | **Renders a run's transcripts into ONE self-contained HTML report** — a chat-style timeline of each blind session (prompts, agent reasoning, every tool call + result, guard log, verdicts). Secrets redacted. This is how you *see what happened in the agentic part*. |
| `scenarios/S1–S5.md` + `STYLE.md` | Persona / goal / adaptive-beats / checklist + a machine-readable `## Orchestration` turn spine; blinding rules verbatim. |

## Run it (UNSANDBOXED)

Nested `claude` needs the Anthropic API and must reach the local n8n, and
`fs.watch` dies under a sandbox — **run in a normal terminal**. If you drive this
from a coding agent whose Bash is sandboxed, exclude the field-test commands from
its sandbox (e.g. Claude Code `sandbox.excludedCommands`:
`node scripts/field-test/run.mts *`, `node scripts/field-test/stage.mts *`).

```sh
npm run field-test:stage                       # boots n8n, links our CLI, prints MANIFEST=<path>
node scripts/field-test/run.mts <manifest> --smoke      # (debug) one claude turn works? → READY
node scripts/field-test/run.mts <manifest> --netcheck   # (debug) can the agent reach n8n? → 200
node scripts/field-test/run.mts <manifest> S1 S2 S3 S4  # the blind round (or a subset)
npm run field-test:report <manifest>           # → <harnessRoot>/report.html  (open it)
npm run field-test:verify <manifest>           # re-run the invariant checks any time
node scripts/field-test/stage.mts --down <manifest>     # teardown (container + scratch dirs)
```

## Container mode (`--container`) — safe UNATTENDED runs

Host mode runs the blind `claude` **unsandboxed on your machine** with auto-`Bash`
— fine when you're watching, but risky unattended. `--container` runs each blind
session inside a Docker container that is **egress-fenced to `api.anthropic.com`
only** (a tinyproxy allowlist sidecar) with **no host filesystem and no host env
beyond one `ANTHROPIC_API_KEY`**. Even an injected/looping agent can reach only
Anthropic + the throwaway n8n. See `docker/docker-compose.yml` — it *is* the
isolation contract. Design + validation notes live in the Plan 35 "Container
mode" section.

```sh
cp scripts/field-test/.env.example scripts/field-test/.env   # then add ANTHROPIC_API_KEY (low spend cap)
npm run field-test:stage                                     # prints MANIFEST=<path>
node scripts/field-test/run.mts <manifest> --container --precheck   # $0 plumbing check: baked CLI loads + n8n reachable
node scripts/field-test/run.mts <manifest> --container --smoke      # one fenced claude turn → READY
node scripts/field-test/run.mts <manifest> --container S1 S2 S3 S4  # the fenced blind round
node scripts/field-test/stage.mts --down <manifest>                 # teardown
```

- The key is read via `docker compose --env-file scripts/field-test/.env`; it
  flows only into the `agent` service (never the proxy, never a log, never git).
- The CLI + `typescript` are **baked into a per-run image at build time** (the
  fence has no npm registry); the host's macOS `node_modules` are shadowed so
  nothing platform-wrong runs. `FIELD_RUN_BUDGET_MIN` (default 60) is a total
  wall-clock kill so an unattended round can't run — or bill — forever.
- `S5` (`watch`) stays host-only (`fs.watch` on container mounts is unreliable).
- Invoke `run.mts`/`stage.mts` **directly** (not via `npm run …`) when driving
  from a sandboxed agent, so the `node scripts/field-test/*` sandbox exclusion
  applies and `docker build` can run.

`run.mts <manifest> S1 --dry-run` prints the filled turns and spawns nothing.

## Debugging

- **Diagnostics first.** `--smoke` proves headless `claude -p` works (auth, flags,
  stream parsing); `--netcheck` proves the blind session can reach n8n. Run both
  before a full round when something looks off.
- **Artifacts** (in `<harnessRoot>`, a sibling dir the agent never enters):
  `transcripts/<S>/turn-N.jsonl` (stream-json), `verify-<S>.json`, `guard.log`,
  and `report.html`. The **report** is the fastest way to read a session.
- **Every round auto-archives** — at the end of a run, `run.mts` renders the
  report and copies the whole `harnessRoot` **plus** the workDir (with its
  `.git`) and per-turn `snapshots/` into
  **`<main-checkout>/.field-test-runs/<runId>/`** (gitignored), together with a
  `manifest.json` whose paths point at the archived copies — so any view
  re-renders from the raw without re-running:
  `node scripts/field-test/report.mts .field-test-runs/<runId>/manifest.json`.
  The archive deliberately lands in the **main checkout**, never the cwd: rounds
  are usually driven from a linked worktree, and `git worktree remove` would
  otherwise delete the artifacts. `FIELD_ARCHIVE_DIR` overrides the location.
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
