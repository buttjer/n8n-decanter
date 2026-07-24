# Plan 56 — scaffold the n8n skills plugin declaratively for Claude Code

**Status:** Draft
**Priority:** P3
**Source:** Deferred alternative recorded in [Plan 55](../done/55-init-skills-offer.md).
**Snapshot:** 2026-07-24T08:17Z @ f419108

Plan 55 deliberately stops at **printing** the install commands. Actually
installing is this plan's job, and for Claude Code the right mechanism is
declarative rather than a subprocess: declare it in the sync dir's own
`.claude/settings.json` —

```json
{
  "extraKnownMarketplaces": { "n8n-io": { "source": { "source": "github", "repo": "n8n-io/skills" } } },
  "enabledPlugins": ["n8n-skills@n8n-io"]
}
```

Claude Code then prompts each user to install the marketplace + plugin when they
trust the folder, and reports the exact `claude plugin install` command until
they do.

**Why it's better than shelling out:** no subprocess, no third-party CLI version
coupling, idempotent (survives re-init), reviewable in git, and it covers
**everyone who clones the repo** rather than only the person who ran `init`.

**The blocker — and it's really one question:** the template ships
`.claude/settings.local.json.example` but no shared `.claude/settings.json`.
That file is arguably **misnamed today**: its contents (decanter verb
permissions, the `verify.mjs` PostToolUse hook, the `mcp-route-check.mjs`
SessionStart hook) are project policy, not per-machine preference; nothing in it
is machine-specific; init's scaffolded `.gitignore` does not ignore it, so it is
already being committed; and it is tracked in `.decanter-template.json`, a
baseline the docs tell users to commit. Meanwhile it **occupies the user's own
personal-override slot** — Claude Code's `settings.local.json` is where a user
puts machine-specific rules, and decanter has taken it.

**So the first task is the rename**, `template/.claude/settings.local.json.example`
→ `settings.json.example`, which then makes this plan trivial. Two things it
must handle:

- **Precedence flip.** `settings.local.json` > `settings.json`, so decanter's
  `deny` rules (e.g. `Bash(n8n-decanter push --force)`) move from the
  highest-precedence file to a lower one, and a user's own local file can now
  override them. Acceptable — those denies are a guardrail, not the security
  boundary (`mcp connect` is), and a user overriding their own settings is
  legitimate — but it should be a conscious call.
- **Migration.** Existing sync dirs have `settings.local.json` tracked in
  `.decanter-template.json`. A naive rename copies in a new `settings.json` and
  leaves the stale `settings.local.json` behind — two overlapping files with the
  **stale one winning**. `init` needs to detect the old tracked file and migrate
  or warn loudly.
- Also update `scripts/field-test/run.mts` (it merges its allow-extension into
  `settings.local.json` — which becomes *more* correct after the split: shared
  policy in `settings.json`, the harness's machine-specific allows in
  `settings.local.json`), `template/CLAUDE.md.example:7`, and `AGENTS.md:493`,
  which uses the filename as the `.example`-convention example.

**Then:** add the two keys above to the new `settings.json.example`, and check
whether Codex has an equivalent declarative hook (unknown — n8n's README only
documents `codex plugin …`). skills.sh has none.
