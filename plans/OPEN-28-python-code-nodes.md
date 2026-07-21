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

## Why

n8n's Code node runs **two** languages: JavaScript (`language: "javaScript"` or
absent, source in `parameters.jsCode`) and **Python** via Pyodide
(`language: "python"`, source in `parameters.pythonCode`). decanter handles only
JS/TS today — a Python node fails the central `isJsCodeNode()` guard
([lib/util.mts:11-17](../lib/util.mts#L11-L17)) on two counts (no `jsCode`,
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

**Scope (confirmed with maintainer 2026-07-21):** full parity across
pull/push/status/watch/check + `add --python`. Offline **`run`** stays JS-only —
a `.py` file errors with a clear pointer to `simulate` (which boots a real n8n
that *does* run Python under Pyodide). No local Python interpreter is added.

## Source

- New backlog item, raised 2026-07-21. No prior `plans/` or `PLAN.md` entry.
- The only existing Python mentions are **competitor-comparison** rows
  ([README.md:214](../README.md#L214),
  [website/src/pages/index.astro:59](../website/src/pages/index.astro#L59)) —
  this plan turns Python from "a thing the competition does" into a decanter
  capability, so those rows update too.
- Python is n8n **parity** (not a decanter differentiator), so it stays in the
  normal backlog — **not** the distinctive-features group (per AGENTS.md).

## Design decision — one source-field abstraction

Everything funnels through three spots today: the `isJsCodeNode()` guard, the
hard-coded `jsCode` field, and the `/\.(ts|js)$/` extension checks. Generalize
those and the rest falls out.

New helpers in [lib/util.mts](../lib/util.mts):

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

Types ([lib/types.mts](../lib/types.mts)): add `pythonCode?: string` to
`NodeParameters`; add a `CodeNode` interface; keep `JsCodeNode` for the JS-only
narrowing.

## Tasks

1. **util.mts + types** — add the helpers and types above.
2. **[lib/pull.mts:74-124](../lib/pull.mts#L74-L124)** — loop guard →
   `isCodeNode`. Branch on `codeSourceField`: `pythonCode` → ext `.py`, take the
   plain-verbatim branch (mirror the `.js` `else` at
   [pull.mts:118-120](../lib/pull.mts#L118-L120)); Python **never** enters the
   `tsManaged`/marker/`.remote.js` branches. Placeholder into the correct field.
3. **[lib/push.mts](../lib/push.mts)** — `buildNodeCode`
   ([push.mts:30-38](../lib/push.mts#L30-L38)) already reads any non-`.ts`
   verbatim, so **`.py` needs no change there**. Broaden the loop guards
   ([:48](../lib/push.mts#L48), [:84](../lib/push.mts#L84),
   [:99](../lib/push.mts#L99)) to `isCodeNode`; swap `node.parameters.jsCode` for
   `readCodeSource`/`setCodeSource`. `splitMarker` on Python source is a no-op.
4. **[lib/validate.mts](../lib/validate.mts)** — allow `.py` in the extension
   gate ([:26](../lib/validate.mts#L26)); keep the `.js` marker-ban + import-scan
   **JS-only**; broaden the node loop ([:141](../lib/validate.mts#L141)) to
   `isCodeNode`; skip the real source field in `parameterStrings`
   ([:165](../lib/validate.mts#L165) — use `codeSourceField`); widen the
   orphan-scan regex ([:187](../lib/validate.mts#L187)) to `/\.(ts|js|py)$/`.
5. **[lib/status.mts](../lib/status.mts)** — `localBody`/loop → `isCodeNode`;
   `.py` local body is verbatim; compare against the correct remote field.
6. **[lib/watch.mts:161](../lib/watch.mts#L161)** — broaden the guard + the
   file→node reverse map to include `.py`; single-node push already flows through
   `buildNodeCode` + `setCodeSource`.
7. **[lib/lifecycle.mts:76](../lib/lifecycle.mts#L76)** &
   **[lib/simulate.mts:276](../lib/simulate.mts#L276)** — `isJsCodeNode` →
   `isCodeNode`, materialize/reconstitute via `setCodeSource`.
8. **[lib/add.mts](../lib/add.mts)** — `--python` path: `ext = ".py"`,
   `language: "python"`, placeholder into `pythonCode`, a Python `DEFAULT_SOURCE`
   using n8n's Python idioms (`_input.all()`, item `.json`, `return`ing a list —
   **verify against docs.n8n.io/code first**). Wire the flag in
   [n8n-decanter.mts:152](../n8n-decanter.mts#L152) /
   [:555-557](../n8n-decanter.mts#L555-L557); `--ts` and `--python` mutually
   exclusive.
9. **[lib/run.mts:191](../lib/run.mts#L191)** — keep the `.js`/`.ts`-only gate;
   for `.py`, throw a clear message pointing to `simulate`.
10. **[scripts/typecheck.mts:62](../scripts/typecheck.mts#L62)** — no change:
    `.py` is already excluded from `isNodeFile` (Python has no typecheck path,
    matching n8n).
11. **[lib/rename.mts](../lib/rename.mts)** — file + node rename works as-is;
    document that cross-node ref rewriting is JS-`$('…')`-only (n8n Python refs
    use `_('Name')`) — known limitation.
12. **Tests** — Python fixtures don't exist anywhere yet. Add: unit
    ([util](../test/unit/util.test.mts), `validate`, `push`, `add`, `simulate`),
    e2e ([test/e2e.mts](../test/e2e.mts) round-trip → `.py`, no marker), opt-in
    smoke ([test/smoke-n8n.mts](../test/smoke-n8n.mts) real-n8n Python round-trip).
13. **Docs (all surfaces, per AGENTS.md)** — README (feature bullet, `## Commands`
    `add "<Node>" [--ts | --python]`, `code/` layout, comparison row 214),
    `docs/cli/*` (`add`/`pull`/`push`/`status`/`check`/`overview`),
    `docs/concepts/sync-layout.md` (+ a Python note: verbatim, untyped, un-bundled,
    not offline-runnable), CHANGELOG `[Unreleased] > Added`, PLAN.md data model
    (source field language-dependent, `language` is the discriminator, `.py`
    verbatim).

## Acceptance / verification

Mock-n8n recipe (`/verify` skill): drive the real CLI against a `node:http` mock
serving a workflow with a **Python** Code node (`type: "n8n-nodes-base.code"`,
`typeVersion: 2`, `parameters.language: "python"`, `parameters.pythonCode`).

1. `pull` → `code/<node>.py` = exact body; `workflow.json` placeholder in
   `pythonCode`; `.decanter.json` maps node → `.py`.
2. Edit `.py`, `push` → mock's `pythonCode` updates; **no** `@ts-n8n` marker.
3. `status` → clean after pull; push-pending after local edit; CONFLICT after a
   mock-side (`PUT /__remote`) Python edit.
4. `check` → passes with a valid `.py`; a stray `code/foo.py` is flagged orphan.
5. `add "Py Node" --python` → `code/py-node.py`, node `language: "python"`,
   re-validates clean.
6. `run code/<node>.py` → errors with the simulate-redirect message.
7. `watch` (unsandboxed) → editing the `.py` triggers a single-node push.

Then `npm test` + `npm run typecheck` green; optionally `npm run test:smoke`.

## Notes

- **CHANGELOG/PLAN implications:** user-facing → `[Unreleased] > Added` +
  PLAN.md data-model update (both required in the same PR).
- **Non-goals:** offline Python execution (no `python3`/Pyodide runner —
  `simulate` covers it); Python-side `rename` ref rewriting; Python
  linting/type-checking (n8n offers none).
- **Discriminator:** `language: "python"` is the language signal (JS's `.ts` is
  marker-sniffed; Python is declared), which keeps the two paths cleanly separate.
