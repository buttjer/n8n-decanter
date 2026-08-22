# Plan 84 — Provenance header on generated node code

**Status:** Not started
**Priority:** P2
**Source:** External review feedback (2026-08-22) on the shared-code/bundling
pattern: *"I'd want the source file path, version/commit, and maybe a short
generated header in the node so someone debugging later can still tell where
that body came from. The build step should improve maintainability without
making the deployed node feel mysterious."* Shape settled in the same session
(three prototype rounds against the real compiler). Extends
[Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md); inherited by the
`.js` tier in [Plan 24](24-shared-code-in-js-nodes.md).
**Snapshot:** 2026-08-22T09:17Z @ c4e6ec6
**Theme:** A compiled/bundled Code node in the n8n UI says nothing about where
it came from. Give it a two-line leading header — source path, push time, CLI
version, commit — carried **outside** the hashed body, so it can never cause
drift, a push, or a stale state.
**Model:** Opus for tasks 1–4 (hash/round-trip invariants + the mixed-version
compat story); Sonnet for the docs/test breadth in 7–9.
**Class:** Distinctive feature

Today a `.ts` node deploys as an esbuild bundle whose only self-description is a
`// @ts-n8n sha256:…` line at the very bottom, under a few hundred lines of
inlined helpers — where nobody looks. This adds a two-line header at line 1
naming the source file and the build, and defines it as **pure decoration**: it
is excluded from the hash, its absence is not a stale state, and the marker line
stays byte-identical so older CLIs keep reading these nodes correctly.

## Why

- **The deployed artifact is unattributable.** Open a bundled node in n8n and
  you see `var __n8n_node = {}` followed by inlined `shared/` code. Nothing says
  which repo, which file, which build — or that editing it there is pointless
  because the next push overwrites it.
- **The marker already exists and already fails at this job.** `// @ts-n8n
  sha256:…` carries identity, but it sits at the *end* of the body. The n8n code
  editor opens at line 1. A signpost has to be where the eye lands.
- **The hash is machine-only.** An early draft of this design put the sha256 at
  the top; the reviewer's reaction ("cluttered") was correct — 64 hex characters
  ahead of the first line of real code buy a human nothing. Human text goes up,
  machine data stays down.
- **It costs almost nothing if scoped right.** There is exactly **one**
  op-construction site (`collectOps` in `lib/push.mts`; `pushSingleNode` reuses
  it), so the write side is a single attachment point. The read side is the
  handful of `splitMarker(...).body` calls listed in Task 3.

## The shape (decided)

Verified by compiling a real bundled node (`shared/` import + top-level return)
through `lib/compile.mts`:

```js
/* n8n-decanter · generated from workflows/orders/code/normalize-lines.ts · do not edit here
   pushed 2026-08-20T09:14Z · cli 0.10.1 · commit ca3c201 */
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
// @ts-n8n sha256:39af5ea6423d02856740c29dab3a3a392bd39a693cd0b3ee3eb1ede37cd2581b
```

- **Two lines, one block comment.** Not six, not a `//` run. A `//` run cannot be
  parsed unambiguously: a no-import `.ts` node whose source starts with a comment
  compiles to a body that *also* starts with `//`, and a leading-`//` scanner
  would eat the user's own comment. The literal opener `/* n8n-decanter ` at
  **offset 0**, closed at the first `*/\n`, is unambiguous (prototype-checked
  against exactly that case).
- **Marker line untouched, still last.** Byte-for-byte what ships today — see
  Backwards compatibility.
- **Fields:** source path relative to the **sync dir** (not the workflow dir),
  push timestamp, CLI version, git commit. Commit and CLI version are omitted
  gracefully when unavailable (no git repo / unreadable `package.json`).

### The three invariants

Prototyped and asserted before writing this plan:

| Invariant | Why it matters |
|---|---|
| `sha256(syncBody(withHeader)) === sha256(body)` | the header never enters the hash → a rename, a new commit, a CLI bump can never make a node look changed |
| `syncBody(withHeader) === syncBody(withoutHeader)` | **a missing header is not a state** — no stale, no push-pending, no forced write |
| `splitMarker(withHeader).marker === marker` | the marker is still the last non-blank line, byte-identical |

