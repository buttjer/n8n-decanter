# Plan 64 — The MCP `renameNode` op does not rewrite `$('…')` refs — our contract says it does

**Status:** Draft
**Priority:** P1
**Source:** claim B1 of the 2026-07-30 field report (39 renames left every
reference stale). Verified against n8n's source at `n8n@2.30.7`, `n8n@2.32.7`,
`n8n@2.33.3` and `master`, plus docs.n8n.io, n8n-io/skills, the n8n issue tracker
and community forum, on 2026-07-31.
**Snapshot:** 2026-07-31T12:56Z @ 7832364

The scaffolded agent contract tells agents to rename via the `renameNode` MCP op
and promises n8n rewrites `$('…')` references server-side. **It never does** —
and the research settled the three questions that decide what we do about it: we
are **not** holding the API wrong (no flag, no alternate op, no other tool), the
UI really does rewrite but **client-side in the browser**, and we are **not**
forgetting to pull — the live mirror already pulls after every guarded rename,
and a pull faithfully mirrors a workflow n8n itself corrupted.

## The three questions, answered

### 1. Are we using it wrong? No — there is nothing to hold differently

- The op schema is exactly `{ type: 'renameNode', oldName, newName }` — no
  options object, no `rewriteReferences` flag — identical at 2.30.7 and master.
- The handler sets `node.name`, re-keys `nodeByName`, calls
  `renameInConnections()`, and returns. `renameInConnections` only mutates the
  `IConnections` object. Byte-equivalent at 2.30.7, 2.32.7, 2.33.3 and master —
  **pinning a newer n8n changes nothing.**
- Nothing in the MCP module ever constructs a `Workflow`.
  `NODES_WITH_RENAMABLE_CONTENT` and `renameNodeInParameterValue` occur in
  **2 files repo-wide**, `applyAccessPatterns` in 3 — none under
  `packages/cli/src/modules/mcp/`.
- There is no separate rename tool: of 34 registered MCP tools, the only renames
  are `rename_data_table` / `rename_data_table_column`.
- No server-side signal to lean on either: `update_workflow`'s
  `validationWarnings` cannot catch it — the validator only scans strings
  starting with `=` (so `jsCode` is never scanned) and only fires when the
  referenced node *exists*.

### 2. The UI does rewrite — **client-side**, which makes our docs wrong twice

`useCanvasOperations.renameNode` clones a real `Workflow` object **in the
browser**, calls `Workflow.renameNode()`, and writes the result back into the
Pinia store; the workflow is later persisted by an ordinary whole-workflow
`PATCH /rest/workflows/:id` carrying the already-rewritten node array.
`WorkflowService.update` does `addNodeIds` / `resolveNodeWebhookIds` /
`validateWorkflowStructure` and stores nodes verbatim — **no rename detection at
save time, for any client.**

So **"n8n rewrites references server-side" is false for the UI path too.** Our
contract is wrong about the mechanism, not just about the surface.

What `Workflow.renameNode` covers, for reference: every node's string parameters
starting with `=` (so yes — the field report's 8 non-Code nodes with
`={{ $('X')… }}` **would** have been fixed by a UI rename), plus `jsCode`
verbatim for `NODES_WITH_RENAMABLE_CONTENT` (`code`, `function`, `functionItem`,
`aiTransform`), `html` for mailgun/html, Form-node fields, and the connections.
The four rewritten access patterns are `$('X')`, `$node["X"]`, `$node.X`,
`$items('X')` — a lexical regex pass, so a dynamic `$(someVar)` is beyond it
either way. Note Python Code nodes store source in `pythonCode`, which is **not**
in the renamable set — so Python refs go stale in the UI too (relevant to
[Plan 28](28-python-code-nodes.md)).

### 3. Do we forget to pull? No — and pulling cannot help

