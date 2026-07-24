# Plan 56 — scaffold the n8n skills plugin declaratively for Claude Code

**Status:** In progress — **(A) done, (B) not started** (see
[Ship it as two PRs](#ship-it-as-two-prs-in-this-order))
**Priority:** P3
**Source:** Deferred alternative recorded in [Plan 55](../done/55-init-skills-offer.md).
**Snapshot:** 2026-07-24T09:11Z @ 683955c

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

- ✅ **(A) the rename + migration** — a correctness fix touching a
  manifest-tracked file in *every existing sync dir*. `Breaking:` `Changed`. No
  new feature; reviewable on its own. **Shipped** — see below.
- ⬜ **(B) the two plugin keys** — ~6 lines once (A) exists, `Added`. Blocked on
  open decision 1.

Doing (A) alone was worth it even if (B) is never picked up.

### (A), as shipped

- `template/.claude/settings.local.json.example` → `settings.json.example`
  (contents unchanged).
- `TEMPLATE_RENAMES` + `migrateRenamedTemplateFiles` in `lib/init.mts` — the
  template machinery had no way to express a *renamed* file, since the manifest
  is keyed by path. Resolved before the scan, file-driven (a rename doesn't
  change contents, so hashing settles provenance even for pre-manifest dirs):
  not ours → untouched; ours + pristine → deleted so the scan lands the new
  name; ours + edited → kept and the new name **skipped** this run, with the old
  key carried over in the manifest so the next re-init still knows it is ours;
  both present → reported. `--force` removes the old file regardless.
- e2e coverage for all four migration branches; docs/CHANGELOG/PLAN.md updated.

**Field-test harness — owned by [Plan 35](35-blind-agent-field-test.md), not
here.** `scripts/field-test/stage.mts` pre-wrote `workDir/.claude/settings.json`
for its sandbox override, which after this rename makes the template scan
`adopt` it, so decanter's permissions **and** the DENY rules the field test
exists to verify would never be scaffolded. Plan 35's
`feat/plan-35-containerized-field-test` branch fixes it independently and more
thoroughly (a `mergeLocalSettings` helper; the stage runs `init` itself now, so
the pre-write workaround is obsolete). This PR deliberately leaves
`scripts/field-test/` untouched to avoid conflicting with that branch — which
means **`field-test:stage` on main is broken between this merge and Plan 35's**.
Dev-only, opt-in, never part of `npm test`.

**Confirmed while building it:** permission lists merge across scopes and `deny`
beats `allow`, so demoting decanter's denies from `local` to `project` does not
weaken them — open decision "precedence" is settled, not just mitigated.

## Open decisions (settle before executing)

1. **Does `enabledPlugins` ship default-on?** This is the real product question,
   and it cuts against [Plan 55](../done/55-init-skills-offer.md)'s own
   reasoning: a committed declaration installs a **third-party** plugin for
   *everyone who clones the repo*, silently and persistently — arguably more
   invasive than the init prompt Plan 55 removed, not less. Mitigations: Claude
   Code still asks on folder trust and never installs unprompted; it is two
   readable lines in a git-tracked file. Options: default-on / shipped commented
   out / behind an `init` opt-in. **Not obvious — decide deliberately.**
2. ~~**Migration semantics.**~~ Settled in (A): pristine → moved; edited → kept
   and the new name deferred (not "written alongside with a warning" — two live
   settings files would double-register the hooks); never-ours → untouched.
3. ~~**What else belongs in the shared file?**~~ Settled in (A): the template
   ships **only** `settings.json`; the local slot is left empty for the user.
4. **Codex.** No verified declarative equivalent. Shipping Claude-Code-only
   (Codex/skills.sh keep the printed commands) is fine, but it should be a
   conscious asymmetry. Still open for (B).