The second invariant is the load-bearing one and comes straight from the
maintainer's call: *the absence of this comment is not even a stale.* It is what
makes rollout a non-event — old nodes simply never acquire a header until their
code changes for a real reason.

### Why the path must not be hashed

The header names the node's source file, and **the file path follows renames**.
Putting it inside the hashed body re-opens the trap `lib/compile.mts` already
fixed once: `ENTRY_SOURCEFILE` is the fixed literal `node.ts` precisely because
using the real filename made a pure remote rename change the artifact — `pull`
renames the file, the label follows, and the node reads "push pending" forever
on a comment-only diff. (Note the surviving module label
`// workflows/orders/code/node.ts` in the example above: the *directory* is real
and hashed — it is sticky per [Plan 27](../done/27-verb-first-cli-grammar.md) — while
the *filename* is fixed. The design already draws this exact line.)

## Backwards compatibility

The explicit requirement. Four separate compatibility surfaces, each verified:

1. **Older CLIs still recognize these nodes.** The marker line is unchanged and
   still the last non-blank line, so the shipped
   `/(?:^|\n)(\/\/ @ts-n8n (sha256:[0-9a-f]{64}))[ \t]*\n?[ \t\n]*$/` still
   matches a header-carrying node. This is why provenance fields must **not** be
   appended to the marker line (`… sha256:… commit=… cli=…`): the trailing
   `[ \t\n]*$` anchor would stop matching, an old CLI would see a *markerless*
   node, and `pull` would treat a TS-managed node as `.js`. That variant is
   rejected on this ground alone.
2. **Old nodes stay valid forever.** A node pushed before this plan has no
   header; `syncBody` returns the same body either way, so it reads **in sync**,
   not stale. There is no migration, no flag day, no mass re-push across every
   workflow. Nodes acquire a header opportunistically, on their next real code
   push.
3. **Mixed-version teams degrade softly, once.** An *old* CLI hashes the header
   as part of the body, so on a node a new CLI pushed it computes a body hash
   that matches neither `lastPushedHash` nor its local build → it reports a
   phantom `CONFLICT`. It self-heals: `lib/pull.mts` re-baselines
   `lastPushedHash` on every branch including conflict, so one `pull` clears it,
   at the cost of one alarming warning. The reverse direction is clean — a new
   CLI reading state written by an old one sees `remoteHash === localHash` and
   takes neither the drift branch in `codeDrift` nor a `status` conflict. This
   asymmetry (new tolerates old, old complains once about new) is the accepted
   cost and belongs in the CHANGELOG entry verbatim.
4. **`test/field-test/verify.mts` keeps working unmodified.** It deliberately
   re-implements `splitMarker` and reads `markerHash` directly; since the marker
   is unchanged, archived field-test rounds keep verifying. Worth confirming
   rather than assuming — it is the only intentional duplicate of the regex.

**Opt-out:** a `nodeHeader: false` key in `decanter.config.json` suppresses
emission (Task 6). Default **on** — the feature is worthless if nobody sees it,
and the blast radius above is small. Turning it off does not strip existing
headers (that would be a write, and a header is never worth a write); nodes shed
it on their next real push.

## Tasks

1. **`lib/util.mts` — the header primitives.** `HEADER_OPEN = "/* n8n-decanter "`,
   `HEADER_CLOSE = "*/\n"`; `splitHeader(code) → { header, rest }` anchored at
   offset 0; `renderHeader(provenance) → string`; and the one function everything
   else calls: **`syncBody(code) = splitMarker(splitHeader(code).rest).body`**.
   `splitMarker` and `withMarker` are **not** modified — that is the point.
