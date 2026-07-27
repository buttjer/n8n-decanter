# Plan 50 — Decanter-native code-node authoring skill, distributed skills.sh-first

**Status:** Draft
**Priority:** P2
**Class:** Distinctive feature (differentiator — agent-native tooling)
**Source:** 2026-07-22, deferred out of [Plan 33](../done/33-post-mcp-pivot-wave.md)
**Snapshot:** 2026-07-23T06:57Z @ 710d3f1

A small **original** skill (1–2 files, no n8n-io/skills fork —
[Plan 30](../open/30-agent-llm-working-ergonomics.md)'s "override, not fork"
stands) teaching agents the decanter authoring loop: *Code nodes are authored as
files under `code/` and synced via decanter push* — a Code node born over MCP
`addNode` through the guard lands as an empty file → edit → `node run` →
`preflight` (local gate; `--full` adds `simulate`) → `push` → `test`, plus the
TS import/bundling and `@ts-n8n` marker rules. *(Loop corrected 2026-07-25 for
Plan 60/#162 + #163: `test` runs the **draft** on the instance, so it belongs
**after** the push — a skill teaching test-before-push would teach a run against
code the user isn't shipping. `push` itself is part of finishing the work, not a
step to ask permission for.)* Distribution with **skills.sh in mind** (`npx skills add`, 20+ agents)
plus the plugin marketplaces (Claude Code, Codex) that also carry hook wiring.

**Field evidence (2026-07-27).** Leg 1's premise **holds**: the competing skill
is genuinely loaded — `n8n-code-nodes-official` was invoked in both S1 rounds of
a dedicated 2-round verification, and earlier S1/S2 rounds also pulled in
`n8n-workflow-lifecycle-official` / `n8n-node-configuration-official`. Uptake is
**variable, not reliable** (S2 used 3–4 skills historically, then 0 and 2 in the
two verification rounds), so any future claim about skill usage needs several
rounds behind it.

The feared *outcome*, though, does not occur: **zero blocked `jsCode` writes
across ~14 archived rounds**, including every round where
`n8n-code-nodes-official` was loaded. The agent reads n8n's own code-node skill
and still routes code through files + `push`.

That makes this plan's graduation trigger measurable and currently **not met**: a
blocked `jsCode` write in `guard.log` is exactly the "routing nudge biting"
signal, and it has never fired. The scaffolded `AGENTS.md` contract — which is
in the agent's context from the first token via `CLAUDE.md`'s `@AGENTS.md`
import — is winning the competition this plan exists to address. Leg 3 (skills.sh
as an adoption channel) is unaffected by any of this.

*Caveat: the field harness vendors `skills/*` **without** the plugin's
SessionStart router or `plugin:` namespacing, so this measures the vendored pack,
not a full plugin install ([Plan 56](../open/56-declarative-claude-plugin-scaffold.md)
is the only way to test the latter).*

Rationale: (1) routing-layer competition — the n8n meta-skill routes
"build/edit code node" intents toward MCP builds; a decanter skill answers the
same intent with files+push at the layer agents actually consult; (2) portable
procedural knowledge without bloating the always-loaded sync-dir `AGENTS.md`;
(3) skills.sh discoverability as an adoption channel. Its *defensive* role is
already covered by Plan 33's guard-proxy stack, so this is ergonomics/reach, not
safety — pick up if the guard's captured stderr shows the n8n skills' routing
nudge biting agents in practice, or when the adoption channel becomes worth it.

(2026-07-23 note: the loop's first step moved — `node create` was retired in the
skills-first wave (#107); a Code node is now born over MCP `addNode` through the
guard and lands as an empty file whose first `push` seeds the source. The
skill's story should teach that loop.)
