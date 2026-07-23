# Blind-agent field test (Plan 35)

Dev-only harness that puts the **whole product** — `init` → skills/MCP structure
work → Code-node authoring → `push` → runs — in front of **blind** Sonnet coding
agents acting as typical users against a real n8n in Docker, and grades what
happens. A UX/contract field test, **not** a CI suite (cost + nondeterminism
rule that out). Never part of `npm test`.

## Pieces

| File | Role |
| --- | --- |
| `stage.mts` | Boots + provisions a throwaway n8n (or targets `FIELD_N8N_URL`), seeds realism workflows + an S1 skeleton, scaffolds a **neutral** scratch project (git, skills pack), prints a **manifest**. |
| `skills-install.mts` | Installs the official n8n skills pack (`n8n-io/skills`) into the scratch project the way a real user would. |
| `scenarios/S1–S5.md` | Persona / goal / adaptive beats / success checklist + a machine-readable `## Orchestration` turn spine. `STYLE.md` = the blinding rules. |
| `run.mts` | Orchestrator: replays each scenario's scripted turns as headless `claude -p --model sonnet` sessions, captures transcripts + the guard's stderr, runs `verify.mts` after each. |
| `verify.mts` | Scripted invariant checks (no LLM): byte-equality, placeholders, TS marker-hash relation, `.decanter.json` git-history — exit 1 on any violation. |

## Run it (UNSANDBOXED)

Nested `claude` needs the Anthropic API and `fs.watch`/FSEvents dies under a
sandbox — **run the whole thing in a normal terminal**, not a sandboxed agent
shell. A coding agent running this must run it outside its command sandbox.

```sh
# 1. stage — boots n8n in Docker (needs a running Docker daemon), prints a manifest
npm run field-test:stage
#    → MANIFEST=/…/ftrun-<pid>/manifest.json   (last line)

# 2. round 1 — blind Sonnet sessions for S1–S4 (or name scenarios)
node scripts/field-test/run.mts /…/manifest.json            # S1 S2 S3 S4
node scripts/field-test/run.mts /…/manifest.json S1 --dry-run   # print turns, spawn nothing

# 3. invariants (run.mts already calls this per scenario; re-run any time)
npm run field-test:verify /…/manifest.json

# 4. teardown — removes the container + scratch dirs
node scripts/field-test/stage.mts --down /…/manifest.json
```

Target an already-running local instance instead of booting one:

```sh
FIELD_N8N_URL=http://127.0.0.1:5678 FIELD_MCP_TOKEN=<tok> FIELD_API_KEY=<key> \
  npm run field-test:stage
```

Env knobs: `FIELD_N8N_TAG` (image; default matches `test/smoke-n8n.mts`),
`FIELD_N8N_URL`/`FIELD_MCP_TOKEN`/`FIELD_API_KEY` (external instance),
`FIELD_KEEP=1` (keep the container on `--down`).

## After a run — grade + report (Opus, unblinded)

`run.mts` produces the artifacts; **grading is a separate Opus pass** (it needs
judgment `verify.mts` can't give):

1. **Contamination check** — scan each transcript for signs the agent inferred
   an evaluation (judging *intent*, not the mere presence of the `test`/
   `scenario` verbs). A suspected-leak run is flagged + re-run, **not graded**.
2. **Rubric** — task success per each scenario's checklist; process conformance
   (code via files+push, structure via MCP, orient-before-edit); guard events
   classified (working-as-intended vs confusing); friction log (each item tied
   to the exact CLI/docs surface); turns/time to done. Record **whether agents
   discover + use `preflight`**.
3. **Evidence** — from `guard.log`: did the skills' routing nudge bite? (agents
   attempting `jsCode` over MCP → guard block warn-line) — cross-reference from
   [Plan 50](../../plans/draft/50-code-node-authoring-skill.md).
4. **Report** — append `## Run report — round 1` to
   [plans/open/35-blind-agent-field-test.md](../../plans/open/35-blind-agent-field-test.md):
   per-scenario verdicts, invariant results, ranked findings (severity ×
   surface). Findings → **maintainer triage** (this plan changes no product
   code).

## Layout (blinding)

The agent's cwd is `workDir` (neutral name). All harness artifacts — manifest,
transcripts, `guard.log` — live in a **sibling** `harnessRoot` the agent never
enters, so the manifest's metadata (seeded kinds, "field test", …) can't leak
into a blind session. `git init` in `workDir` stops CLAUDE.md discovery there,
so the decanter repo can't leak in either.
