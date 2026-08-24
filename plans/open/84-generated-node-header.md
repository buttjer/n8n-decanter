# Plan 84 — Provenance line on generated node code

**Status:** Not started
**Priority:** P2
**Source:** External review feedback (2026-08-22) on the shared-code/bundling
pattern: *"I'd want the source file path, version/commit, and maybe a short
generated header in the node so someone debugging later can still tell where
that body came from. The build step should improve maintainability without
making the deployed node feel mysterious."* Shape settled over the following
session (prototyped against the real compiler at each step). Extends
[Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md); simplifies part of
[Plan 24](24-shared-code-in-js-nodes.md) — see Notes.
**Snapshot:** 2026-08-24T06:41Z @ c4e6ec6
**Theme:** A compiled/bundled Code node in the n8n UI says nothing about where
it came from. Move the whole self-description to **line 1** — tool name, source
path, "do not edit here", the sha256, CLI version, commit, push time — and keep
reading the legacy trailing marker forever so nothing has to migrate.
**Model:** Opus for tasks 1–4 (marker relocation, the read-both fallback, the
mixed-version story); Sonnet for the docs/test breadth in 7–10.
**Class:** Distinctive feature

Today a `.ts` node deploys as an esbuild bundle whose only self-description is
`// @ts-n8n sha256:…` on the last line — below a few hundred lines of inlined
helpers, where nobody looks, and naming *n8n* rather than the tool that put it
there. This moves that identity to line 1 and enriches it with the source path
and build stamp. The reader accepts **both** positions (line 1, then the
trailing line), so every already-pushed node keeps working untouched and
forever.

## Why

- **The deployed artifact is unattributable.** Open a bundled node in n8n and
  you see `var __n8n_node = {}` followed by inlined `shared/` code. Nothing says
  which repo, which file, which build — or that editing it there is pointless
  because the next push overwrites it.
- **`@ts-n8n` cannot be made self-describing.** It names n8n, not decanter, and
  the token is frozen: a prefix breaks the `\n// @ts-n8n` match, a suffix breaks
  the `$` anchor. The only way to put the tool's name next to the hash is to
  move the hash.
- **The bottom is the wrong place.** The n8n code editor opens at line 1. A
  signpost has to be where the eye lands; identity may as well ride along, since
  it has to move anyway to carry the name.
- **It is a small change.** There is exactly **one** op-construction site
  (`collectOps` in `lib/push.mts`; `pushSingleNode` reuses it), so the write side
  is a single attachment point. The read side is the `splitMarker` calls listed
  in Task 3.

## The shape (decided)

Verified by compiling a real bundled node (`shared/` import + top-level return)
through `lib/compile.mts`:

```js
// n8n-decanter · workflows/orders/code/normalize-lines.ts · do not edit here · @ts-n8n sha256:39af5ea6…2581b · v0.10.1 ca3c201 2026-08-20T09:14Z
var __n8n_node = {};
(() => {
  // shared/money.ts
  function toCents(amount) {
    return Math.round(amount * 100);
  }

  // workflows/orders/code/node.ts
  __n8n_node.default = async () => {
    const out = items.map((i) => ({ json: { cents: toCents(i.json.amount) } }));
    return out;
  };
})();
return __n8n_node.default();
```

- **One line, and no trailing marker on new pushes.** 195 characters at the
  example's path length (full sha, elided above for the margin). Long, and
  accepted: it is one line, it is a comment, and everything on it is something a
  debugger or the tool actually needs.
- **Human facts first, machine facts last** — tool, path, "do not edit here",
  then sha/version/commit/time. Reading left to right you stop caring at exactly
  the point the data stops being for you.
- **`@ts-n8n` survives as the token**, mid-line. Not cosmetic: a single
  `grep -r @ts-n8n` keeps finding both the new and the legacy form, which keeps
  the existing docs, tests and agent rules referring to one searchable name.
- **The hash covers only the body below line 1.** Same rule as today's trailing
  marker, which is likewise outside its own hash.
- **Fields:** source path relative to the **sync dir** (not the workflow dir),
  sha256, CLI version, git commit, push timestamp. Commit and version degrade
  gracefully when unavailable (no git repo / unreadable `package.json`).

### The invariants

Prototyped and asserted before this rework:

| Invariant | Why it matters |
|---|---|
| `sha256(readMarker(newForm).body) === sha256(body)` | line 1 is outside the hash → a rename, a new commit or a CLI bump can never make a node look changed |
| `readMarker(legacyForm).where === "trailing"` | every already-pushed node stays readable, with its hash and body recovered byte-exactly |
| a legacy node is **in sync**, not stale | nothing rewrites a node merely to relocate its marker — no migration, no mass re-push |
| a body starting with the user's own `//` comment is left intact | line 1 is matched on the literal prefix `// n8n-decanter `, not on "starts with a comment" |

