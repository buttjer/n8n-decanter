# Plan 56 — scaffold the n8n skills plugin declaratively for Claude Code

**Status:** Draft
**Priority:** P3
**Source:** Deferred alternative recorded in [Plan 55](../done/55-init-skills-offer.md).
**Snapshot:** 2026-07-24T08:17Z @ f419108

Plan 55 installs the skills pack by **shelling out** to `claude plugin …`. For
Claude Code there is a strictly better route that decanter didn't take yet:
declare it in the sync dir's own `.claude/settings.json` —

```json
{
  "extraKnownMarketplaces": { "n8n-io": { "source": { "source": "github", "repo": "n8n-io/skills" } } },
  "enabledPlugins": ["n8n-skills@n8n-io"]
}
```

Claude Code then prompts each user to install the marketplace + plugin when they
trust the folder, and reports the exact `claude plugin install` command until
they do.

**Why it's better:** no subprocess, no third-party CLI version coupling,
idempotent (survives re-init), reviewable in git, and it covers **everyone who
clones the repo** rather than only the person who ran `init`.

**Why it was deferred:** the template ships `.claude/settings.local.json`
(per-machine, gitignored-ish) but no shared `.claude/settings.json`. Adding one
is a template-shape decision — it becomes a committed file that also carries
permissions, so it needs its own thought about what else belongs in it and how
it interacts with the existing `settings.local.json` and the
`mcp-route-check.mjs` hook.

**Scope if picked up:** add `template/.claude/settings.json.example` with the two
keys, make Plan 55's `claude-code` target write/merge it instead of (or as well
as) shelling out, and check whether Codex has an equivalent declarative hook.
Watch out: the file is manifest-tracked, so merging into a user-edited copy has
to respect the drift rules.
