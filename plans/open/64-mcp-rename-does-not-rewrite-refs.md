# Plan 64 — MCP `renameNode` strands every `$('…')` ref; our contract says the opposite

**Status:** In progress — tasks 1 + 2 (#191), 3a (#193) and 3b (#195) shipped;
3c, 3d, 4, 5 open
**Priority:** P1
**Source:** claim B1 of the 2026-07-30 field report (39 renames left every
reference stale). Verified against n8n's source at `n8n@2.30.7`, `n8n@2.32.7`,
`n8n@2.33.3` and `master`, against docs.n8n.io / n8n-io/skills / the n8n issue
tracker / the forum — and **reproduced live against real n8n in Docker (2.30.7
and 2.33.3)**, twice: once for n8n's behavior alone, once end-to-end through
decanter.
**Snapshot:** 2026-08-04T12:33Z @ 39d9f22
**Model:** Opus for task 1 (the contract prose is load-bearing); Sonnet for the rest.

n8n's MCP `renameNode` rewrites the node name and the connections and leaves
every `$('…')` reference dangling — in Code-node source *and* in other nodes'
expression parameters — while reporting success. Our shipped agent contract
promises the opposite, our e2e mock implements the promise, and `publish` never
runs the check that would catch the fallout. **Worst of all, the repair order an
agent would naturally pick silently destroys its own work.** This plan corrects
the contract, makes the two hard errors route their halves, closes the `publish`
hole, and makes the tests honest.

## What was verified

**n8n, live on 2.30.7 and 2.33.3** — the probe used no decanter code: seeded over
the public REST API, renamed over raw MCP, read back over both REST *and*
`get_workflow_details` (byte-identical), so the separate-files approach cannot be
implicated.

| | |
|---|---|
| node name + id | renamed, id stable |
| connections | **rewritten** |
| `jsCode` — `$('X')`, `$node["X"]`, `$items('X')` | **all stale** |
| another node's `={{ $('X')… }}` parameter | **stale** |
| `validationWarnings` | **`[]`** — the op reports success |

Unchanged at every tag checked, so pinning a newer n8n fixes nothing.

**n8n's docs are misleading, and ours then made it worse.** docs.n8n.io's
operations table (line 817) reads *"Renames a node and rewrites connection
references."* That is defensible only under the narrow reading "references
*inside* the connections object" — a reading no one picks without knowing n8n's
internal data model, and which the table's own vocabulary argues against:

| op | wording |
|---|---|
| `removeNode` | "all inbound and outbound **connections**" |
| `addConnection` | "Adds a **connection**" |
| `renameNode` | "rewrites **connection references**" |

Everywhere else the graph edges are plain "connections". **`renameNode` is the one
row that says "references"** — the broader word, naturally read as *references to
the node*, which is exactly what `$('X')` is. Three things push the reader the
same way: `removeNode` carries an explicit side-effect caveat right next door (so
silence here reads as "nothing to watch out for"), the op returns
`validationWarnings: []`, and the n8n **editor genuinely does** rewrite refs — so
"an n8n rename fixes references" is a correct mental model that the docs never
qualify with "unlike the editor". The whole 91 KB page contains zero `jsCode` and
zero `$(`.

So our own text — "connections **and** `$('…')` references" — is a *reasonable
reading of a defective source*. What is ours alone is the **"server-side"**, which
nothing supports and which is false for both paths: the editor's rewrite is
**client-side** (`useCanvasOperations.renameNode` clones a `Workflow` in the
browser, calls `Workflow.renameNode()`, and the result is persisted by an ordinary
whole-workflow `PATCH /rest/workflows/:id`). Control experiment: that same PATCH
with refs deliberately left stale heals **nothing** server-side.

**It reads as an upstream miss, not a design split.** n8n has three rename paths;
the editor and n8n's own AI Workflow Builder both delegate to
`Workflow.renameNode()` (the builder constructs a throwaway `Workflow` with a mock
`INodeTypes` purely to reach it, commented *"to handle all the complexity of
updating expressions"*). PR #24348 wrote that logic in January 2026; PR #29739
introduced the MCP op four months later without it. No issue, no PR, no forum
thread, no release note. n8n-io/skills says nothing either — while its review
checklist actively pushes agents to rename nodes.

**End-to-end through decanter, measured:**

- After a rename through the guard, decanter is already blocked — the live mirror
  pulls automatically, then `preflight --offline` reports **2 layout violations**
  (one per half), score 60/100, exit 1. `push` and `push --force` are
  byte-identically red: `assertCompliant` throws a plain `Error`, so `--force`
  cannot bypass it.
- **Fixing only `code/*.js` leaves push red** on the Set node's parameter alone.
  A repair hook limited to local code unblocks nothing.
- **The intuitive order livelocks.** Fix code → fix the parameter over MCP → that
  op is a forwarded `update_workflow` → the guard schedules a mirror pull →
  `pullWorkflow` overwrites the hand-fixed `code/*.js` with the stale remote body.
  The `overwriting unpushed local changes … (recover via git)` warning fires onto
  the guard's **stderr-only** logger, which no agent reads. Observed: three push
  attempts, all red, no visible cause.
- **The correct order goes green**: parameters over MCP first → then local code →
  then `push` → `layout compliant`, 100/100, pushed.
- The agent *is* allowed to make the parameter fix: `updateNodeParameters` without
  `jsCode` is forwarded by the guard and applied by n8n, and merge semantics
  preserve sibling params.

**And a hole nobody was looking for: `publish` runs no compliance check.**
`validateWorkflowDir` has three callers — `push` (`lib/push.mts:153`), `preflight`
(`lib/preflight.mts:296`), `backup` (`lib/backup.mts:149`) — and `publish`
(`lib/lifecycle.mts:11-19`) is not among them, while `publish_workflow` over MCP
is forwarded unconditionally. **A pure-rename task never calls `push`, so nothing
ever checks, and the broken workflow goes live.** The comforting "it can't ship
silently" reading was false.

## Tasks

### 1. Correct the agent contract (the load-bearing task)

Surfaces stating the false premise: `template/AGENTS.md.example` rule 7
(~:72-76), the `### Renaming a node` section (~:200-215), the `$('Node Name')`
bullet (~:263-268); `template/CLAUDE.md.example:23-26`; `PLAN.md:567` and `:1194`;
`CHANGELOG.md:695`. `docs/cli/pull.md`'s rename section needs the same split.

The new text must carry all four of these or it has not done its job:

1. **Split the paths.** The n8n **editor** rewrites `$('…')` refs for you; the
   **`renameNode` MCP op does not** — it rewrites the name and connections only,
   returns success, and leaves every ref dangling.
2. **Drop "server-side"** — false for both paths.
3. **Name both halves and where each is fixed.** Code refs → edit
   `code/<node>.js`/`.ts` here, then `push`. Expression-parameter refs → these are
   **structure**, fix them on the instance over MCP (`updateNodeParameters`
   without `jsCode` passes the guard) or in the editor. Editing `workflow.json`
   locally changes nothing in n8n, turns `layout` green on a lie, and the next
   pull reverts it.
4. **State the order, and why.** *Parameters over MCP first, then local code, then
   push* — because every forwarded MCP write schedules a background pull that
   overwrites unpushed `.js` edits.

Also drop `template/CLAUDE.md.example`'s "pull after each MCP rename so nothing is
left half-updated": no pull ever fixes a ref, and the live mirror already pulls
(`liveMirror` defaults on).

### 2. Rewrite the two hard-error strings

`lib/validate.mts:158` (source half) and `:201` (parameter half) are today
near-identical, neither names a rename as the likely cause, and neither says the
halves are repaired in different places. That is what misroutes an agent into
hand-editing `workflow.json`. Each string should name the cause and route its
half.

Same change: the comment at `lib/validate.mts:195-196` ("the n8n UI rewrites these
on rename" — true, but it now has to say *only* the UI), and `JSCODE_BLOCK_TEXT`
(`lib/mcpserve.mts:31-34`), whose "…renames, new non-code fields) pass through
normally" currently reads as a promise that a forwarded rename is safe.

Cheapest high-leverage change in the plan: it fires from live data at the exact
blocking moment and adds no mechanism.

### 3. Catch the breakage — three sites, earliest first

Nothing runs a ref check at rename time today, so the damage surfaces at the next
`push`, arbitrarily far from the act that caused it. Three separate sites, in
value order. **3a is the one that matters** — the field report came from the
agent path, and a `publish` gate would not have saved it.

**Framing that has to survive implementation:** `workflow.json` is a
backup/info snapshot, **not a workspace and not an authority**. The local
`layout` check is therefore a statement about *the repo*, not about n8n — it can
be green while the instance is broken (stale snapshot) and red while the instance
is fine (a remote rename not yet pulled). Preflight's `layout` fail and a publish
gate are **two different things** that happen to share one scan. Do not let them
merge during implementation.

#### 3a. Make an MCP rename trigger the verify hook

`template/.claude/settings.json.example:61` matches `Edit|Write|MultiEdit`, so an
MCP rename fires nothing. This is the **only site with a proven path into the
model's context** — `template/.claude/hooks/verify.mjs.example` is the 66-line
precedent (reads `tool_input`, exit 2 feeds output back to the agent).

Two constraints that shape it:

- **It must scan `tool_input` directly, not run `preflight`.** PostToolUse fires
  immediately; the mirror pull is debounced 400 ms and fire-and-forget. Pre-pull,
  `workflow.json` still holds the **old** name, so every ref still resolves and
  `preflight` would report **green**. Take `oldName` out of the op batch and do a
  literal scan of the workflow folder for `$('oldName')` — race-free, no pull, no
  async.
- **Do not make it Claude-only.** Root `AGENTS.md` ("Agent tooling") forbids
  shipping agentic material for one agent. Put the logic in a plain node script
  the hook merely invokes, so `opencode.json.example` can wire the same thing.
  Open question worth settling first: should that script instead be a decanter
  subcommand? It would give the advisory a **command** to name rather than prose
  (`lib/preflight.mts:88-91` contracts `remediation` as "the exact next COMMAND …
  never prose"), at the cost of the four-surface docs tax.

#### 3b. A static tier on `test`, and the same scan as a `publish` gate

**No new verb.** [Plan 60](../done/60-preflight-first-verb-surface.md) already
assigned the subjects — `preflight` grades **local files**, `test` grades **the
instance's draft**, and `test` sits between `push` and `publish` in the
documented flow. A static check of the remote draft is therefore not a new
category: it is the **cheap tier of what `test` already is**. Putting it on
`preflight` would be the outlier, and would re-split what
[Plan 59](../done/59-declutter-verify-verbs.md) just consolidated.

**One scan, two callers.** Extract a **source-agnostic** `(text, nodeNames)`
function out of `lib/validate.mts`, which reads files off disk today. Both
callers need it, because the text comes from different places: locally a Code
node's `jsCode` is a `//@file:` placeholder with the real source in the file,
remotely it is inline on the node.

**`test <workflow>` with no `--scenario`/`--execution` runs the static tier.**
Read the draft, scan every node's `jsCode` and expression parameters for
dangling refs, report, execute nothing.

- **Remove the latest-capture fallback** (`n8n-decanter.mts:739-741`). Not
  tidiness — it is forced: the bare verb cannot mean both "check statically,
  run nothing" and "grab whatever capture is lying around and execute for real".
  It also fixes a genuine wart: today the bare verb has **side effects on the
  instance**, steered by the contents of a **gitignored** directory, so two
  people on the same commit get different behavior. Afterwards the bare verb is
  **read-only** and executing requires saying so. **Breaking** — 0.x → minor.
- **The output must not read as "it ran."** Not `✓ test passed` but something
  like *"static check only — nothing was executed; pass `--scenario`/
  `--execution` to run it."*
- **`test --scenario X` runs the static scan first**, then executes — so we
  never fire a real run against something already known to be broken.

**`publish` calls the same function** on the read it already makes:
`const before = await getWorkflowDetails(mcp, id)` (`lib/lifecycle.mts:12`),
byte-exact `jsCode` and every parameter. Scan `before.nodes`.

- Explicitly **do not** reuse `validateWorkflowDir` — that validates the repo
  folder (placeholders, orphans, state, layout), none of which belongs in a
  go-live decision. Scanning the remote read removes the staleness problem
  entirely: no false green from an out-of-date snapshot, no false red from a
  fresh clone missing a `.ts` file, and therefore **no `ForceableError` pretext
  needed**. It also catches what a local check structurally cannot — instance
  broken, local mirror clean.
- **Yes, the scan usually runs twice** (once in `test`, once in `publish`), and
  that is the point rather than waste: the instance can change between the two
  — a colleague editing in the UI, another agent sending a rename — so only the
  check *inside* `publish` is authoritative for that publish. It is also free:
  `publish` already does the read, so the marginal cost is a regex pass.
- Keep `publish`'s refusal **terse**, pointing at `test` rather than reprinting
  the report.

Note this writes nothing — decanter reads, and refuses its own action. Consistent
with `PLAN.md:94-99`, unlike the rejected "decanter repairs parameters over MCP".

**No legacy support — settled.** The fallback is deleted outright: no deprecation
period, no "warns now, removed later" shim, no env escape hatch. A bare `test`
that still executed *sometimes* would keep exactly the ambiguity this change
exists to remove.

**Docs are part of the task, not a follow-up.** This changes a verb's meaning, so
the surface is wider than the usual three. Grounded list — every file that
currently describes `test`:

| surface | what changes |
|---|---|
| `n8n-decanter.mts:77` | the usage line (`<workflow> [--execution … \| --scenario …]`) must show that bare = static |
| `n8n-decanter.mts:729`, `:740-741` | the arg error, and the removal of the "using the latest capture" info line |
| `README.md` | the `## Commands` row for `test` |
| `docs/cli/test.md` | the whole page — new tier, fallback gone |
| `docs/cli/publish.md` | the new gate and its refusal |
| `docs/cli/overview.md` | the command-surface entry (`check:docs` enforces its existence, not its prose) |
| `docs/cli/preflight.md` | wherever it hands off to `test` |
| `docs/cli/node-run.md` | the ladder mention |
| `docs/agents/offline-loop.md`, `docs/agents/overview.md` | the agent-facing loop |
| `docs/concepts/sync-layout.md` | the flow mention |
| `template/AGENTS.md.example` | the verify flow — the file an agent actually reads |
| `PLAN.md` | Plan 60's `preflight → push → test → publish` description gains a tier |
| `CHANGELOG.md` | **Breaking:** entry |

Deliberately **not** touched: `scenario create`'s own latest-capture fallback
(`n8n-decanter.mts:853-861`). It looks like the same wart but is not — it picks
input data for a **file write**, with no side effect on the instance, so the
ambiguity that forces the removal in `test` does not exist there.

#### 3c. Gate `publish_workflow` in the guard, fail-closed

`guardMessage` only inspects `update_workflow` for `jsCode`, so
`publish_workflow` is forwarded unconditionally: **an agent can go live around
3b entirely.** (`push --publish` is already covered — it runs through
`pushWorkflow`'s gate. Only the bare verb and the raw MCP call are not.)

**Decision: gate it — read the workflow, run 3b's scan, forward only if clean.**

Three objections were raised against this and all three turned out to be wrong,
so they are recorded here rather than re-litigated:

- *"The guard would need a new capability."* It already has one.
  `n8n-decanter.mts:952` builds `const serveMcp = mcp()` and hands it to the
  mirror — the comment says *"reusing the guard's own credentialed client"* — and
  `mcp:connect` does the same (`createMcpClient(config, elog)`, *"same client the
  guard forwards with"*). The guard **already makes its own reads**: the mirror
  runs a full `pullWorkflow` after *every* forwarded `update_workflow`.
- *"Latency."* Measured against that full pull-per-structure-edit, one read
  before the far rarer publish is noise.
- *"It makes the guard a policy engine."* It is one. `guardMessage` inspects
  content and blocks `update_workflow` calls carrying `jsCode`. Gating a publish
  on its content is the same kind of act, not a new category.

**Fail-closed.** If the read fails we block, with a message saying the *check*
could not run — not that the workflow is broken. Rationale: a failing read almost
certainly means n8n is unreachable, in which case the publish would fail anyway,
and "couldn't verify, so we let it go live" is not a gate.

**The one real implementation note:** `guardMessage` is **synchronous** today and
returns a ready-made response for blocks. This needs an async sibling, since the
check requires a round-trip. That is exactly where the two transports could drift
— and `lib/mcpserve.mts:102-104` already states they must not (*"Shared by BOTH
transports on purpose … must not drift"*). So the async path is shared code, and
a test drives **both** transports through the same sequence.

#### 3d. Detect all four reference forms — and stop the hook diverging

`NODE_REF_RE` (`lib/util.mts:89`) matches only `$('X')` / `$("X")` / `` $(`X`) ``.
n8n's own `applyAccessPatterns` handles **four** forms, and rewrites all four on a
UI rename. **If n8n treats it as a reference, our guard has to know it** —
otherwise a rename strands something we never report.

| form | pattern |
|---|---|
| `$('X')` | already covered, three quote styles |
| `$node["X"]` | `\$node\[\s*(['"`])…\1\s*\]` |
| `$node.X` | `\$node\.([A-Za-z_$][\w$]*)` — unquoted; names with spaces cannot use this form anyway |
| `$items('X')` | first string argument; ignore any further arguments |

The documented limits stay: `${…}` template literals and non-literal `$(someVar)`
are unresolvable by regex, and n8n has the same ceiling.

**This is what makes 3a and 3b agree.** The rename hook shipped in 3a already
matches `$(`, `$node[` and `$items(` — so today the **hook reports refs the gate
would let through**, which is the dangerous direction: `$node["Old"]` dangles, the
hook flags it, `publish` waves it live. One contract, and since the hook is a
standalone `.mjs` in the template that cannot import from `lib/`, pin it with a
test that feeds **both** implementations the same corpus of ref forms and asserts
identical detection.

**Delete `renameNodeRefs`** (`lib/util.mts:104`) rather than widening it: zero
production callers since the `rename` verb retired, and we decided not to
auto-repair. Widening it would mean maintaining a rewriter nobody calls.

**Behaviour change worth flagging, not hiding.** This feeds `validateWorkflowDir`,
so `preflight` and `push` too: an existing workflow with a `$node["Deleted"]`
reference starts producing a **hard error** that `--force` cannot bypass, where it
previously passed. Correct, but it will surprise people — so the message should
name *which form* was found, making it obvious why it surfaces now, and the
CHANGELOG entry goes under Changed, not Fixed.

### 4. Make the tests honest

- **`test/e2e.mts:83`** — `renameRefsDeep(n.parameters, …)` implements the
  falsified server property, under a docblock (`:59-61`) claiming it mirrors "the
  verified 2.30.7 semantics". Delete it, fix the docblock and the comment at
  `:1648-1650`. **This is the forcing function**: the rename step at `:1644` then
  goes red, and the scenario has to be rewritten to the real agent path — rename,
  refs dangle, agent repairs both halves in the documented order, green.
- **`test/smoke-n8n.mts`** — contains **zero** `$('` occurrences, so its
  real-instance rename step could never have measured this. Add a cross-node ref
  (a Code node referencing another by name **and** a non-Code node with an
  `={{ $('X')… }}` parameter) and assert the refs are stale after an MCP rename.
  This is the permanent version of the throwaway probe.
- Unit coverage for the new error strings.

### 5. Report upstream — two asks, not one

**(a) The code.** The fix is small and the precedent is in-repo:
`update-workflow.tool.ts` already imports `Workflow` from `n8n-workflow`, and
`applyRenameNodeOperation` in the AI builder shows the exact call shape.

**(b) The docs line, independently** — because even a fixed op leaves the current
wording ambiguous, and because until (a) ships this line is what every MCP client
reads. Concrete suggestion: *"Renames a node and rewrites its **connections**.
`$('Old Name')` references in Code-node source and in other nodes' expression
parameters are **not** updated — the caller must fix them."* Point out that
`renameNode` is the only row in the table using "references" where every sibling
says "connections", and that the neighbouring `removeNode` row shows the table
does document side effects.

Worth telling the n8n-io/skills maintainers too, since their review checklist
pushes agents to rename nodes with no follow-up step. **Do not block this plan on
any of it.**

## Deferred — with reasons, not as an oversight

- **Guard-side detect-and-report** (annotate the rename's tool result). The only
  signal that would reach the agent while it still holds `oldName`/`newName`. But
  it falsifies two stated invariants (`lib/mcpserve.mts:9-10` "responses … pipe
  through untouched", `:102-104` "both transports must not drift"), needs a
  60–100-line incremental SSE transform to reach `mcp serve` without buffering the
  long-lived notification stream, and its payload may be dropped by any client
  that prefers `structuredContent` — `lib/mcp.mts:394` is decanter's own client
  doing exactly that. Revisit if a field-test round shows tasks 1–4 are not enough.
- **Auto-repairing local `.js` refs.** Doesn't unblock `push` (the parameter half
  still hard-errors), and whatever it writes the next mirror pull reverts. Making
  it durable means the mirror starts *writing* to the instance — new machinery on
  the hot path.
  **The one argument that could reopen this:** `.ts` sources can be repaired by
  nothing else — n8n never sees them and pull never writes them. If TS nodes
  become common, revisit that half alone.
  Two corrections to this plan's earlier drafts, so they are not re-derived: the
  objection that a local rewrite breaks the `lastPushedHash`-mirrors-remote
  invariant is **wrong** (`codeDrift` keys on the *remote* hash), and so is "our
  regex is weaker than n8n's" — n8n's `applyAccessPatterns` is a regex too, and
  ours handles backticks theirs doesn't. Our repair ceiling equals our *detection*
  ceiling, so a partial repair would be self-consistent. Deferred on cost, not on
  correctness.
- **Decanter writing the expression-parameter half.** Rejected outright: the first
  structure write decanter would ever emit, bypassing decanter's own guard
  (`lib/mcpserve.mts:11` — decanter's sync never routes through the proxy), with
  no drift guard and no audit line, against `PLAN.md:94-99`. The agent is already
  authorized and the guard already forwards it.
- **A `rename` / `fix-refs` verb.** Repairs only the half an agent fixes trivially
  and pays the full four-surface docs tax.

## Acceptance / verification

- `preflight --offline` on a post-rename workflow names both halves with strings
  that route each one; covered by unit tests. ✅ shipped (tasks 1+2, PR #191)
- **3a**: an MCP rename whose refs go stale produces agent-visible output —
  asserted with the hook driven directly on a captured `tool_input`, *without* a
  pull having run (the pre-pull green is the trap the test must pin).
- **3b**: `publish` refuses a workflow whose **remote** draft carries a dangling
  ref, and still publishes when the remote is clean but the **local** snapshot is
  stale or absent — that pair is the whole point of scanning `before.nodes`
  rather than the folder, so both directions need a test.
- **3b**: bare `test <workflow>` reports the same finding and **executes
  nothing** — asserted against an instance whose draft is broken *and* a
  `executions/` dir holding a usable capture, which today would have been picked
  up and run. Its output must not be mistakable for a run.
- **3b**: `test --scenario X` on a workflow with a dangling ref aborts **before**
  the instance executes.
- **3c**: a raw `publish_workflow` through the guard is blocked when the draft
  carries a dangling ref, and forwarded when it does not — driven through **both**
  transports in one test, because that is where they could drift. A failed read
  blocks with a "could not verify" message, not a "workflow is broken" one. And
  `push --publish`, the bare `publish` verb, and the guarded MCP call all agree.
- **3d**: `$node["X"]`, `$node.X` and `$items('X')` are detected wherever
  `$('X')` is — asserted by feeding one corpus of ref forms to **both** the CLI
  scan and the scaffolded hook and comparing, so the two cannot drift again.
  Existing `$('X')` behaviour is unchanged.
- e2e's rename step asserts the **real** semantics (refs dangle) and walks the
  documented repair order to green.
- The smoke suite's rename step asserts stale refs against a real instance — it
  must **fail** against a hypothetical fixed n8n, which is the signal to revisit
  this plan.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:docs` green.

## Notes

- CHANGELOG: tasks 1 and 2 shipped their entries under `[Unreleased]` in PR #191;
  3a in PR #193. 3b is user-facing twice over and one half is **Breaking:**
  (`test` no longer falls back to the latest capture, so the bare verb stops
  executing); 3c changes what the guard forwards.
- 3b's docs work is listed **inside the task**, not here — it changes a verb's
  meaning, so it spans thirteen surfaces including the CLI's own usage string, and
  treating it as a trailing chore is how it gets half-done.
- `lib/validate.mts:196`'s comment has always been correctly scoped to the UI —
  **the code was right; only the prose was wrong.** The dangling-ref check is what
  made the field report's fallout visible at all.
- Related: [Plan 69](../draft/69-watch-skips-folder-guard.md) — `watch` runs only
  `validateNodeFile`, which has no ref check, so neither half fires in watch mode.
  Same family as task 3.
- Still unproven by experiment: the *positive* UI claim (nobody drove the actual
  editor). The control experiment shows the server heals nothing and the source
  shows the browser calling `Workflow.renameNode`. It changes no decision here.