The third is the load-bearing one and comes straight from the maintainer's call:
*the absence of this comment is not even a stale.* It is what makes rollout a
non-event.

### Why the path must not be hashed

Line 1 names the node's source file, and **the file path follows renames**.
Putting it inside the hashed body would re-open the trap `lib/compile.mts`
already fixed once: `ENTRY_SOURCEFILE` is the fixed literal `node.ts` precisely
because using the real filename made a pure remote rename change the artifact —
`pull` renames the file, the label follows, and the node reads "push pending"
forever on a comment-only diff. (Note the surviving module label
`// workflows/orders/code/node.ts` in the example above: the *directory* is real
and hashed — it is sticky per
[Plan 27](../done/27-verb-first-cli-grammar.md) — while the *filename* is fixed.
The design already draws this exact line.)

## Backwards compatibility

The explicit requirement, and the reason the design is read-both / write-one.

1. **Our reader accepts both positions — verified.** `splitMarker` tries line 1
   first, then the trailing line. Both forms recover the same hash and the same
   body byte-exactly:

   ```
   new     where=leading   hash-ok=true body-ok=true
   legacy  where=trailing  hash-ok=true body-ok=true
   ```

   The trailing branch is permanent, not a transition: a node not pushed for a
   year still has that form.
2. **No migration of existing nodes.** A legacy node reads in sync, so nothing
   queues a write just to move its marker. Nodes adopt line 1 opportunistically,
   on their next real code push. There is no flag day and no mass re-push across
   every workflow.
3. **Intended break: older CLIs stop recognising newly-pushed nodes.** A shipped
   `splitMarker` is trailing-only, so on a node written in the new form it finds
   no marker and `pull` treats a TS-managed node as `.js`. Read-side tolerance
   cannot fix versions already released.
   - **This is fine and deliberate.** Maintainer's stance (2026-08-24): while the
     project is pre-1.0, breaking changes are expected and wanted rather than
     worked around, so **no compat shim ships for this** — no config flag to keep
     writing the old position, no dual-write. The changelog entry says plainly
     that older CLIs will not recognise newly-pushed nodes.
   - **The realistic case degrades softly anyway.** `lib/pull.mts:141-147`
     already guards it: *local `.ts` exists but remote code has no marker* → keep
     the `.ts`, warn, and the next push re-registers. What actually breaks is
     narrower — a clone in which the `.ts` source was never committed, where pull
     would write the compiled body out as `code/<node>.js`.
4. **`test/field-test/verify.mts` must be updated** — it deliberately
   re-implements `splitMarker` (`:120-122`) as trailing-only. Archived rounds
   keep verifying (they contain legacy-form nodes), but the checks at `:405-440`
   would fail against a new-form node. This flips an earlier assumption in this
   plan that it needed no change.
5. **New risk: the hash has exactly one copy, in a human-editable line.** Under
   the trailing-marker design a stray edit to a leading comment cost nothing.
   Now, deleting line 1 in the n8n UI destroys identity outright. It self-heals
   via the existing `missingMarker` force-write (`lib/push.mts:126`) on the next
   push — but only while `.decanter.json` still knows the node. Accepted, with
   the "do not edit here" text on the line itself as the deterrent.

## Tasks

1. **`lib/util.mts` — relocate the marker, keep the legacy reader.**
   - `splitMarker(code) → { body, marker, markerHash, where }` where
     `where ∈ {"leading","trailing",null}`: match the line-1 form first
     (literal prefix `// n8n-decanter ` at offset 0, `@ts-n8n (sha256:…)`
     within it, terminated by the first newline), then fall back to today's
     trailing regex **unchanged**.
   - `renderMarkerLine(provenance) → string` and
     `withMarker(compiledJs, provenance)` emitting the new form. **One write
     shape only** — no `trailing` write mode (see compat item 3).
   - Callers that read only `body` keep working untouched — that is what makes
     Task 3 a review pass rather than a rewrite.
2. **`lib/push.mts` — write the new form at the single write site.**
   `collectOps` builds the op payload as `renderMarkerLine(prov) + body`.
   Deliberately **not** in `buildNodeCode`: its other two callers are
   `lib/backup.mts:156` (`assembleForRestore`) and `lib/simulate.mts:568`, and
   neither should stamp a "pushed at" provenance for an event that is not a
   push. `pushSingleNode` (watch saves) routes through `collectOps` and inherits
   it — confirm, don't re-implement.
   - **Relocation alone must never force a write.** `missingMarker` /
     `strayMarker` force body-equal writes for *absent or stray* marker state;
     a legacy-positioned marker is neither. Add no `wrongPosition` case — a
     body-equal legacy node stays on the `continue` path.
