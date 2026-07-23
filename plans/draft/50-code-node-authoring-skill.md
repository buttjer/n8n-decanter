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
`addNode` through the guard lands as an empty file → edit → `node run` → `check`
→ `simulate`/`test` → `push`, plus the TS import/bundling and `@ts-n8n` marker
rules. Distribution with **skills.sh in mind** (`npx skills add`, 20+ agents)
plus the plugin marketplaces (Claude Code, Codex) that also carry hook wiring.

Rationale: (1) routing-layer competition — the n8n meta-skill routes
"build/edit code node" intents toward MCP builds; a decanter skill answers the
same intent with files+push at the layer agents actually consult; (2) portable
procedural knowledge without bloating the always-loaded sync-dir `AGENTS.md`;
(3) skills.sh discoverability as an adoption channel. Its *defensive* role is
already covered by Plan 33's guard-proxy stack, so this is ergonomics/reach, not
safety — pick up if Plan 33's proxy logs show the n8n skills' routing nudge
biting agents in practice, or when the adoption channel becomes worth it.

(2026-07-23 note: the loop's first step moved — `node create` was retired in the
skills-first wave (#107); a Code node is now born over MCP `addNode` through the
guard and lands as an empty file whose first `push` seeds the source. The
skill's story should teach that loop.)
