# Plan 73 — Claude Code plugin: marketplace listings only (Anthropic + n8n)

**Status:** Draft
**Priority:** P2
**Source:** Session 2026-08-04 ("is this project theoretically claude plugin
capable?") — the full-plugin idea was worked through and rejected except for
reach. Picks up the plugin findings in
[55-init-skills-offer.md](../done/55-init-skills-offer.md) (hint protocol, the
dropped Plan 56) and the skills-pack note in
[30-agent-llm-working-ergonomics.md](../open/30-agent-llm-working-ergonomics.md).
**Snapshot:** 2026-08-04T14:08Z @ 1955c62
**Theme:** decanter is invisible in the places agent users shop for tooling —
get listed in two of them, and ship nothing else through that channel.

Publish a **thin** Claude Code plugin whose only job is discovery, and get it
listed in the two catalogs that matter: Anthropic's community marketplace and
**n8n's own** (`n8n-io/skills`, whose audience is precisely decanter's). The
plugin carries a couple of skills that point at the CLI and leaves the guard,
hooks, permissions and scaffolding exactly where they are. Every *technical*
thing a plugin could do is either already covered by `init`'s scaffold or better
off committed in the user's repo — **reach is the only reason left**, so this is
deliberately a distribution plan, not a feature.

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
2. **Track A — submit to Anthropic's community marketplace** — that, not our own
   catalog, is what makes decanter findable to someone who has never heard of it. Users then run
   `/plugin marketplace add anthropics/claude-plugins-community` (manual, once)
   and `/plugin install n8n-decanter@claude-community`. Mechanics, verified
   2026-08-04:
   - `claude plugin validate ./plugin` locally first — the review pipeline runs
     the same check, plus automated safety screening, then a manual approval.
   - Submit through the **Console form**
     ([platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit)).
     The claude.ai form needs a Team/Enterprise org with directory-management
     access; the Console form is the individual-author route.
   - Approved entries are **pinned to a commit SHA**, and CI bumps the pin as we
     push. The public catalog **syncs nightly**, so listing lags approval —
     check by searching the name in the catalog's `marketplace.json`.
   - **Never open a PR against `anthropics/claude-plugins-community`** — it is a
     read-only mirror and PRs are closed automatically.
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
7. **Track B — n8n's own marketplace (`n8n-io/skills`).** A marketplace is just a
   repo with a catalog, so n8n's skills repo is one — and its users are exactly
   decanter's: people pointing an agent at n8n. This track is **outreach, not
   engineering**, and it has the better audience-fit of the two:
   - The ask is **reciprocal and already earned**: decanter recommends their pack
     on a first `init` (Plan 55), documents the pairing in
     [n8n-skills.md](../../docs/agents/n8n-skills.md), and enforces the boundary
     in code so pairing is safe by construction — the guard forwards their whole
     build/lifecycle surface and blocks only `jsCode` writes.
   - Concretely: offer a catalog entry pointing at our plugin (a marketplace
     entry can reference an external repo, so nothing needs vendoring), or
     failing that a mention in their skills docs; and a post on
     [community.n8n.io](https://community.n8n.io) framed as the pairing, not an
     ad.
   - **Honest limits:** no pipeline, no SLA, and n8n may simply decline. Nothing
     in the repo may depend on this landing — Track A stands alone.
8. **Doc surfaces** — the listing is user-facing, so the usual three move with
   it: `README.md`, `/docs`, `CHANGELOG.md`. No `## Commands` row (a plugin is
   not a verb, so `check:docs` requires nothing there).
   - **`README.md` — five lines in `## Setup`**, right after the
     `npm install -g` block. Keep it this small; the README is deliberately slim
     ([Plan 38](../done/38-readme-slim.md)):

     ~~~md
     **Using Claude Code?** decanter is also a plugin — it adds
     `/n8n-decanter:…` skills that walk you through setup and the
     file → `push` loop:

     ```sh
     claude plugin marketplace add anthropics/claude-plugins-community
     claude plugin install n8n-decanter@claude-community
     ```

     The plugin is an **entry point, not the tool**: the CLI above is still
     required, and the guard still comes from the `init` scaffold.
     ~~~

     *Alternative shape, if it should carry the boundary explanation too: its own
     short `## Claude Code plugin` section after "Works with n8n's official
     skills", which already sets out limits in the same voice.*
   - **Badge** next to the `vibe coded` one:

     ~~~md
     [![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://claude.com/plugins)
     ~~~
   - **Feature bullet** at the top: the `Agent-native` bullet gains a clause
     naming the plugin as an entry point.
   - **`/docs`**: a short `docs/agents/claude-plugin.md`, cross-linked from
     [n8n-skills.md](../../docs/agents/n8n-skills.md) (same audience, adjacent
     topic).
   - **Two traps to honour in that copy:** the shell form is
     `claude plugin …`, **never** `/plugin …` inside a ```sh fence (the exact
     copy-paste bug Plan 55 fixed), and the install target is
     `@claude-community`, not our own catalog name.

## Non-goals — and why (all verified 2026-08-04 against the plugin reference)

- **No guard / `.mcp.json` in the plugin.** Project `.mcp.json` *and* a plugin
  copy means two `mcp connect` processes and duplicate tools in context; moving
  it instead strands Cursor/opencode/Codex, breaking the tool-agnostic rule.
- **No hooks in the plugin.** Plugin hooks *merge with* `settings.json` hooks and
  cannot override them → a scaffolded `verify.mjs` plus a plugin copy runs
  `preflight` twice after every edit, un-silenceable until that repo re-`init`s.
  They also gain nothing: same events, same types, including `PreToolUse`
  `updatedInput` and `PostToolUse` `updatedToolOutput`.
- **No permissions.** The manifest has no `permissions` key at all. A plugin may
  ship a root `settings.json`, but only the `agent` and `subagentStatusLine` keys
  are read — permissions are not among them, so `.claude/settings.json` stays
  committed project policy.
- **No scaffolding through the plugin.** A plugin install writes nothing into the
  project and there is no `onInstall` event (`Setup` is flag-driven). Stubs stay
  `init`'s job — the plugin can at most *trigger* it.
- **No CLI shipped on the plugin's PATH.** A plugin *can* do this — a `bin/`
  directory at the plugin root is added to the Bash tool's `PATH` while the
  plugin is enabled — so this is a choice, not a limitation. Rejected because it
  creates **version skew**: Claude would call the plugin's copy while the human,
  `npm run typecheck`, and CI call the project's, and decanter's contract runs
  through `.decanter.json`, per-node hashes and the `@ts-n8n` marker, where "which
  version wrote this?" is a real failure channel. It also only covers Bash-tool
  calls — not the user's terminal, not Cursor/opencode, and (**unverified**,
  worth testing before relying on it) probably not hook processes either, so it
  would not fix `verify.mjs`'s no-op-without-the-CLI behaviour. The CLI belongs in
  the project: a pinned devDependency in `template/package.json.example`.
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
- **Reality check on the reach Track A buys.** The community catalog is real and
  maintained but not a mass channel: ~336 stars / 84 forks as of 2026-08-04, and
  users must add it manually. Install counts aren't public. Treat it as cheap
  upside, not a growth plan — which is also why the scope stays this thin, and
  why **Track B is expected to outweigh it** despite having no process behind it:
  audience fit beats catalog size here.
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