2. **`lib/push.mts` — attach at the single write site.** `collectOps` builds the
   op payload as `renderHeader(prov) + jsCode` while continuing to compare
   `hash` (body-only) against `sha256(syncBody(remote))`. Deliberately **not** in
   `buildNodeCode`: its other two callers are `lib/backup.mts:156`
   (`assembleForRestore`) and `lib/simulate.mts:568`, and neither should stamp a
   "pushed at" provenance for an event that is not a push. Note `pushSingleNode`
   (watch saves) routes through `collectOps`, so it inherits this for free —
   confirm, don't re-implement.
   - **The header must never force a write.** The existing `missingMarker` /
     `strayMarker` reconciliation forces body-equal writes for *marker* state;
     there is deliberately **no** `missingHeader` counterpart. A body-equal node
     with no header stays on the `continue` path.
3. **Route every body read through `syncBody`.** Full list, verified by grep —
   missing one means that surface sees the exact drift this design prevents:
   - `lib/push.mts:82` (`recordSync`), `:116` (`collectOps` remote split),
     `:202` (`verifyRoundTrip` — it currently `splitMarker`s the remote and
     byte-compares, so a header would read as a round-trip violation)
   - `lib/pull.mts:114`
   - `lib/status.mts:117` (`localBody` at `:14` calls `compileTs`, **not**
     `buildNodeCode`, so the local side is already header-free — confirm and
     leave alone); `lib/diff.mts` consumes `computeSyncFacts`, so it follows
   - `lib/testrun.mts:171`, `:219`, `:237`, `:358`
   - `lib/run.mts:328` — strips a marker from a *local* `.js` file defensively;
     mirror that for a header
4. **Provenance assembly + the commit-ordering trap.** Add a `headCommit(dir)`
   helper to `lib/git.mts` (it has only `isGitRepo` and `commitWorkflowDir`
   today) returning a short sha, or `null` outside a repo. CLI version comes from
   the existing `packageVersion()` in `lib/init.mts:70`. Source path is relative
   to the **sync dir** (`findBundleContext().syncRoot`), not the workflow dir.
   - **`commitWorkflowDir` runs *after* the MCP write** (`lib/push.mts:188`), so
     HEAD at build time is the commit *before* the one containing the pushed
     source. Render it honestly as `commit ca3c201+dirty` when the workflow dir
     or a bundled input has uncommitted changes — which, under `commitOnPush`,
     is the normal case, and correctly reads as "built from working-tree state on
     top of ca3c201". **Rejected alternative:** moving the auto-commit ahead of
     the write, which would leave a commit claiming a push that then failed.
5. **`lib/validate.mts` — a header in a *source* file is an error.** Mirror the
   existing marker rule at `:56` (currently `.js`-only) for the header, and apply
   it to **both** `.js` and `.ts` sources: like the marker, it is a push artifact
   an agent must never hand-write. Surfaces via `preflight`'s `layout` check.
6. **`decanter.config.json` — `nodeHeader` (boolean, default `true`).** Read
   where the other config keys are read; thread it into `collectOps`. Document
   the "off does not strip" semantics.
7. **Docs — every surface, same PR** (per `AGENTS.md`):
   - `docs/concepts/typescript-nodes.md:26-27` and `:44-47` — the marker section
     gains the header as a sibling concept, with the "not stale" rule stated
     plainly.
   - The agent invariant *"never write a `// @ts-n8n sha256:` line"* appears on
     four surfaces and each must gain the header: `docs/agents/overview.md:122`,
     `template/AGENTS.md.example:30` and `:76`,
     `template/.cursor/rules/n8n-decanter.mdc.example:19`, plus the wall
     description in `template/CLAUDE.md.example:11`.
   - `docs/cli/push.md` (what push writes), `docs/cli/preflight.md:154` (new
     violation), `docs/concepts/configuration.md` (`nodeHeader`).
   - `README.md` — a feature bullet; no new verb, so no `## Commands` row.
   - `CHANGELOG.md` `[Unreleased]` → **Added**, including the mixed-version note
     from Backwards compatibility item 3.
   - `PLAN.md:159` (the data-model block showing the marker) and `:608` (guard
     rules) — the header is a data-model addition and must not drift.
