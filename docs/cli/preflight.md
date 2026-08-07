---
title: preflight
description: "The gate — grades your LOCAL code as one scored, read-only verdict: layout, types, instance reads, and an optional local-engine replay. Nothing it does can touch the published version or the outside world."
order: 9
---

```sh
n8n-decanter preflight [workflow…] [--simulate] [--offline] [--viewer]
                       [--json] [--fail-on=warn] [--fail-fast] [--require=<ids>]
                       [--no-typecheck] [--no-fetch]
                       [--execution <id> | --scenario <slug>] [--n8n-version <ver>]
```

**`preflight` verifies your local code** — local static → instance read-only →
local-engine replay — ordered fast→slow, and condenses them into a scored
verdict with actionable feedback for humans *and* agents. It is the whole
verify surface: the layout-compliance guard, the typecheck, the sync/drift
summary, and the offline engine replay all live here, behind two flags.

**It never runs your workflow on the n8n instance.** That is
[`test`](/docs/cli/test/)'s job, and it belongs *after* the push — see
[the flow](#the-flow-preflight--push--test--publish) below. For the *changed
lines* rather than the summary, use [`diff`](/docs/cli/diff/).

With no workflow it runs every workflow in your config (or opens the
[picker](/docs/cli/overview/#interactive-picker) on a terminal); when the config
lists none, it falls back to **every pulled workflow**, so a fresh scaffold
still gets a whole-project gate. The exit code aggregates across them.

## The flow: `preflight` → `push` → `test` → `publish`

```sh
n8n-decanter preflight <workflow>   # 1. is my local code sound?      (local)
n8n-decanter push     <workflow>    # 2. make it the draft            (writes the draft)
n8n-decanter test     <workflow>    # 3. grade the draft on n8n       (static; pinned run with a flag)
n8n-decanter publish  <workflow>    # 4. go live                      (publishes)
```

The order is the point. `test` runs n8n's **draft**, so before step 2 the draft
is not your code — an instance run at step 1 would grade something you aren't
shipping. Each step verifies the artifact the previous step produced:

| Step | Grades | Touches n8n? |
| --- | --- | --- |
| `preflight` | your local files | reads only |
| `push` | — | **writes the draft** |
| `test` | the draft, which is now your code | reads it; **runs the draft** with `--execution`/`--scenario` |
| `publish` | — | **publishes** |

`preflight` is deliberately the only step that changes nothing. It is safe to
run on every save, in a hook, or in CI.

## Depth: two flags, no profiles

```sh
n8n-decanter preflight                       # static + instance reads   (the default gate)
n8n-decanter preflight --simulate            # + a local-engine run of your code (Docker)
n8n-decanter preflight --offline             # static only — no instance contact
n8n-decanter preflight --offline --simulate  # static + local engine, still no instance
```

**`--simulate` is additive, `--offline` is subtractive, and they compose.**

| Invocation | Tiers | For |
| --- | --- | --- |
| `preflight` | static + sync | the pre-push gate |
| `preflight --simulate` | static + sync + runtime | maximum coverage before a push |
| `preflight --offline` | static | an edit hook, an air-gapped CI lint |
| `preflight --offline --simulate` | static + runtime | air-gapped runtime evidence — needs a pin source you already have or can scaffold (below) |

> **`--offline` no longer implies the engine replay.** It used to; now it does
> exactly one thing — drop the instance tier. The old `--offline` behaviour
> (static + a local engine run, no instance) is
> **`preflight --offline --simulate`**. The `--full`, `--quick`, and
> `--default` profile flags are gone with the vocabulary: `--full` is
> `--simulate`, `--quick` is `--offline`. They are **unrecognized, not
> rejected** — the CLI ignores unknown flags, so `preflight --full` silently
> runs the default gate with no engine. Update any CI job that passes one;
> nothing will warn you at runtime.

Nothing escalates on its own. An auto-escalating variant (run the engine only
"when it would add signal") was **rejected** — surprise Docker boots and
nondeterministic wall time are worse than one explicit flag. Every skipped
check prints its reason and its unlock, so a run is never silently narrower
than it looks.

## The ladder — every check, fast → slow

Each check has a **stable id** (agents key on it).

| Tier | Check | Verifies | Can produce |
| --- | --- | --- | --- |
| **static** (offline, ms) | `layout` | the [compliance guard](#what-the-compliance-guard-catches): placeholders, connections, duplicate names/ids, orphans, dangling node refs (`$('…')`, `$node[…]`, `$node.X`, `$items(…)`) | fail / warn |
| | `types` | [typecheck](#typecheck) of the node files | fail / skip |
| **sync** (instance, read-only) | `connect` | MCP reachable, auth valid (exercises OAuth refresh) | fail |
| | `access` | workflow is *Available in MCP* | fail |
| | `parity` | local code == the draft, node by node — i.e. is a `push` pending | pass / warn |
| | `drift` | remote code moved off the last sync — someone edited on the instance | warn / **fail on CONFLICT** |
| | `snapshot` | the `workflow.json` structure snapshot still matches n8n | pass / warn |
| | `lifecycle` | published or unpublished, and whether the live version lags the draft | info |
| | `history` | recent production runs: error rate, most recent failure | warn |
| | `capture` | a capture/scenario exists to pin from, and matches the draft | warn / info |
| **runtime** (executes locally, minutes) | `simulate` | [pinned replay](#the---simulate-stage) of **local** code on a **local** engine, per-node diff | fail / skip |

Checks **stream as they complete**, so a fast red surfaces in the first second
even when the runtime tier takes minutes. `--fail-fast` stops after the first
failure (the rest are skipped, and say so); the default always completes the
card. `capture` is a local read of the `executions/` dir, so it is evaluated
even under `--offline`; the rest of the sync tier is skipped with
*`--offline` skips the instance tier*.

### What the sync-tier rows actually report

- **`parity` — is a push pending?** Compares each tracked node's local build
  against the draft body. All matching is a `pass` ("local code matches the
  draft"). Otherwise it's a `warn` naming the count, with every node listed in
  `details` and `push` as the remediation — not a caveat, just the next step in
  the flow. A tracked file that has vanished from disk warns differently
  (*a local file is missing* — pull, or push to make the draft match local).
- **`drift` — did someone edit on the instance?** Remote code that moved off
  the last sync while your file didn't is a `warn` (*pull before publishing*).
  Both sides moved is a **`CONFLICT` fail**, with
  [`diff`](/docs/cli/diff/) as the remediation so you can see the lines before
  choosing. Nodes deleted remotely count here too.
- **`snapshot` — is `workflow.json` current?** Structure is mirrored, not
  guarded: when the remote structure changed, this warns *structure snapshot
  out of date — pull to refresh `workflow.json`* (and, if the file can't be
  parsed, *unreadable — pull to rewrite the snapshot*). It never fails the
  gate — a stale snapshot is a hint to refresh a mirror, not drift in your
  code.
- **`lifecycle` — where is this workflow in its life?** Always `info`, never a
  gate: *unpublished — draft only*, *published — live matches the draft*, or —
  when a published workflow's draft has moved ahead (pushes land on the draft,
  and so do UI edits) — *published — the live version is older than the draft
  (publish to go live)*, which is how you learn a
  [publish](/docs/cli/publish/) is pending.

## What the compliance guard catches

The `layout` check is the same guard [push](/docs/cli/push/) and
[watch](/docs/cli/watch/) run before writing — removing the old standalone
`check` verb removed a *view*, not a gate. Hard errors (`--force` does **not**
bypass them):

- inline code in `workflow.json` without a `//@file:` placeholder
- placeholders pointing at missing, `.remote.js`, or non-`.js`/`.ts` files,
  or at files outside `code/`
- an `@ts-n8n` marker inside a `.js` file
- an `import` in a `.js` node file — `.js` is pushed verbatim and n8n has no
  module loader; convert the node to `.ts`, where imports are bundled on push
- dangling connection sources/targets
- duplicate node names or ids
- orphan `.js`/`.ts` files nothing references
- dangling node references, in node source and in expression parameters — all
  four forms n8n itself rewrites on a rename: `` $('X') ``, `$node["X"]`,
  `$node.X`, `$items('X')`. Computed references (`$(someVar)`, a template
  literal carrying `${…}`) are left alone; a regex cannot resolve them, and
  n8n's own rewriter has the same limit
- a leftover legacy `fixtures/` dir containing `.json` files — the per-node
  fixtures mechanism and the old `--pin` flag are retired; recreate the data as
  a [scenario](/docs/cli/scenario/), then delete the dir

Warn without blocking: **local work not yet registered with the instance** — a
node whose `//@file:` placeholder has moved off what `.decanter.json` records
(the shape of a `.js`→`.ts` conversion), or whose recorded file is gone from
disk. `push` reconciles the map, so this is a pending sync, not a violation —
and it stays a warning deliberately, because `push` runs this guard *before* it
reconciles. Also: unresolved `.remote.js` leftovers; a Python Code node's
inline `pythonCode` (decanter extracts JS/TS only — Python extraction is
planned); and a committed scenario whose `workflowData` embeds inline Code-node
source (`jsCode` not starting with `//@file:`).

The one-line `layout` message names the first violation and the count; **every**
error and warning is listed underneath it in [`details`](#details--the-full-list-behind-a-line).

## Typecheck

n8n Code-node source is a *function body* (top-level `return`/`await`), which
plain `tsc` rejects. The `types` check wraps node files in an `async function`
in memory and maps diagnostics back to real line numbers — see
[Type checking](/docs/concepts/type-checking/) for how this works and why your
editor may still show a spurious TS1108.

`npm run typecheck` in a scaffolded sync dir is an alias for this. Every `tsc`
line lands in the finding's `details`. `--no-typecheck` skips the check (it
reports as a skip with the unlock, so the coverage line stays honest), and a
sync dir with no `tsconfig.json` skips it automatically.

> **Green means well-formed, not live.** `preflight --offline` never contacts
> the instance, so a `ready` verdict there says your files are valid — not that
> n8n is running them, and not that the draft matches. Drop `--offline` to add
> the instance reads (`parity`, `drift`, `lifecycle`), use
> [`diff`](/docs/cli/diff/) to see the pending lines, and
> [`push`](/docs/cli/push/) to make your edits real. Editing and then stopping
> at a green offline run leaves the workflow unchanged in n8n.

## The `--simulate` stage

`--simulate` replays the workflow through a **real n8n engine**, locally, using
a captured execution (or a committed [scenario](/docs/cli/scenario/)) as the
pinned input. Side-effect-free nodes (Set, IF, Switch, Merge, Code, …)
**execute for real** through the actual engine; every network/side-effectful
node is **pinned** to the output it produced in the capture. Credentials are
stripped and no outbound-capable node survives the transform, so the run is dry
— it writes nothing external. Then each real node's replayed output is
**diffed against the capture**: divergence is the check's `fail`.

It needs a **Docker** daemon (no daemon → the check skips with that reason) and
a pin source. It is the one thing an instance run can't give you: verification
of **uncommitted local code** ([`test`](/docs/cli/test/) can only run what's on
the draft), CI without an instance or credentials or the per-workflow MCP
opt-in, hard network isolation, and engine-version rehearsal.

### Where the pin source comes from (and which need an instance)

This is what decides whether `--offline --simulate` really is air-gapped:

| Pin source | Needs the instance? |
| --- | --- |
| A committed `scenarios/<slug>.json` | **No** — it is in git; that is why you commit it |
| A capture already under `executions/` | **No** — `scenario create <workflow>` seeds from the newest one, entirely locally |
| `scenario create <workflow> --scaffold` | **No** — the fill is built from your local `workflow.json`. With a host configured it also annotates each node with its output JSON Schema; without one it scaffolds anyway and says the annotations are missing |
| `executions <workflow>` (fetch a fresh capture) | **Yes** — this is the only route that must reach n8n |

So an air-gapped run works whenever you brought a pin with you **or** are willing
to author one: only fetching a *new* capture is impossible without the instance.

**How it works:** transform a copy of the workflow (materialize `//@file:`
sources, replace the trigger and every network node with a name-preserving node
that emits the captured items so `$('Node')` and expressions still resolve,
prepend a manual trigger, strip all `credentials`) → run it on a throwaway n8n
(`n8n import:workflow` + `n8n execute`) in a fresh container with no server, no
credentials and its own scratch database → diff each executed node against the
capture.

Only nodes on a curated, **default-deny** allowlist run for real; any node type
not on it — anything credentialed, HTTP, DB, messaging, or unknown — is pinned.
Safety never depends on recognizing a node type. Loop drivers
(`splitInBatches`) are the exception: side-effect-free but stateful across runs,
so they run for real to reproduce the loop.

### Pin sources

- `--execution <id>` — replay that captured execution
  ([executions](/docs/cli/executions/) fetches them into the gitignored
  `executions/` dir).
- `--scenario <slug>` — replay a committed
  [scenario](/docs/cli/scenario/) (`scenarios/<slug>.json`). Mutually exclusive
  with `--execution`.
- Neither — the **newest capture** in `executions/`, so `--simulate` just works
  after a fetch. No capture and nothing to pin from → the check skips, naming
  both ways to get one.

A **gap** — a network node reached in the replay with no captured or pinned
data, typically a node added since the capture — hard-errors rather than run
half-real. Fill it by promoting the capture to a
[scenario](/docs/cli/scenario/) and authoring the missing node's data (or
scaffolding its schema with `scenario create --scaffold`; the CLI never calls a
model).

**Synthetic pins are the exception to the diff.** A scenario containing any
`authored`/`scaffolded` node (see
[provenance](/docs/cli/scenario/#provenance-and-synthetic-pins)) passes as
"**synthetic pins — proves executability, not output correctness**": no
per-node diff is asserted. A capture-only run keeps the full diff semantics.
Nodes with **nondeterministic** output (`$now`, `Math.random()`, `new Date()`)
legitimately diverge — that's a real signal, not masked.

### Engine version

"Engine-true" means true to *your* instance, so the engine version is a
parameter. Set `n8nVersion` in `decanter.config.json` (or `--n8n-version` for
one run) to match your n8n:

```json
{ "n8nVersion": "2.31.4" }
```

Absent that, the stage uses the project's pinned version and hints you to set
one. `--n8n-version` affects **only** the `--simulate` engine — which is what
makes it an **upgrade rehearsal**: run your workflow on the next n8n before the
instance gets there. The consumed surface (`import:workflow`, `execute`, the
run-data JSON) is stable across the n8n 2.x line.

### `--viewer` — browse the run in a real n8n

`--viewer` (only valid together with `--simulate`; alone it's a hard error)
additionally starts a **browsable throwaway n8n** and prints, in the check's
`details`, a URL to the run plus the local login:

```txt
  ✓ simulate  6 node(s) ran on a local engine, all matched the capture
      open the run in n8n: http://127.0.0.1:53737/workflow/decantersim0000/executions/1
      local login: simulate@decanter.local / Decanter-Sim-0000 — throwaway instance, replaced on the next run
```

- The viewer is a **second, separate container** alongside the graded run. The
  graded run stays headless with **`--network-none` forced on**, so the
  [safety contract](#safety-contract) is unchanged by `--viewer`.
- It is bound to `127.0.0.1` only, holds no credentials, and is replaced on the
  next run. n8n requires a login, so it seeds a fixed local owner and prints
  it — log in once and the browser session sticks. Stop it any time with
  `docker rm -f decanter-sim-viewer`.
- Booting it takes 30–180 s; its progress is printed (a swallowed boot would
  read as a hang).
- It's also what the [picker](/docs/cli/overview/#interactive-picker)'s
  `preflight --simulate` row runs.

**`--viewer` is the only way to see a multi-batch loop.** A loop that ran more
than one batch can't be gated — first-run-only pinning can't feed iterations
2..N — so without `--viewer` the stage **fails** (*loop workflows are out of
scope (v1)*). With `--viewer` the loop is capped to its first batch, replayed,
and opened in the browser, and the check reports **`skip`**: *a preview, not a
pass/fail check*. It is never a pass, so `--require=simulate` rightly fails on
it and nothing can misread the exit code as verified. (A **single**-batch loop —
the driver ran twice, one batch pass plus the final "done" pass — replays
faithfully and is a real pass/fail check.)

### Not a replacement for `node run`

[node run](/docs/cli/node-run/) is the sub-second inner loop — one node,
in-process, zero install. `--simulate` is the slow outer check — the whole
graph, a real engine, needs a capture. (One inversion worth knowing: `run`
executes node code in the CLI process with full host privileges, while the
simulate engine runs it inside n8n's sandbox with the network cut — for
generated or untrusted node code, `--simulate` is the safer executor.)

## Executions are the ground truth

`preflight` brings your real run data into the gate:

- **Pins and diffs.** The runtime tier pins from and diffs against a capture
  (`--execution <id>`, default newest) or a committed
  [scenario](/docs/cli/scenario/) (`--scenario <slug>`).
- **Auto-fetch.** When `--simulate` runs *and* the instance tier is live (i.e.
  `--simulate` without `--offline`) and `N8N_API_KEY` is set, `preflight`
  fetches the newest capture if the local one is missing or stale, so the
  replay pins against *fresh* reality. It's a read (captures land in the
  gitignored `executions/` dir); `--no-fetch` disables it, and without a key
  it's skipped with guidance. Without `--simulate` nothing consumes a capture,
  so nothing is fetched; `--offline` never contacts the instance at all.
- **History as a health signal.** The `history` check reads recent production
  executions (over MCP `search_executions`, or the REST executions API when
  `N8N_API_KEY` is set) and reports the error rate — a live workflow that's been
  failing is a **warn**, never a fail (the draft isn't guilty of the past).

## Scoring & verdict

Each check reports `pass` / `warn` / `fail` / `skip` / `info`, a duration, a
message, optional `details`, and — for a warn or fail — the exact
**remediation** command.

- **Verdict** (deterministic): any `fail` → **`not ready`** (exit 1); else any
  `warn` → **`caution`** (exit 0); else **`ready`** (exit 0). `--fail-on=warn`
  promotes a caution to exit 1. Exit codes stay 0/1.
- **Score 0–100** (the trend line; the verdict is the gate): starts at 100, each
  `fail` costs 40 (a `CONFLICT` `drift` costs 30), each `warn` costs 10, floored
  at 0. The weights are starting values, tuned freely; the verdict rules are the
  stable contract.
- **Coverage is first-class honesty.** The card always says which checks ran vs
  skipped and why — a 100 with no runtime run reads as `ready` with the coverage
  gap named, never a bare green. **`--require=<ids>`** (a comma list of check
  ids, e.g. `--require=simulate`) turns a *skip* of that check into a **fail** —
  the CI teeth for "must have runtime coverage". `--require=test` is rejected
  with a pointer to the flow: the instance run is no longer a preflight stage.

### `details` — the full list behind a line

A check line is a summary; `details` is the expansion, printed indented and dim
beneath it (and carried in `--json`). It holds **every** layout violation and
warning, **every** `tsc` diagnostic, the drifted/conflicted node list, the
diverged nodes' expected-vs-actual, and the viewer's URL + login. Since
`preflight` is now the only place these are printed, nothing is lost by there
being no separate static-check verb.

`layout` and `types` findings deliberately carry **no `remediation`**: that
field is contracted to hold a runnable command, and the fix here is editing the
files named in `details`.

## The report — for humans and agents

The human card streams a line per check (with its details indented under it),
then the score/verdict/coverage and the remediation for anything that warned,
failed, or was skipped:

```txt
preflight: order-sync · static + instance reads
  ✓ layout    layout compliant
  ✓ types     node files typecheck clean
  ✓ connect   MCP reachable, auth valid
  ! parity    local code differs from the draft in 1 node(s) — push to make it the draft, then test
      Compute Totals: local changes in code/compute-totals.ts
  ✓ drift     no remote code drift
score 90/100 · verdict: caution · 10/11 checks ran
  ! parity: local code differs from the draft … → n8n-decanter push order-sync
  ⤷ skipped simulate: the local-engine replay is opt-in — pass --simulate to run it (needs Docker)
```

The header's suffix is the resolved depth: `static + instance reads`,
`--offline`, `--simulate`, or `--offline --simulate`.

`--json` emits **one document** (an array when several workflows are targeted):
`workflow`, `id`, `flags` (`{simulate, offline}`), `subject`
(`draftVersionId`, `publishedVersionId`, `parity`), `checks[]` (`id`, `tier`,
`status`, `message`, `details?`, `remediation`, `durationMs`), `score`,
`verdict`, and `coverage` (`ran`, `skipped[] {id, reason, unlock}`).

> **Agent contract change.** `report.profile` (a string) is **gone**, replaced
> by `report.flags` — an object with the two booleans. Findings may now carry
> `details: string[]`. The stable check ids + remediation strings are otherwise
> unchanged: teach an agent `preflight --json` as its gate before `push` (the
> gate before `publish` is [`test`](/docs/cli/test/), run after the push).

## Safety contract

**`preflight` never mutates and never executes on your instance:** no push, no
publish, no restore, no draft write — and no `test_workflow` run. Its only
instance interactions are **reads**.

- Every stage that produces a verdict grades your **local code**. The instance
  is read for sync facts (`parity`, `drift`, `snapshot`, `lifecycle`,
  `history`) and nothing else. One report, one artifact.
- The `parity` warn is not a caveat about coverage — it's the next step in the
  flow: `push`, then `test`.
- The graded `--simulate` run is always headless in a throwaway container with
  **`--network-none` forced on** and credentials stripped. `--viewer` does not
  relax that; it adds a *separate* container to look at.
- The sync tier and auto-fetch are reads only; captures land in the
  self-gitignored `executions/` dir. Auto-fetch only runs when `--simulate` is
  on and the instance tier is live; nothing else consumes a capture.

## Preflights — which one when?

`preflight` is the umbrella; the flags pick the depth. [`test`](/docs/cli/test/)
is **not** under this umbrella — it is a separate, later step:

| | Where it runs | Reach for it when |
| --- | --- | --- |
| `preflight --offline` | locally, static | every edit, an edit hook, an air-gapped lint — layout + types |
| **`preflight`** | + instance reads | **before `push`** — one command, one verdict |
| `preflight --simulate` | + a local engine (Docker) | runtime evidence about **local** code before pushing |
| [diff](/docs/cli/diff/) | locally + one instance read | you want the changed **lines**, not a verdict (never gates) |
| [test](/docs/cli/test/) | your instance | **after `push`** — a real run of what you just pushed |

Requirements match the checks it runs: the static tier needs nothing; the sync
tier needs the [MCP connection](/docs/cli/init/) and the workflow's *Available in
MCP* flag; `--simulate` needs Docker; auto-fetch and the REST `history` fallback
need `N8N_API_KEY`. Anything unavailable is **skipped with an unlock**, never a
hard error — a workflow with zero captures still gets a static+sync verdict,
labeled as such.