3. **Review every body read** (they inherit correctness from Task 1, but each
   must be confirmed against the `where` semantics, and `verifyRoundTrip` needs
   real work):
   - `lib/push.mts:82` (`recordSync`), `:116` (`collectOps` remote split),
     `:202` (`verifyRoundTrip` — it byte-compares the remote body against the
     local build, so it must compare *bodies*, never the framed payload)
   - `lib/pull.mts:114` — plus the extension question: with the path on line 1,
     `where === "leading"` can derive `.ts`/`.js` from the path instead of from
     the token (see Notes)
   - `lib/status.mts:117` (`localBody` at `:14` calls `compileTs`, **not**
     `buildNodeCode`, so the local side is already frame-free — confirm and
     leave alone); `lib/diff.mts` consumes `computeSyncFacts`, so it follows
   - `lib/testrun.mts:171`, `:219`, `:237`, `:358`
   - `lib/run.mts:328` — strips a marker from a *local* `.js` file defensively;
     it gets the leading form for free via Task 1
4. **Provenance assembly + the commit-ordering trap.** Add a `headCommit(dir)`
   helper to `lib/git.mts` (it has only `isGitRepo` and `commitWorkflowDir`
   today) returning a short sha, or `null` outside a repo. CLI version comes from
   the existing `packageVersion()` in `lib/init.mts:70`. Source path is relative
   to the **sync dir** (`findBundleContext().syncRoot`), not the workflow dir.
   - **`commitWorkflowDir` runs *after* the MCP write** (`lib/push.mts:188`), so
     HEAD at build time is the commit *before* the one containing the pushed
     source. Render it honestly as `ca3c201+dirty` when the workflow dir or a
     bundled input has uncommitted changes — which, under `commitOnPush`, is the
     normal case, and correctly reads as "built from working-tree state on top of
     ca3c201". **Rejected alternative:** moving the auto-commit ahead of the
     write, which would leave a commit claiming a push that then failed.
5. **`lib/validate.mts` — a marker line in a *source* file is an error, in
   either position.** Extend the existing rule at `:56` (currently trailing-only
   and `.js`-only) to both positions and both `.js` and `.ts`: it is a push
   artifact an agent must never hand-write. Surfaces via `preflight`'s `layout`
   check.
6. **Docs — every surface, same PR** (per `AGENTS.md`):
   - `docs/concepts/typescript-nodes.md:26-27` and `:44-47` — the marker's
     position, what line 1 carries, and that both positions are read.
   - The agent invariant *"never write a `// @ts-n8n sha256:` line"* appears on
     four surfaces and each must cover the new form: `docs/agents/overview.md:122`,
     `template/AGENTS.md.example:30` and `:76`,
     `template/.cursor/rules/n8n-decanter.mdc.example:19`, plus the wall
     description in `template/CLAUDE.md.example:11`.
   - `docs/cli/push.md` (what push writes), `docs/cli/preflight.md:154` (the
     violation now covers both positions).
   - `README.md` — a feature bullet; no new verb, so no `## Commands` row.
   - `CHANGELOG.md` `[Unreleased]` → **Breaking:** prefix on the Changed entry
     (the marker moved to line 1; both positions are read, only the new one is
     written) plus **Added** (path/version/commit/time on it), stating plainly
     that older CLIs will not recognise newly-pushed nodes.
   - `PLAN.md:159` (the data-model block showing the marker as "the last line")
     and `:608` (guard rules) — this is a data-model change and must not drift.
7. **Unit tests** (`test/unit/util.test.mts`, extending the `splitMarker`
   suite): both positions parse to the same `{ body, markerHash }`; `where` is
   reported correctly; the existing trailing cases (whitespace tolerance,
   not-last-line rejection, malformed hashes) still pass **unchanged**; a body
   starting with the user's own `//` or `/* … */` comment is left intact; a
   leading line without a valid sha falls through to the trailing branch. Plus a
   pinned rendering test so the line's shape cannot drift silently.
8. **e2e** (`test/e2e.mts`, dual REST+MCP mock): push a `.ts` node → the mock's
   draft body **starts** with the new line and has **no** trailing marker;
   `pull`/`status`/`diff` report in sync; seed the mock with a legacy-form node
   → still **in sync, no push queued** (the "not even stale" assertion, and the
   single most important test in this plan); a real code edit → one push, line 1
   refreshed.
   - **The `$`-anchored assertions at `:848`, `:1819`, `:2837`, `:2844-2847`
     must be rewritten**, not preserved: they assert the trailing position that
     new pushes no longer produce. Keep a legacy-form fixture so the trailing
     reader stays covered.
   - Timestamps make the line non-deterministic: match with regexes, never exact
     strings.
