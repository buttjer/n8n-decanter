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

- **Precedence — checked, and it is a non-issue for the deny rules.** Ordinary
  settings do follow `local` > `project` > `user`, but **permission rules merge
  across scopes rather than override**, and denylist beats allowlist. So moving
  decanter's `deny` entries (e.g. `Bash(n8n-decanter push --force)`) into
  `settings.json` does **not** let a user's own `settings.local.json` allow them
  back. (An earlier revision of this draft claimed the opposite.) Hooks are
  additive across scopes too. Verify once against the shipped file before
  relying on it.
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

## Ship it as two PRs, in this order

The two halves have different risk profiles and should not share a squash commit:

- **(A) the rename + migration** — a correctness fix touching a manifest-tracked
  file in *every existing sync dir*. `Changed`, plausibly `Breaking:`. No new
  feature; reviewable on its own.
- **(B) the two plugin keys** — ~6 lines once (A) exists, `Added`.

Doing (A) alone is worth it even if (B) is never picked up.

## Open decisions (settle before executing)

1. **Does `enabledPlugins` ship default-on?** This is the real product question,
   and it cuts against [Plan 55](../done/55-init-skills-offer.md)'s own
   reasoning: a committed declaration installs a **third-party** plugin for
   *everyone who clones the repo*, silently and persistently — arguably more
   invasive than the init prompt Plan 55 removed, not less. Mitigations: Claude
   Code still asks on folder trust and never installs unprompted; it is two
   readable lines in a git-tracked file. Options: default-on / shipped commented
   out / behind an `init` opt-in. **Not obvious — decide deliberately.**
2. **Migration semantics.** The template machinery is drift-aware, so the
   natural rule is: a *pristine* `settings.local.json` (hash == manifest
   baseline) is removed and replaced by `settings.json`; a **locally modified**
   one is never deleted — it is left in place with a loud warning that it now
   shadows the new file. Confirm that is the wanted behavior.
3. **What else belongs in the shared file?** Once a committed
   `.claude/settings.json` exists, does the template still ship a
   `settings.local.json.example` for genuinely per-user allows, or does the
   local slot stay empty for the user?
4. **Codex.** No verified declarative equivalent. Shipping Claude-Code-only
   (Codex/skills.sh keep the printed commands) is fine, but it should be a
   conscious asymmetry.
