# Plan 55 — `init` offers to install the official n8n skills

**Status:** Done
**Priority:** P1
**Source:** User request 2026-07-24 ("during init, ask whether to install n8n-skills
for Claude Code / Codex / Others (skills.sh) / Nothing — recommended for agentic
workflow creation"). Closes the discoverability gap left by
[`docs/agents/n8n-skills.md`](../../docs/agents/n8n-skills.md) and
[Plan 30](30-agent-llm-working-ergonomics.md); reuses the field-test prior art in
`scripts/field-test/skills-install.mts` ([Plan 35](35-blind-agent-field-test.md)).
**Snapshot:** 2026-07-24T08:17Z @ f419108
**Theme:** The setup moment is the only moment the user is in "wire up my agent"
mindset — make the skills pairing a one-keystroke yes there instead of a docs page.
**Model:** Opus (design-sensitive: shells out to third-party CLIs, touches the
scriptable init contract)
**Class:** Distinctive feature — no other n8n-as-code tool bootstraps the *agent's*
knowledge layer as part of repo setup.

## Why

decanter's whole pitch is "your agent builds structure over n8n's MCP; decanter
owns the Code-node source." The first half only works well when the agent has
n8n's official skills pack. Today that pairing is documented on
`docs/agents/n8n-skills.md` and restated in the scaffolded `AGENTS.md` — both of
which the user reads *after* setup, if ever. `init` already scaffolds the guarded
MCP route (`.mcp.json` → `mcp connect`), the agent contract, and the hooks; the
knowledge layer is the one piece of the agent setup it leaves on the floor.

## Design decision — what `init` does and does not do

**Offer, at the tail of a first init, on a TTY only.** The four choices the user
asked for, with the detected agent pre-selected:

```
Install the official n8n skills? (recommended for agentic workflow building)
  1) Claude Code  (detected)
  2) Codex
  3) Other agent — skills.sh
  4) Skip
```

Four rules hold the design together; each exists because of a verified failure
mode (see [Validation](#validation--criticism-of-the-design)):

1. **TTY-only, first-init-only.** A piped run (`printf "host\ntoken\nkey\n" |
   n8n-decanter init`) must consume *exactly* the stdin it consumes today — a
   fourth positional answer would silently break every existing script and the
   e2e suite. Piped and re-init runs get the **printed commands** instead of a
   prompt. "First init" = no `.decanter-template.json` yet (already computed in
   `refreshTemplate`) — no new state file needed to avoid re-asking.
2. **`--skills <claude-code|codex|skills-sh|none|print>`** drives it headlessly.
   Critically, `--skills` must **not** count toward init's `flagDriven` switch —
   passing it must not silently suppress the host/token/API-key prompts.
3. **Print the exact command before running it**, and never fail init on an
   install error — warn, print the manual commands, continue.
4. **Detection reads the environment, never spawns anything**: `CLAUDECODE` /
   `CODEX_*` env vars, `claude` / `codex` on `PATH` (a `PATH` split + `existsSync`,
   not `which`), `~/.claude` / `~/.codex`. Detection only picks the *default*
   answer; the user always chooses.

Commands run per choice (all verified against upstream docs, 2026-07-24):

| Choice | Commands | Notes |
|---|---|---|
| Claude Code | `claude plugin marketplace add n8n-io/skills` → `claude plugin install n8n-skills@n8n-io` | Real **shell** CLI, documented for non-interactive use; installs to user scope unless `--scope` is passed. Needs `/reload-plugins` or a restart to activate. |
| Codex | `codex plugin marketplace add n8n-io/skills` → `codex plugin add n8n-skills@n8n-io` | Needs Codex ≥ 0.142.0; Codex prompts once to trust the plugin's hooks. |
| Other (skills.sh) | `npx skills add n8n-io/skills -y [-a <agent>]` | `vercel-labs/skills`; project scope by default. **No SessionStart hook** on this route — the routing cue has to come from `AGENTS.md`. |
| Skip | — | Prints the docs pointer once. |

**The scaffolded `AGENTS.md` carries the routing cue unconditionally.** n8n's
README requires a `using-n8n-skills-official` routing snippet for every
non-plugin install. Rather than appending it conditionally (which would show up
as template drift in `.decanter-template.json` forever), `template/AGENTS.md.example`
gains a short always-true section: *if the pack is installed as plain skills,
load the meta-skill first*. Zero code, zero drift.

## Validation / criticism of the design

Recorded because most of it is non-obvious and was only settled by checking
upstream. **The idea is right; three of the four naive implementations are not.**

**Verified facts that changed the design:**

- **The Claude Code snippet in our docs is not shell.** `/plugin marketplace add`
  / `/plugin install` are **in-session slash commands** — `docs/agents/n8n-skills.md`
  and `template/AGENTS.md.example` currently present them inside a ```sh fence,
  which is copy-paste-broken in a terminal. The shell equivalents
  (`claude plugin marketplace add` / `claude plugin install …@…`) do exist and are
  explicitly documented for non-interactive scripts. **This doc bug is fixed here
  regardless of the feature.**
- **Claude Code's plugin-hint protocol cannot be used.** Claude Code strips a
  `<claude-code-hint v="1" type="plugin" value="name@marketplace" />` line from a
  CLI's stderr and offers a one-time install prompt — a far more elegant fit than
  a decanter-owned prompt (it's Anthropic's own answer to "a CLI wants to
  recommend a plugin", and its documented best placements are exactly
  first-run/auth-success). But hints are **silently dropped unless the plugin is
  in an Anthropic-controlled marketplace**. `n8n-skills@n8n-io` is third-party →
  dropped. Re-evaluate if n8n ever lands in `claude-plugins-official`.
- **`npx skills` is `vercel-labs/skills`**, not an n8n or Anthropic artifact; it
  prompts interactively unless given `-y` / `-a <agent>`, and installs to
  `./.claude/skills/` (project scope) by default.

**Real objections to the feature as literally specified, and how each is answered:**

1. **Scope violation — `init` bootstraps a *directory*, but the Claude Code and
   Codex installs mutate *user-global* agent state (`~/.claude`).** An installer
   editing your shell profile is the same smell. → Answered by: never silent
   (prints the command, asks first), never on re-init, and `--skills none` /
   `Skip` is always one keystroke. Not fully eliminated — it's inherent to the
   ask. The declarative alternative below removes it entirely for Claude Code.
2. **The session that installs the plugin doesn't get it.** When an *agent* runs
   `init` (the `--host/--token` path exists because agents couldn't drive the
   prompts — Plan 35), `claude plugin install` lands the plugin but the running
   session needs `/reload-plugins` or a restart. → Answered by printing that
   instruction, and by the prompt being TTY-only (an agent's `init` never
   prompts; it must opt in with `--skills`).
3. **Shelling out to three third-party CLIs is a real supply-chain and fragility
   surface.** Plugins execute arbitrary code with user privileges (Anthropic's
   own warning); `codex plugin` needs ≥ 0.142.0; `npx skills` flags are outside
   our control; the strings `n8n-skills@n8n-io` are renameable by n8n. → Answered
   by: opt-in only, command echoed before execution, best-effort (never fails
   init), single source of the strings in `lib/skills.mts`, and a unit test that
   pins the command table so a rename is a deliberate edit.
4. **Asking a question the tool can answer is bad UX.** "Which agent do you use?"
   is detectable. → Answered by detection driving the default; the question
   survives because detection is a heuristic and multiple agents can coexist.
5. **It duplicates the template's job.** `AGENTS.md` + `.mcp.json` +
   `mcp-route-check.mjs` already own "make the agent behave here". → Partly true,
   and why the routing cue goes in `AGENTS.md` rather than into code.

**Better alternative, deliberately deferred (not rejected):** for Claude Code,
the *declarative* route beats shelling out on every axis — write
`extraKnownMarketplaces` + `enabledPlugins` into the sync dir's
`.claude/settings.json`, and Claude Code prompts each teammate to install on
folder trust. It is idempotent, reviewable in git, survives re-init, and covers
**everyone who clones the repo** rather than only the person who ran `init`. It
is deferred because the template ships `settings.local.json` (per-machine) but no
shared `.claude/settings.json`, so adopting it is a template-shape decision worth
its own plan. Captured as a follow-up draft; the CLI strings live in one module
so switching is a small change.

## Non-goals

- Vendoring or forking the skills pack (that's the field-test harness's job, and
  it documents the fidelity gap: vendored `skills/*` ≠ plugin — no SessionStart
  router, no PreToolUse hooks, no `plugin:` namespacing).
- Detecting whether the pack is *already* installed (no stable cross-agent probe;
  re-running the installers is idempotent enough and first-init-only bounds it).
- Any behavior change to `pull`/`push`/the guard.

## Tasks

1. **`lib/skills.mts`** — new module, no I/O beyond an explicit runner:
   - `SKILLS_REPO` / `SKILLS_PLUGIN` constants (`n8n-io/skills`, `n8n-skills@n8n-io`).
   - `type SkillsTarget = "claude-code" | "codex" | "skills-sh" | "none" | "print"`.
   - `detectAgent(env, pathValue, homeDir)` → `"claude-code" | "codex" | null`
     (pure; env > PATH > home marker).
   - `resolveSkillsTarget({flag, interactive, flagDriven, firstInit})` →
     target | `"ask"` — the whole decision matrix as one pure function, so it
     unit-tests without a terminal (see [Acceptance](#acceptance--verification)).
   - `skillsCommands(target, detected)` → `string[][]` (pinned by unit test).
   - `runSkillsInstall(target, dir, log)` — echoes each command, runs with
     `stdio: "inherit"` and a timeout, warns + prints manual commands on failure,
     never throws.
   - `printSkillsRecommendation(detected, log)` — the non-TTY/skip path.
2. **`lib/init.mts`** — compute `firstInit` before `refreshTemplate`; after the
   verification probes, run the offer. Prompt only when
   `interactive && !flagDriven && firstInit && skills === undefined`; reuse the
   single shared `rl` session (open a second one and piped answers are lost — the
   bug PLAN.md already records twice).
3. **`n8n-decanter.mts`** — parse `--skills <target>`, validate the value, pass it
   through, and **exclude it from `flagDriven`**. Update the init usage line.
4. **`template/AGENTS.md.example`** — replace the slash-command-as-shell install
   lines with a correct shell/in-session split, and add the
   `using-n8n-skills-official` routing cue section.
5. **Tests**
   - `test/unit/skills.test.mts` — detection precedence + the pinned command table
     + `none`/`print` produce no commands.
   - `test/e2e.mts` — extend the existing init step: piped init still consumes
     exactly three answers and writes the same `.env` (the regression this plan
     most risks), prints the recommendation block, and `--skills none` silences
     it. **No test ever executes a real installer.**
6. **Docs (all surfaces, same PR)** — `docs/cli/init.md` (new section + flag),
   `docs/agents/n8n-skills.md` (shell vs in-session fix + "init offers this"),
   `README.md` (skills section note), `CHANGELOG.md` `[Unreleased] → Added`,
   `PLAN.md` "Init flow" step 6.

## Acceptance / verification

- `printf "host\ntoken\nkey\n" | n8n-decanter init dir` → byte-identical `.env` to
  today, no prompt, recommendation block printed once.
- `n8n-decanter init dir --skills none` → no offer, no recommendation block.
- `n8n-decanter init dir --host … --token …` → non-interactive as today, no offer.
- Re-init → never offers again.
- A failing/absent `claude` binary warns and prints the manual commands; init
  still exits 0.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:docs` green.

**Coverage note (honest boundary).** Every decision the feature makes is unit-
tested through `resolveSkillsTarget` / `parseSkillsAnswer` / `skillsCommands`,
and every non-TTY path is covered end-to-end at the CLI surface. The one link
not exercised by CI is the literal readline round-trip of the question on a real
terminal: the repo's only pty tool is `expect`, and agent sandboxes here can
allocate neither a pty nor `fs.watch` (the same environment limit AGENTS.md
already records for the watch steps). Worth one manual `n8n-decanter init` in a
real terminal before release.

## Notes

- CHANGELOG: `[Unreleased] → Added` (user-facing new prompt + flag) **plus** a
  `Fixed` line for the copy-paste-broken slash-command-in-a-`sh`-fence in the
  docs and template.
- PLAN.md: "Init flow" gains step 6; the `Relation to the official skills`
  section gains the pointer that init now offers the install.
- Follow-up draft to file: the declarative `.claude/settings.json`
  (`extraKnownMarketplaces` + `enabledPlugins`) route for Claude Code.
