# Plan 64 — The MCP `renameNode` op does not rewrite `$('…')` refs — our contract says it does

**Status:** Draft
**Priority:** P1
**Source:** claim B1 of the 2026-07-30 field report (39 renames left every
reference stale), verified against n8n's own source at `n8n@2.30.7` **and**
master on 2026-07-31.
**Snapshot:** 2026-07-31T05:37Z @ 11bbbc7

The scaffolded agent contract tells agents to rename via the `renameNode` MCP op
and promises n8n rewrites `$('…')` references server-side. **It never does** —
that rewriting lives on the editor path only. So the documented, guard-blessed
rename path leaves a genuinely broken draft, and our e2e mock encodes the same
false belief, which is why no test caught it. Highest-priority draft.

## What was verified

- `packages/cli/src/modules/mcp/tools/workflow-builder/workflow-operations.ts`,
  `handleRenameNode` — sets `node.name`, re-keys `nodeByName`, calls
  `renameInConnections()`. **Nothing else.** No `applyAccessPatterns`, no
  `renameNodeInParameterValue`, no `NODES_WITH_RENAMABLE_CONTENT` anywhere in the
  MCP write path. Same at 2.30.7 and master.
- The rewriting *does* exist in `packages/workflow/src/workflow.ts`
  (`Workflow.renameNode` → `renameNodeInParameterValue({hasRenamableContent: true})`,
  and `NODES_WITH_RENAMABLE_CONTENT` does include the Code node) — **reached by
  the editor canvas**. So "rename in the n8n UI" is correct; "rename over MCP" is
  not.
- Not "unreliable" — **never**, neither in `jsCode` nor in other nodes'
  expression parameters.

## Scope

Five shipped surfaces state it wrongly, and the template names the MCP op
*first*, i.e. the recommended path is the broken one:
[`template/AGENTS.md.example:73`](../../template/AGENTS.md.example),
[`:203`](../../template/AGENTS.md.example),
[`:265`](../../template/AGENTS.md.example) ("when a node is renamed **over MCP**
or in the UI" — flatly false),
[`template/CLAUDE.md.example:23-26`](../../template/CLAUDE.md.example),
`PLAN.md:567` + `:1194`, `CHANGELOG.md:695`.

New wording must **split the two paths** rather than hedge — and the `.ts`
carve-out at `AGENTS.md.example:210-212` stays correct under both.

**The test fix is not optional.** [`test/e2e.mts:83`](../../test/e2e.mts)'s mock
runs `renameRefsDeep(n.parameters, …)` under a comment claiming it mirrors "the
verified 2.30.7 semantics" — the suite affirms a server property that doesn't
exist. And [`test/smoke-n8n.mts`](../../test/smoke-n8n.mts) contains **no `$('`
at all**, so the real-instance rename step could never have measured it. Fix the
mock, then add a cross-node ref (Code node *and* an `={{ $('X')… }}` parameter)
to the smoke fixture — **expect it to fail on first run; that's the point.**

## Open questions for the maintainer

- Does decanter *do* anything, or only document? `renameNodeRefs`
  ([`lib/util.mts:104`](../../lib/util.mts)) still exists with **zero callers**
  since the `rename` verb was retired. Reviving it on pull is not obviously
  right: `workflow.json` is a read-only snapshot regenerated every pull, and
  rewriting a `.js` body after pull would break the
  `lastPushedHash`-mirrors-remote invariant and manufacture phantom drift.
  Dead-code removal may be the honest answer, with the guard as the backstop.
- Should the contract steer agents to the **editor** for renames instead of MCP?
- Mitigation that bounds the damage today: dangling refs are a **hard compliance
  error** `--force` cannot bypass ([`lib/validate.mts:157`](../../lib/validate.mts)
  for sources, [`:201`](../../lib/validate.mts) for expression parameters), so the
  next `push`/`preflight --offline` blocks with the exact name. Notably that
  file's own comment is correctly scoped ("the n8n **UI** rewrites these on
  rename") — **the code has always been more accurate than the docs.**
