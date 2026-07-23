# Plan 28 — Python Code nodes

**Priority:** P2 (valuable; touches the core data model across ~11 modules — real
scope, but the design is well-specified and the Python path is the simplest
Code-node variant)
**Status:** Not started
**Theme:** Extract n8n **Python** Code nodes into `code/<node>.py` files with full
round-trip parity, mirroring today's JS/TS flow.
**Model:** Sonnet (well-specified, broad implementation) — the one design-sensitive
spot is the `lib/util.mts` source-field abstraction; the rest is a mechanical
repeat across the pipelines.

> **Post-Plan-32 review (2026-07-22):** the design survives the MCP pivot —
> the source-field abstraction lives in the util/file layer, and MCP's
> `updateNodeParameters` **merge** semantics fit a `{pythonCode}`-only write
> exactly as they fit `{jsCode}`. **Adapted:** push now emits MCP ops
> (Task 3), the `.remote.js` flow no longer exists (Task 2), and the
> verification recipe targets the Plan 32 dual REST+MCP mock. Inline file/line
> refs predate the Plan 32 rewrite of pull/push/status/watch — re-resolve at
> execution time.

> **Post-#107 review (2026-07-23) — the creation path changed and a real guard
> gap opened.** The skills-first wave **deleted `lib/add.mts` and
> `lib/rename.mts` and removed the `node create` verb** (`NODE_VERBS` is now
> just `{run}`), so **Task 8 (`add --python`), Task 11 (rename module), the
> lifecycle half of Task 7, acceptance item 5, and the node-create docs are
> obsolete** — a Python node is now *born over MCP* (n8n UI or guarded
> `addNode`), lands as an **empty `code/<node>.py`** on pull, and its first
> push seeds the source (mirroring the JS empty-file flow). Two things the plan
> predates and **must add**: (1) **the guard blocks only `jsCode`**
> (`lib/mcpserve.mts` — `pythonCode` writes pass straight through), so once
> `.py` extraction lands an agent could write Python source over MCP and bypass
> the file+push discipline — the guard must broaden to a `{jsCode, pythonCode}`
> source-key set; and (2) **the `test` verb** (`lib/testrun.mts`, Plan 33) has
> five `jsCode`-hardcoded sites that silently exclude Python nodes. The
> [Plan 33](../done/33-post-mcp-pivot-wave.md) interim inline-`pythonCode` warning
> **already landed** (via #101, `lib/validate.mts` ~200 — *not* #114), so
> Task 4's conditional is now unconditional: remove it. Both `BLOCKED-33` links
> become `DONE-33`.

## Why

n8n's Code node runs **two** languages: JavaScript (`language: "javaScript"` or
absent, source in `parameters.jsCode`) and **Python** via Pyodide
(`language: "python"`, source in `parameters.pythonCode`). decanter handles only
JS/TS today — a Python node fails the central `isJsCodeNode()` guard
([lib/util.mts:11-17](../../lib/util.mts#L11-L17)) on two counts (no `jsCode`,
`language !== "javaScript"`), so it passes through every pipeline **untouched**:
its source stays inline in `workflow.json`, never extracted to a file, never
git-friendly. This closes that gap.

Python is the **simplest** Code-node variant: unlike TypeScript it needs **no**
compile step, **no** `@ts-n8n` marker, **no** import-bundling, and **no**
`.remote.*` conflict flow. It is byte-verbatim like plain `.js` — just a
different field (`pythonCode`) under a different extension (`.py`), with the
language declared explicitly (`language: "python"`) rather than sniffed from a
marker. So the whole feature is: teach the existing chokepoints that "extractable
Code node" means *js **or** python*, and read/write the correct source field.

**Scope (confirmed with maintainer 2026-07-21; updated 2026-07-23 for #107):**
full round-trip parity across pull/push/status/watch/check, **plus** the
surfaces the original scope predated — the MCP **guard** (block `pythonCode`
writes), MCP-**born** Python nodes (empty-`.py` seeding via
`getWorkflowDetails` normalization), and the **`test`** / **`scenario`** /
**`simulate`** flows. The retired `node create --python` path is **replaced**
by the guarded-`addNode` → empty-`.py` → push-seeds story (no decanter verb
creates nodes anymore). Offline **`node run`** stays JS-only — a `.py` file
errors with a clear pointer to `simulate`/`test` (both boot/hit a real n8n that
runs Python under Pyodide). No local Python interpreter is added.

## Source

- New backlog item, raised 2026-07-21. No prior `plans/` or `PLAN.md` entry.
- Existing Python mentions (all updated/retired by this plan): the
  **competitor-comparison** rows (README was slimmed by Plan 38 — the row is
  now ~`README.md:151` and `website/src/pages/index.astro` ~`:44`) turn from "a
  thing the competition does" into a decanter capability; and the **interim
  inline-`pythonCode` warning** shipped by Plan 33 (`lib/validate.mts` ~200,
  plus its `CHANGELOG.md` line) is retired by full extraction. `docs/` and
  `PLAN.md` still contain **zero** Python mentions — the right place to add the
  data-model + concept notes.
- Python is n8n **parity** (not a decanter differentiator), so it stays in the
  normal backlog — **not** the distinctive-features group (per AGENTS.md).

## Design decision — one source-field abstraction

Everything funnels through three spots today: the `isJsCodeNode()` guard, the
hard-coded `jsCode` field, and the `/\.(ts|js)$/` extension checks. Generalize
those and the rest falls out.

New helpers in [lib/util.mts](../../lib/util.mts):

- `codeSourceField(node): "jsCode" | "pythonCode" | null` — **the single source
  of truth.** `null` unless `node.type === CODE_NODE_TYPE`; then `"pythonCode"`
  when `language === "python"` && `typeof pythonCode === "string"`; `"jsCode"`
  when `(language === undefined || language === "javaScript")` &&
  `typeof jsCode === "string"`; else `null`.
- `isCodeNode(node): node is CodeNode` = `codeSourceField(node) !== null` — the
  broadened guard for the extraction pipelines.
- `readCodeSource(node)` / `setCodeSource(node, value)` — read/write the correct
  field so call sites never index dynamically (keeps TS types clean).
- Keep `isJsCodeNode` (reimplement as `codeSourceField(node) === "jsCode"`) for
  the JS-only site (offline `run`).
- `placeholderFile(node)` and `workflowStructureHash(wf)` switch to these — the
  latter must blank `pythonCode` too, so structure-vs-code separation holds.

Types ([lib/types.mts](../../lib/types.mts)): add `pythonCode?: string` to
`NodeParameters`; add a `CodeNode` interface; keep `JsCodeNode` for the JS-only
narrowing.

## Tasks

1. **util.mts + types** — add the helpers and types above.
2. **[lib/pull.mts](../../lib/pull.mts)** — loop guard → `isCodeNode`. Branch on
   `codeSourceField`: `pythonCode` → ext `.py`, take the plain-verbatim `.js`
   branch in its post-Plan-32 shape (overwrite + "recover via git" warning on
   unpushed local changes); Python **never** enters the `tsManaged`/marker
   branches (the `.remote.js` flow is gone since Plan 32). Placeholder into
   the correct field.
3. **[lib/push.mts](../../lib/push.mts)** (MCP-era, Plan 32) — `buildNodeCode`
   already reads any non-`.ts` file verbatim, so **`.py` needs no change
   there** (but its return type `{ jsCode, hash }` needs the field name
   generalized). Broaden `collectOps`' guards (the `isJsCodeNode` check on the
   remote node and the untracked-remote-node scan) to `isCodeNode`, swap
   `node.parameters.jsCode` for `readCodeSource`, and emit the op with the
   correct field: `{ type: "updateNodeParameters", nodeName, parameters:
   { pythonCode } }` for a Python node — MCP merge semantics preserve
   `language` and sibling params (spike-verified for `jsCode`; assert the
   same for `pythonCode` in the smoke suite). `verifyRoundTrip`/`recordSync`
   compare via `readCodeSource` on the post-write confirming read.
   `splitMarker` on Python source is a no-op. **Also broaden the snapshot
   placeholder re-point loop** (the `isJsCodeNode`/`placeholderFile` pass that
   registers a `//@file:` re-point into `.decanter.json` — the #107 file-kind
   change flow): a Python node's placeholder rides `pythonCode`, so without
   this a `.py` re-point never registers.
4. **[lib/validate.mts](../../lib/validate.mts)** — allow `.py` in the extension
   gate; keep the `.js` marker-ban + import-scan **JS-only**; broaden the node
   loop to `isCodeNode`; skip the real source field in `parameterStrings`
   (use `codeSourceField`); widen the orphan-scan regex to `/\.(ts|js|py)$/`.
   **Remove the interim inline-`pythonCode` warning** (already landed via
   Plan 33/#101, `lib/validate.mts` ~200 — extraction makes it obsolete) and
   **rewrite the unit test that pins its literal text**
   (`test/unit/validate.test.mts`, the "flags a Python Code node's inline
   `pythonCode` honestly" case) into extraction-behavior tests. **Also broaden
   the scenario `workflowData` inline-source warning** (currently checks only
   `jsCode`) to `pythonCode`, so a legacy scenario embedding Python source is
   flagged too.
   - **Python `$('…')`-ref limitation (was Task 11).** validate's
     dangling-ref scan (`danglingRefs` → `findNodeRefs` in `lib/util.mts`) and
     `parameterStrings` match only JS `$('Name')` refs; n8n Python code
     references nodes as `_('Name')`, so once `.py` files exist the scan is
     silently blind on them. **Either** extend `findNodeRefs` to recognize the
     Python `_('…')` syntax on `.py` sources **or** document the limitation
     explicitly (Task 13 / a `## Non-goals` line) — do not silently drop it
     (the old rename module that hosted this note is gone).
5. **[lib/status.mts](../../lib/status.mts)** — `localBody`/loop → `isCodeNode`;
   `.py` local body is verbatim; compare against the correct remote field.
6. **[lib/watch.mts](../../lib/watch.mts)** — **verify-no-change.** watch no
   longer has an extension-based filter; `nodeIdForFile` resolves a changed
   file to its node id purely via the `.decanter.json` state entry
   (`ns.file === rel`), so a state-mapped `.py` file already resolves once pull
   maps it. Single-node push (`pushSingleNode`) inherits the Task 3 changes.
   Confirm and add a watch e2e step; no code change expected.
7. **[lib/simulate.mts](../../lib/simulate.mts)** — the placeholder
   materialize/reconstitute pass in `buildSimulation` is `isJsCodeNode`-gated;
   broaden it to `isCodeNode` and read/write via `readCodeSource`/`setCodeSource`.
   *(`lib/lifecycle.mts` is dropped from this task — it is now publish/unpublish
   only, no code handling, since #107 removed the repo-authored create/duplicate
   path that materialized code there.)* Note `PURE_NODE_TYPES` already includes
   the Code node with no language distinction, so simulate/`test` already run
   Python under Pyodide once materialization is broadened.
8. **The `test` verb ([lib/testrun.mts](../../lib/testrun.mts), Plan 33) — plan
   predates it entirely (NEW).** Five `jsCode`-hardcoded sites silently exclude
   Python nodes from the pinned test flow: the local-vs-draft drift pre-check,
   the byte-exact draft snapshot, the restore-draft write-back and re-baseline
   loops, and the pushed-hash recording. Broaden all five via
   `isCodeNode`/`readCodeSource`/`setCodeSource`, and extend
   `test/unit/testrun.test.mts`.
9. **The MCP guard ([lib/mcpserve.mts](../../lib/mcpserve.mts)) — a real bypass
   gap (NEW).** The guard blocks only `jsCode` (`containsJsCodeKey`/`writesJsCode`,
   the block text constant `JSCODE_BLOCK_TEXT`, and the `mcp connect` log line
   in `lib/mcpconnect.mts`). Once `.py` files are the source of truth, an agent
   writing `pythonCode` over `mcp connect`/`mcp serve` bypasses the file+push
   discipline exactly as a `jsCode` write would. Broaden the guard to a
   **code-source-key set `{jsCode, pythonCode}`** on both routes (the key-anywhere
   route **and** the `setNodeParameter` JSON-Pointer-path route), generalize the
   block constant + its text, and sweep the guard wording across the surfaces in
   Task 13.
10. **MCP-born Python nodes — empty-`.py` seeding (NEW, replaces the old `node
    create --python`).** `getWorkflowDetails` (`lib/mcp.mts`) normalizes only the
    JS case today (a `jsCode`-less JS Code node → `jsCode = ""` so pull lands an
    empty file). Add the Python analog: `language === "python"` &&
    `pythonCode === undefined` → `pythonCode = ""`, so a Python Code node born
    over the guarded `addNode` (which now blocks `pythonCode`) lands an empty
    `code/<node>.py` whose first push seeds the source — the exact mirror of the
    JS empty-file authoring loop.
11. **[lib/run.mts](../../lib/run.mts)** — keep the `.js`/`.ts`-only gate (the
    "need `.js` or `.ts`" throw, ~`run.mts:185`); for `.py`, throw a clear
    message pointing to **`simulate`/`test`** (both run Python on a real engine).
12. **[scripts/typecheck.mts](../../scripts/typecheck.mts)** — no change:
    `.py` is already excluded from `isNodeFile` (Python has no typecheck path,
    matching n8n).
13. **~~`lib/rename.mts` / `lib/add.mts` — REMOVED (#107).** The `rename` and
    `node create` verbs and their modules are gone; structure/lifecycle acts go
    through n8n's MCP tools via the guard, and `pull` reconciles. The old Task 8
    (`add --python`) and Task 11 (rename ref-rewriting) are obsolete — the
    Python creation story is Task 10 (empty-`.py` seeding) and the ref
    limitation moved to Task 4.
14. **Tests** — Python fixtures don't exist anywhere yet. Add: unit
    ([util](../../test/unit/util.test.mts), `validate`, `push`, `simulate`,
    `testrun`) + **guard** coverage ([test/guardproxy.mts](../../test/guardproxy.mts):
    a `pythonCode` write is blocked on both `mcp connect` and `mcp serve`), e2e
    ([test/e2e.mts](../../test/e2e.mts) round-trip → `.py`, no marker; guarded
    `addNode` of a Python node → empty `.py` → push seeds), opt-in smoke
    ([test/smoke-n8n.mts](../../test/smoke-n8n.mts) real-n8n Python round-trip **and
    a Python Code node executing under Pyodide via `simulate`/`test`** — the
    plan's "simulate runs Python" premise is unverified in the offline
    `n8n execute` context; prove it before the docs promise it).
15. **Docs (all surfaces, per AGENTS.md)** — the `jsCode`-only story is
    hardcoded far more widely than the original list; the guard-broadening
    (Task 9) + push-writes-`pythonCode` change makes each stale:
    - **README** — feature bullet, `code/` layout, the Python comparison row
      (no `node create` row exists to update anymore).
    - **`docs/cli/*`** — `pull`/`push`/`status`/`check`/`overview`, **plus the
      guard pages** `mcp-connect.md`/`mcp-serve.md` (broaden the "blocks
      `jsCode`" wording), `init.md`, and `test.md`/`scenario.md`/`simulate.md`
      if their surfaces change. *(No `node-create.md` — it doesn't exist.)*
    - **`docs/agents/*`** (new in #107) — `overview.md`, `n8n-skills.md`
      ("blocks writes that set a Code node's `jsCode`"), `offline-loop.md`
      (empty-file seed flow), and **`docs/concepts/push-gates.md`** ("pushes
      write only `jsCode`") — all describe the guard/seed flow a Python node
      now shares.
    - **`docs/concepts/sync-layout.md`** — a Python note (verbatim, untyped,
      un-bundled, not offline-`run`-able).
    - **Template** — `template/AGENTS.md.example` (the many `jsCode` lines,
      **including** the two documenting the empty-file seed flow, which need a
      Python twin), `template/CLAUDE.md.example`,
      `template/.cursor/rules/n8n-decanter.mdc.example`,
      `template/opencode.json.example`,
      `template/.claude/hooks/mcp-route-check.mjs.example`.
    - **CHANGELOG** `[Unreleased] > Added` (retire the interim-warning line),
      **PLAN.md** data model (source field language-dependent, `language` is
      the discriminator, `.py` verbatim; guard blocks both code fields).

## Acceptance / verification

Mock-n8n recipe (`/verify` skill, Plan 32 shape): drive the real CLI against a
`node:http` mock serving **both** surfaces — the MCP JSON-RPC endpoint and the
`/api/v1` routes (`test/e2e.mts`'s mock is the reference) — with a workflow
carrying a **Python** Code node (`type: "n8n-nodes-base.code"`,
`typeVersion: 2`, `parameters.language: "python"`, `parameters.pythonCode`).

1. `pull` → `code/<node>.py` = exact body; `workflow.json` placeholder in
   `pythonCode`; `.decanter.json` maps node → `.py`.
2. Edit `.py`, `push` → the mock's draft `pythonCode` updates via a
   `{pythonCode}`-only `updateNodeParameters` op; **no** `@ts-n8n` marker.
3. `status` → clean after pull; push-pending after local edit; drift/CONFLICT
   after mutating the mock's in-memory draft Python source.
4. `check` → passes with a valid `.py`; a stray `code/foo.py` is flagged orphan.
5. A guarded MCP `addNode` of a `language: "python"` Code node (the guard
   blocks `pythonCode`, so it arrives source-less) → `getWorkflowDetails`
   normalizes it to empty `pythonCode` → `pull` lands an empty `code/py-node.py`
   → the first `push` seeds the source; re-validates clean. A direct
   `pythonCode` write over `mcp connect`/`mcp serve` is **blocked** with the
   file+push guidance.
6. `node run code/<node>.py` → errors with the `simulate`/`test`-redirect
   message.
7. `watch` (unsandboxed) → editing the `.py` triggers a single-node draft push
   (no watch code change — state-mapped resolution).
8. `test`/`simulate` on a workflow with a Python Code node → the node executes
   under Pyodide on the real engine; the `.py` local body materializes into the
   run correctly.

Then `npm test` + `npm run typecheck` green; optionally `npm run test:smoke`.

## Notes

- **CHANGELOG/PLAN implications:** user-facing → `[Unreleased] > Added` +
  PLAN.md data-model update (both required in the same PR).
- **Non-goals:** offline Python execution in `node run` (no `python3`/Pyodide
  runner — `simulate` and the instance-side `test` verb both run Python on a
  real engine); Python-side `$('…')`/`_('…')` ref rewriting on a rename (the
  rename verb is gone; document the `_('Name')`-blindness of validate's ref
  scan per Task 4); Python linting/type-checking (n8n offers none).
- **Discriminator:** `language: "python"` is the language signal (JS's `.ts` is
  marker-sniffed; Python is declared), which keeps the two paths cleanly separate.
