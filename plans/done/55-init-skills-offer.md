# Plan 55 — `init` points at the official n8n skills pack

**Status:** Done
**Priority:** P1
**Source:** User request 2026-07-24 ("during init, ask whether to install n8n-skills
for Claude Code / Codex / Others (skills.sh) / Nothing — recommended for agentic
workflow creation"), **scoped down by the same conversation** to print-only (see
[Design decision](#design-decision--why-it-prints-instead-of-installing)). Closes
the discoverability gap left by [`docs/agents/n8n-skills.md`](../../docs/agents/n8n-skills.md)
and [Plan 30](../open/30-agent-llm-working-ergonomics.md); reuses the field-test prior
art in `scripts/field-test/skills-install.mts` ([Plan 35](../open/35-blind-agent-field-test.md)).
**Snapshot:** 2026-07-24T08:17Z @ f419108
**Theme:** Setup is the only moment the user is in "wire up my agent" mindset —
name the pack there instead of on a docs page they read afterwards, if ever.
**Model:** Opus (design-sensitive: the scope call is the whole plan)
**Class:** Distinctive feature — no other n8n-as-code tool onboards the *agent's*
knowledge layer as part of repo setup.

## Why

decanter's pitch is "your agent builds structure over n8n's MCP; decanter owns
the Code-node source." The first half only works well when the agent has n8n's
official skills pack. Today that pairing lives on `docs/agents/n8n-skills.md` and
in the scaffolded `AGENTS.md` — both read *after* setup, if at all. `init`
already scaffolds the guarded MCP route (`.mcp.json` → `mcp connect`), the agent
contract, and the hooks; the knowledge layer was the one piece it left on the
floor.

## What shipped

A first `init` (no `.decanter-template.json` yet) closes with:

```text
Recommended: n8n's official skills pack (n8n-io/skills) — it teaches your agent to
build workflow structure over MCP while decanter keeps every Code node a file.
  Claude Code (detected)
    claude plugin marketplace add n8n-io/skills
    claude plugin install n8n-skills@n8n-io
    then /reload-plugins (or restart Claude Code)
  Codex
    …
  other agents (skills.sh)
    …
  guide: …/docs/agents/n8n-skills/
```

- **Output only.** No prompt, no subprocess, no flag. Every route always listed;
  detection (env → `PATH` → `~/.claude`/`~/.codex`, **spawning nothing**) only
  decides which is first and marked `(detected)`.
- **Once per sync dir**, on every path — piped, TTY, and `--host`-driven alike.
- **Consumes no input**, so no existing script's stdin changes.

## Design decision — why it prints instead of installing

The request was a four-way install prompt. Three findings turned that into
print-only; the discoverability win (the actual point) survives intact, the risk
does not.

**Verified upstream facts** (2026-07-24):

- **Our docs shipped a copy-paste-broken command.** `/plugin marketplace add` /
  `/plugin install` are **in-session slash commands**; `docs/agents/n8n-skills.md`
  and `template/AGENTS.md.example` presented them inside a ```sh fence. The shell
  equivalents (`claude plugin marketplace add` / `claude plugin install`) do
  exist and are documented for non-interactive scripts. **Fixed here, and the
  fix is independent of everything else in this plan.**
- **Claude Code's plugin-hint protocol cannot be used.** A CLI can emit
  `<claude-code-hint v="1" type="plugin" value="name@marketplace" />` on stderr
  and Claude Code shows a one-time install prompt — exactly this feature, built
  by the vendor, with first-run named as a recommended placement. But hints are
  **silently dropped unless the plugin is in an Anthropic-controlled
  marketplace**; `n8n-skills@n8n-io` is third-party. Revisit if that changes.
- **`npx skills` is `vercel-labs/skills`**, not an n8n or Anthropic artifact; it
  prompts unless given `-y`, and installs to `./.claude/skills/` by default.

**Why not prompt:**

1. A fourth positional answer enters init's stdin, which piped scripts (and the
   e2e suite) fill with exactly three lines. TTY-gating dodges that but then the
   feature doesn't exist for the agent-driven path, which is most of them.
2. `init` bootstraps a *directory*; the Claude Code and Codex installs mutate
   **user-global** agent state. An installer editing your shell profile is the
   same smell.
3. **The session that installs it doesn't get it** — a plugin needs
   `/reload-plugins` or a restart, so an agent that runs `init` gains nothing
   this session. The subprocess buys the user nothing a printed command doesn't.
4. Three third-party CLIs with their own version floors (`codex plugin` needs
   ≥ 0.142.0), executed at the most fragile moment of onboarding, is a real
   supply-chain and fragility surface — plugins run arbitrary code with user
   privileges, per Anthropic's own warning.
5. "Which agent do you use?" is largely detectable, so the question was partly
   asking for what the tool can already work out.

**Why no `--skills print|none` flag** (a first draft had one): the block is
printed once per sync dir, ever. A CLI surface to suppress ~8 lines of first-run
output is more cost than the noise it removes.

**Who owns actually installing:** [Plan 56](../draft/56-declarative-claude-plugin-scaffold.md) —
declarative `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`),
which is idempotent, in git, and covers everyone who clones the repo rather than
only whoever ran `init`. It needs a template-shape decision first.

## Non-goals

- Vendoring or forking the skills pack (the field-test harness does that, and
  documents the fidelity gap: vendored `skills/*` ≠ plugin — no SessionStart
  router, no PreToolUse hooks, no `plugin:` namespacing).
- Detecting whether the pack is already installed (no stable cross-agent probe;
  printing once per sync dir bounds the noise anyway).
- Any behavior change to `pull`/`push`/the guard.

## Tasks

1. ✅ **`lib/skills.mts`** — `SKILLS_REPO`/`SKILLS_PLUGIN`/`SKILLS_DOCS`
   constants, `detectAgent(env, pathValue, homeDir)`, `skillsCommands(route,
   detected)`, `activationHint(route)`, `routeOrder(detected)`, and
   `printSkillsRecommendation(detected, log)`. No `child_process` import at all
   — the commands are data.
2. ✅ **`lib/init.mts`** — compute `firstInit` before `refreshTemplate`; print
   the block after the verification probes when `firstInit`.
3. ✅ **`template/AGENTS.md.example`** — split the install lines into
   in-session vs shell forms, and add the `using-n8n-skills-official` routing
   cue section the plugin-less skills.sh route needs (always-true prose, so it
   creates no `.decanter-template.json` drift).
4. ✅ **Tests** — `test/unit/skills.test.mts` (detection precedence, the pinned
   command table, route order, activation hints); `test/e2e.mts` extended to
   prove a piped init still consumes exactly three answers and writes an
   identical `.env`, that the printed commands are shell (never `/plugin …`),
   that a re-init stays quiet, and that the `--host`-driven path prints it too.
5. ✅ **Docs** — `docs/cli/init.md`, `docs/agents/n8n-skills.md`, `README.md`,
   `CHANGELOG.md` (`Added` + `Fixed`), `PLAN.md` "Init flow" step 6.

## Acceptance / verification

- `printf "host\ntoken\nkey\n" | n8n-decanter init dir` → byte-identical `.env`
  to before, plus the block. ✅
- Re-init → silent. ✅
- `--host`/`--token` path → prints, still prompt-free. ✅
- Printed commands are shell, never `/plugin …`. ✅
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:docs` green. ✅

Because nothing prompts and nothing spawns, there is **no untestable path left**
— the earlier draft's caveat about needing a pty to verify the question is moot.

## Notes

- CHANGELOG: `Added` (the pointer) + `Fixed` (the slash-command-as-shell docs
  bug).
- PLAN.md: "Init flow" gained step 6; the template-AGENTS.md paragraph records
  the two-forms split and the routing cue.
- Follow-up: [Plan 56](../draft/56-declarative-claude-plugin-scaffold.md).