9. **Smoke** (`test/smoke-n8n.mts`, opt-in): the marker-survival step at `:319`
    moves to the leading form — the line must come back byte-intact through a
    real n8n round-trip — and a new-form bundled node must still **execute** in
    the task-runner sandbox (a leading line comment in a function body is legal,
    but Plan 14's history says assume nothing about that sandbox).

## Acceptance / verification

- A pushed `.ts` node opens in the n8n UI with tool name, source path, "do not
  edit here" and the build stamp on line 1, and **no** trailing marker.
- **A legacy-form node is in sync** — `status`, `preflight`, `diff` and `push`
  all say nothing about it, and no write is queued. Asserted in both unit and
  e2e.
- Both positions round-trip: `pull` of a new-form node recreates `.ts`; `pull` of
  a legacy-form node still does.
- Renaming a node (remote rename → `pull` renames the file → the path on line 1
  changes) queues **no** push. A new commit, a CLI upgrade, or a re-push of
  unchanged code likewise queues **no** push.
- `test/field-test/verify.mts` passes against both forms.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Non-goals

- **No migration pass.** Nothing rewrites a node to relocate its marker; see
  compat item 2. A deliberate opt-in backfill (`push --restamp`) was discussed
  and is **deferred** — the relocation does not need it.
- **No renaming of the `@ts-n8n` token.** It stays greppable and unchanged; only
  its position and its neighbours change.
- **No compat shim for older CLIs** — no config flag to keep writing the old
  position, no dual-write, no version negotiation. Pre-1.0, the break is wanted
  (compat item 3); a shim would only preserve the problem the plan exists to fix.
- **No marker for verbatim `.js` nodes** — that tier's contract is a
  byte-identical round-trip. When [Plan 24](24-shared-code-in-js-nodes.md) lands,
  bundled `.js` becomes managed and inherits line 1.
- **No tamper-proofing.** Line 1 is outside the hash, so a viewer can edit it
  without detection (see compat item 5). It is a signpost; the audit record is
  the hash plus n8n's version history.
- **No marker in `workflow.json`.** Pull placeholders every tracked node's
  `jsCode` (`lib/pull.mts:178`), so the snapshot never carries it.

## Notes

- **This simplifies Plan 24.** That plan's central new concept is a second
  marker token — `@js-n8n` vs `@ts-n8n` — because "a fresh pull must recreate the
  correct file *extension* from `jsCode` alone, and its only signal is the marker
  line". With the **source path on line 1, the extension is right there**, so the
  new form needs no second token: `where === "leading"` derives the kind from the
  path. Plan 24 still needs `@js-n8n` for its own trailing-form nodes if it ships
  first; if this plan lands first, that task shrinks to nothing. Worth
  re-sequencing the two.
- **Accepted cost:** n8n runtime error line numbers shift by one line. Bundled
  nodes already shift (helpers land above the body — Plan 14), and one line is a
  constant offset.
- **Rejected variant — provenance appended to the trailing marker.** The first
  agreed shape put `commit=`/`cli=`/`at=` after the hex and kept the marker at
  the bottom. It breaks older CLIs the same way the relocation does (the `$`
  anchor stops matching) *and* leaves the tool's name invisible at the bottom of
  the file — strictly worse, so if the break is being accepted, accept it for the
  version that actually solves the problem.
- **Rejected variant — line 1 for humans, hash stays at the bottom.** Kept full
  backwards compatibility, and was the design for one round. Dropped because
  `@ts-n8n` still could not name the tool, so a node's *only* machine-readable
  trace remained unattributable — and, per the "not even a stale" rule, a node
  that never changes again would never acquire a line 1 either.
- **Rejected variant — a two-line `/* … */` block.** Drafted, then dropped: the
  ambiguity a block comment avoids belongs to a *run* of `//` lines, not to a
  single line matched on a literal prefix at offset 0, so the block bought
  nothing.
- **Cross-links:** [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)
  (the compiler and marker this relocates),
  [Plan 24](24-shared-code-in-js-nodes.md) (inherits line 1; loses its second
  marker token), [Plan 79](../done/79-shared-code-roots-anywhere.md) (why
  machine-specific bytes must stay out of the hashed artifact),
  [Plan 27](../done/27-verb-first-cli-grammar.md) (sticky workflow folders — why
  the *directory* part of a path is safe to hash and the filename is not).
