# Plan 72 — Claude Code plugin: marketplace listing only

**Status:** Draft
**Priority:** P2
**Source:** Session 2026-08-04 ("is this project theoretically claude plugin
capable?") — the full-plugin idea was worked through and rejected except for
reach. Picks up the plugin findings in
[55-init-skills-offer.md](../done/55-init-skills-offer.md) (hint protocol, the
dropped Plan 56) and the skills-pack note in
[30-agent-llm-working-ergonomics.md](../open/30-agent-llm-working-ergonomics.md).
**Snapshot:** 2026-08-04T14:08Z @ 1955c62
**Theme:** decanter is invisible in the one place Claude Code users shop for
tooling — list it there, and ship nothing else through that channel.

Publish a **thin** Claude Code plugin whose only job is discovery: it shows up in
`/plugin` Discover, carries a couple of skills that point at the CLI, and leaves
the guard, hooks, permissions and scaffolding exactly where they are. Every
*technical* thing a plugin could do is either already covered by `init`'s
scaffold or better off committed in the user's repo — **reach is the only reason
left**, so the plan is deliberately a marketing surface, not a feature.

## Why

- npm reaches people who already know the tool's name. `/plugin` Discover is
  where Claude Code users browse *before* they know it.
- The onboarding channel we already ship — `init` printing the skills-pack
  commands (Plan 55) — only fires for people who already installed decanter.
  Circular; it can't be the discovery path.

## Scope

**Own marketplace ≠ discovery.** The `/plugin` **Discover** tab lists plugins
only from marketplaces the user already has, and the only one added
automatically is Anthropic's `claude-plugins-official`. A repo marketplace is
therefore reachable only by people who already know the repo name — the same
circularity as the `init` printout. Reach comes from **submission to
`anthropics/claude-plugins-community`** (third-party plugins that passed
Anthropic's automated validation and safety screening, each pinned to a commit
SHA); the official marketplace is curated at Anthropic's discretion and the
in-app submission forms feed the community catalog, not it. So step 1 is a
prerequisite artifact, step 2 is the actual goal.

1. `.claude-plugin/marketplace.json` at repo root, plus `plugin/` holding
   `.claude-plugin/plugin.json` (`name`, `description`, `keywords`, `homepage`,
   `repository`, `license`).
2. **Submit to the community marketplace** — that, not the own catalog, is what
   makes decanter findable to someone who has never heard of it. Users then run
   `/plugin marketplace add anthropics/claude-plugins-community` (manual, once)
   and `/plugin install n8n-decanter@claude-community`.
3. **Skills only.** A short entry point — what decanter is, `init`, the
   file + `push` loop — that hands off to the CLI and the scaffolded `AGENTS.md`.
   No MCP server, no hooks, no permissions (see Non-goals).
4. **Release coupling:** bump `plugin.json` `version` in the same
   `chore/release-x.y.z` PR as `package.json`. Omitting `version` makes Claude
   Code fall back to the git SHA, i.e. every commit reads as a new version.
5. **Drift guard:** teach `npm run check:docs` about the plugin so it becomes a
   checked fourth surface instead of a fifth place to forget.
6. **Dev/CI:** `claude --plugin-dir ./plugin` for local runs;
   `claude plugin validate ./plugin --strict` in CI.

## Non-goals — and why (all verified 2026-08-04 against the plugin reference)

- **No guard / `.mcp.json` in the plugin.** Project `.mcp.json` *and* a plugin
  copy means two `mcp connect` processes and duplicate tools in context; moving
  it instead strands Cursor/opencode/Codex, breaking the tool-agnostic rule.
- **No hooks in the plugin.** Plugin hooks *merge with* `settings.json` hooks and
  cannot override them → a scaffolded `verify.mjs` plus a plugin copy runs
  `preflight` twice after every edit, un-silenceable until that repo re-`init`s.
  They also gain nothing: same events, same types, including `PreToolUse`
  `updatedInput` and `PostToolUse` `updatedToolOutput`.
- **No permissions.** The manifest has no `permissions` key at all;
  `.claude/settings.json` stays committed project policy.
- **No scaffolding through the plugin.** A plugin install writes nothing into the
  project and there is no `onInstall` event (`Setup` is flag-driven). Stubs stay
  `init`'s job — the plugin can at most *trigger* it.
- **No `userConfig` credentials.** `pluginConfigs` are read from user scope only,
  so it would mean one host/token for every project; `.env` and
  `.decanter-auth.json` keep credential ownership, which is also what keeps the
  n8n token out of the agent's reach.
- **No monitors, no LSP server.** `watch`-as-monitor is only an *auto-start*
  convenience — the agent can call the Monitor tool itself — and diagnostics are
  already covered by the official `typescript-lsp` plugin plus the scaffolded
  `decanter-ts-plugin`.

## Notes

- **`init` still cannot offer the install.** Claude Code drops
  `<claude-code-hint v="1" type="plugin" …>` unless the plugin lives in an
  Anthropic-controlled marketplace (Plan 55) — that applies to decanter's own
  plugin too. Discovery stays `/plugin` browsing, README, and `/docs`.
- **The other shape, decided separately:** a committed `@skills-dir` plugin at
  `<sync-dir>/.claude/skills/n8n-decanter/.claude-plugin/plugin.json`, scaffolded
  by `init` — the closest thing to the dropped Plan 56, and it needs no
  marketplace. It buys namespacing (`/n8n-decanter:…`) and one bundle instead of
  loose files; it is cosmetic, never loads monitors, and only loads when Claude
  Code starts in the repo root. Not part of this plan.
- **Second-best channel, if the community submission stalls:** `init` could
  scaffold `extraKnownMarketplaces` + `enabledPlugins` into the sync dir's
  `.claude/settings.json` — Claude Code then prompts collaborators to install it
  when they trust the folder. That is exactly the dropped Plan 56 shape, and it
  reaches *collaborators of an existing project*, never new users.
- Own/local marketplaces also show a **thinner detail pane** (no *Context cost*,
  no *Last updated*, and "Components will be discovered at installation" instead
  of the *Will install* inventory), and third-party marketplaces have
  auto-update **off** by default. Both argue for the community catalog over a
  self-hosted one.
- A marketplace listing is a **distribution channel, not agent substance**, so it
  doesn't conflict with the tool-agnostic rule in the root `AGENTS.md` — as long
  as the content stays in `AGENTS.md` and the plugin only points at it.
- No CHANGELOG entry for this draft; the listing gets one when it ships.