The live mirror already fires on exactly this op: `mirrorTargetId` returns the
workflow id for any forwarded, non-blocked `update_workflow`, and a `renameNode`
batch carries no `jsCode`, so it forwards and schedules. **On by default**
(`liveMirror: cfg.liveMirror !== false`), wired into both guard transports, and
pinned by tests that use a literal `renameNode` op (`test/e2e.mts:2694-2721`,
`test/guardproxy.mts:129-133`, `:314`). The field reporter got *more* pulls than
they asked for — 39 renames → 39 background pulls (that is
[Plan 68](68-live-mirror-visibility.md)'s subject).

**Pull is a mirror, not a repairer.** It writes the remote body verbatim
(`lib/pull.mts:138`) and re-baselines `lastPushedHash` to that stale remote hash
(`:142`), so a faster pull just produces a more faithful copy of a workflow n8n
already broke. Apart from the refs, pull's rename handling is fully correct —
file move, id-keyed `.decanter.json` remap, re-pointed `//@file:` placeholder.

One thing the pull *does* do: it converts a silent remote breakage into a loud
local one. Before it, `workflow.json` still holds the old name so the refs
resolve and the validator is green; after it, they dangle and
`validateWorkflowDir` hard-errors.

## Why this is an upstream oversight, not a design split

**n8n has three rename paths and only the MCP one is broken.** The editor and
n8n's **own AI Workflow Builder** both delegate to `Workflow.renameNode()` —
`applyRenameNodeOperation` goes so far as to construct a throwaway `Workflow`
with a mock `INodeTypes` purely to reach it, commented *"to handle all the
complexity of updating expressions, connections, and special node types."*

The timeline makes it look like a straightforward miss: **PR #24348** (merged
2026-01-16) added rename to the AI builder and explicitly enumerated the ref
syntaxes and the `jsCode` special-case, saying it follows "the same pattern used
in the core n8n-workflow package (`Workflow.renameNode()`)". **PR #29739**
(merged 2026-05-12, four months later) introduced the MCP op and described it as
*"renameNode — rename + rewrite **connection** references"* — the expression
logic was already written and simply not carried over. There is no ADR or comment
explaining the divergence, and the MCP module has **no test asserting anything
about parameters after a rename**.

An upstream fix would be small: `update-workflow.tool.ts` already imports
`Workflow` from `n8n-workflow`.

## Is it documented or known? Undocumented silence

- docs.n8n.io's MCP tool reference says *"Renames a node and rewrites
  **connection** references."* — narrowly correct, trivially misread. The whole
  41k-char page contains zero `$(` and zero `jsCode`. The sibling `removeNode` op
  **does** carry a side-effect caveat, so n8n warns when it considers something
  notable.
- `mcp-instructions.ts` (injected into the client's system prompt via
  `InitializeResult.instructions`) lists `renameNode` with no caveat — while
  warning about removeNode/addNode disconnecting sub-nodes.
- **n8n-io/skills** — the closest thing to an official agent contract — has no
  instruction to fix refs after a rename in any of its 63 Markdown files, and its
  review checklist actively pushes agents to *"Rename every node to describe what
  it does in this workflow"* with no follow-up step.
- No open issue, no PR, no wontfix, no community thread, no release-note entry.
  **We are not the outlier — nobody upstream puts this on the caller.**

→ Worth filing upstream (option D). Also worth telling the skills maintainers,
since their checklist walks agents straight into it.

## The sharpest operational consequence

A stale ref in a **code file** is locally fixable and pushable. A stale ref in
another node's **expression parameter** is a hard compliance error that lives in
the read-only `workflow.json` — which nothing pushes. Push can only ever emit
`{type: "updateNodeParameters", nodeName, parameters: {jsCode}}`
(`lib/push.mts:124`), so **an agent can only repair that half over MCP, and until
it does, every subsequent code push for that workflow is hard-blocked** — and
`--force` does not bypass it.