8. **Unit tests** (`test/unit/util.test.mts`, alongside the existing
   `splitMarker` suite): `splitHeader` round-trip; **offset-0 anchoring** —
   a body starting with a user's own `//` comment, and one starting with an
   unrelated `/* … */`, are both left intact; `syncBody` equality across
   header/headerless for the same body; unterminated header returns the input
   unchanged. Plus a pinned rendering test so the shape cannot drift silently.
9. **e2e** (`test/e2e.mts`, dual REST+MCP mock): push a `.ts` node → the mock's
   draft body starts with the header **and** still ends with the marker;
   `pull`/`status`/`diff` report **in sync**; strip the header from the mock's
   remote body by hand → still **in sync, no push queued** (the "not even stale"
   assertion, and the single most important test in this plan); a real code edit
   → one push, header refreshed. Existing assertions at `:848`, `:1819`,
   `:2837`, `:2844-2847` are `$`-anchored on the marker and must keep passing
   unchanged — they are the regression net for compatibility item 1.
   Timestamps make the header non-deterministic: match with regexes, never exact
   strings.
10. **Smoke** (`test/smoke-n8n.mts`, opt-in): the header survives a real n8n
    round-trip byte-intact next to the existing marker-survival step at `:319`,
    and a header-carrying bundled node still **executes** in the task-runner
    sandbox (a leading block comment in a function body is legal, but Plan 14's
    history says assume nothing about that sandbox).

## Acceptance / verification

- A pushed `.ts` node opens in the n8n UI with the source path and build info on
  line 1, and still ends with an unmodified `@ts-n8n` marker.
- **A node with no header is in sync** — `status`, `preflight`, `diff` and
  `push` all say nothing about it, and no write is queued for it. Asserted in
  both unit and e2e.
- Renaming a node (remote rename → `pull` renames the file → header path
  changes) queues **no** push.
- A new commit, a CLI upgrade, or a re-push of unchanged code queues **no**
  push.
- The shipped `splitMarker` regex still matches a header-carrying node
  (pinned test), and `test/field-test/verify.mts` passes unmodified.
- `nodeHeader: false` produces byte-identical output to today's.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Non-goals

- **No provenance fields on the marker line.** Rejected in Backwards
  compatibility item 1 — it silently breaks older CLIs' TS detection.
- **No hash at the top.** Machine-only data, and it is what made the first draft
  cluttered.
- **No header for verbatim `.js` nodes** — that tier's contract is a
  byte-identical round-trip. When [Plan 24](24-shared-code-in-js-nodes.md) lands,
  bundled `.js` becomes managed and inherits the header on the same rule:
  *header where marker*.
- **No tamper-proofing.** The header is outside the hash, so a viewer can edit
  it without detection. It is a signpost, not an audit record; the audit record
  stays the marker hash plus n8n's version history.
- **No header in `workflow.json`.** Pull placeholders every tracked node's
  `jsCode` (`lib/pull.mts:178`), so the snapshot never carries it.

## Notes

- **Accepted cost:** n8n runtime error line numbers shift by two more lines.
  Bundled nodes already shift (helpers land above the body — Plan 14), and a
  fixed-size header is a constant offset.
- **Rejected shape — leading marker + provenance block.** Moving the sha256 up
  next to the header was prototyped and dropped for two reasons: the hex
  dominates the top of the file visually, and folding an identity value into a
  human-readable block invites a viewer to destroy it with a stray edit. (It
  would have self-healed via the `missingMarker` write at `lib/push.mts:126`,
  but "self-heals" is a poor argument for a design that invites the break.)
- **Cross-links:** [Plan 14](../done/14-bundle-shared-code-into-ts-pushes.md)
  (the compiler and marker this decorates),
  [Plan 24](24-shared-code-in-js-nodes.md) (inherits the header for bundled
  `.js`), [Plan 79](../done/79-shared-code-roots-anywhere.md) (why
  machine-specific bytes must stay out of the hashed artifact),
  [Plan 27](../done/27-verb-first-cli-grammar.md) (sticky workflow folders — why the
  *directory* part of a path is safe to hash and the filename is not).