Second timing hole: **nothing validates after a rename.** The mirror pull imports
no validator, and the template's Claude hook fires on `Edit|Write|MultiEdit`
only — an MCP rename never triggers it. So the breakage surfaces at the *next*
push or preflight, arbitrarily far from the act that caused it.

## Options

- **A. Docs + tests (mandatory, do first).** Correct
  `template/AGENTS.md.example:73`, `:203`, `:265`,
  `template/CLAUDE.md.example:23-26`, `PLAN.md:567` + `:1194`,
  `CHANGELOG.md:695` — splitting the UI and MCP paths, and dropping "server-side"
  for both. Fix `test/e2e.mts:83`'s `renameRefsDeep` mock (it invents a server
  property; that is why the suite is green) and add a `$('…')` ref to the smoke
  fixture, which today contains **zero** `$('` occurrences. **Also correct
  `template/CLAUDE.md.example`'s "pull after each MCP rename so nothing is left
  half-updated"** — that is precisely the false hypothesis this research killed.
- **E. Detect-and-instruct in the guard (recommended next).** The guard already
  parses `{oldName, newName}` out of the request body and already reacts to
  forwards (`mirror.schedule`) and synthesizes results for blocked writes — so it
  is already "forward + react", not a pure pipe. On `mcp connect` (the scaffolded
  default) responses are already fully buffered and parsed, so annotating a
  rename's tool result is small; `mcp serve` pipes through untouched and would
  need new buffering. Cheapest variant of the same idea: **run the layout check
  after a mirror pull and surface the dangling-ref count where the agent can see
  it.**
- **C(ii). Decanter rewrites refs in its own `.js`/`.ts` sources.**
  `renameNodeRefs` (`lib/util.mts:104`) is the ready-made rewriter, still present
  with zero production callers. Defer — but for the right reason: it makes `pull`
  mutate code it just mirrored, and it repairs only the half decanter owns while
  push stays blocked on the parameter half. Note the pre-Plan-32 `rename` verb did
  the full local rename *before* push, which sidesteps that entirely and may be
  the better shape if we revive anything.
  **Correction to this plan's first draft:** the objection that a local rewrite
  "would break the `lastPushedHash`-mirrors-remote invariant and manufacture
  phantom drift" is **mechanically wrong**. `codeDrift` (`lib/push.mts:41-43`)
  keys on the *remote* hash moving off `lastPushedHash`; after a pull that repairs
  the local file, `remoteHash === lastPushedHash`, so drift is false and the
  repaired file pushes cleanly as an ordinary unpushed edit.
- **C(i). Decanter issues `updateNodeParameters` to repair other nodes'
  expressions — reject.** It contradicts "decanter still never owns structure"
  (`PLAN.md:94-99`), and it would do that surgery with an explicitly heuristic
  regex where n8n uses a real parser.
- **B. Steer renames to the UI — reject** as the primary answer: unusable for a
  headless agent. Worth naming in the docs as the path that *does* heal refs.
- **D. Report upstream — do it, don't block on it.**

## Related

- `lib/validate.mts:196`'s comment has always been correctly scoped ("the n8n
  **UI** rewrites these on rename") — **the code was right; only the prose was
  wrong.** The dangling-ref check (sources at `:157`, expression params at
  `:201`) is the backstop that made the field report's fallout visible at all.
- Backstop hole worth closing alongside:
  [Plan 69](69-watch-skips-folder-guard.md) — `watch` never runs the folder-wide
  check, so the dangling-ref rule does not fire in watch mode at all.
- Adjacent consequence, not a new bug but worth stating in the docs: for a
  **TS-managed** node a *UI* rename's correct rewrite is silently reverted — pull
  never updates the `.ts` source (warn only) yet re-baselines `lastPushedHash`, so
  the next push overwrites n8n's correct rewrite with stale-ref compiled output.
  That is the documented "pull re-baselines even on conflict" design meeting this
  bug.
