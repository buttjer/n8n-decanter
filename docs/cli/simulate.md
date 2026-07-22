---
title: simulate
description: Replay a whole workflow through a real n8n engine offline — pure nodes run for real, network nodes pinned from a capture.
order: 15
---

```sh
n8n-decanter simulate <workflow> --execution <id> [--network-none] [--json]
n8n-decanter simulate <workflow> --mock <slug>       # replay a committed mock scenario
n8n-decanter simulate <workflow> --pin <id>          # save a capture as committed fixtures
```

Replays a workflow through a **real n8n engine** using a captured execution as
the mock — the confidence layer that [node run](/docs/cli/node-run/) (single node) and
[status](/docs/cli/status/) (sync only) don't cover. Side-effect-free nodes
(Set, IF, Switch, Merge, Code, …) **execute for real** through the actual
engine; every network/side-effectful node is **pinned** to the output it
produced in the capture. Credentials are stripped and no outbound-capable node
survives the transform, so the run is dry — it writes nothing external.

Then it **diffs each real node's replayed output against the capture** and
exits non-zero on any divergence — an engine-true regression check for your
edited Code nodes.

Needs a captured execution ([executions](/docs/cli/executions/)) and a running
**Docker** daemon (the engine backend).

**Reach for [test](/docs/cli/test/) first** — the instance-side sibling: same
pin-and-diff idea, but on your instance's exact engine (community nodes
included) with no Docker. `simulate` is the differentiated offline half, and
stays the right tool when you need what an instance run can't give you:
**pre-push verification of uncommitted local code** (`test` can only run
what's on the draft), **CI without an instance** or credentials or the
per-workflow MCP opt-in, **`--network-none` isolation**, and
**engine-version rehearsal** (`--n8n-version` — try the upgrade before the
instance does).

Without `--execution`, `simulate` uses the **newest capture** in the workflow's
`executions/` dir — so `n8n-decanter simulate <workflow>` just works after an
`executions` fetch, and the [interactive picker](/docs/cli/overview/) can offer
`simulate` in its verb menu (it runs against the latest capture).

## How it works

1. **Transform** a copy of the workflow: materialize `//@file:` Code sources,
   replace the trigger and every network node with a name-preserving node that
   emits the captured items (so `$('Node')` and expressions still resolve),
   prepend a manual-trigger entry point, and strip all `credentials`.
2. **Run** it on a throwaway n8n (`n8n import:workflow` + `n8n execute`) in a
   fresh container — no server, no credentials, its own scratch database.
3. **Diff** each executed node's output against the capture and report.

Only nodes on a curated, **default-deny** allowlist run for real; any node type
not on it — anything credentialed, HTTP, DB, messaging, or unknown — is pinned.
Safety never depends on recognizing a node type. Loop drivers
(`splitInBatches`) are a special case: side-effect-free but stateful across
runs, so they run for real (never pinned) to reproduce the loop — see
[Scope](#scope).

## Options

| Flag | Meaning |
| --- | --- |
| `--execution <id>` | The captured execution to replay (optional — defaults to the newest capture in `executions/`) |
| `--mock <slug>` | Replay a committed [mock scenario](/docs/cli/mock/) `mocks/<slug>.json` instead of a raw capture (mutually exclusive with `--execution`) |
| `--pin <id>` | Instead of running, copy the capture's network-node outputs into committed `fixtures/` (offline) |
| `--network-none` | Run the engine container with `--network none` — an enforced outbound cutoff on top of the structural guarantee |
| `--json` | Emit the full report as JSON (for tooling) instead of the human summary |
| `--n8n-version <tag>` | Override the engine version for this run (see below) |

## Exit code

`0` when the engine ran clean **and** every checked node matched the capture;
`1` on any divergence or engine error. That makes `simulate` a CI-gateable
regression check.

Nodes with **nondeterministic** output (`$now`, `Math.random()`, `new Date()`)
legitimately diverge — that's a real signal, not masked.

## Engine version

"Engine-true" means true to *your* instance, so the engine version is a
parameter. Set `n8nVersion` in `decanter.config.json` (or `--n8n-version` for
one run) to match your n8n:

```json
{ "n8nVersion": "2.31.4" }
```

Absent that, `simulate` defaults to the project's pinned version and hints you
to set one. The consumed surface (`import:workflow`, `execute`, the run-data
JSON) is stable across the n8n 2.x line.

## Open the run in the n8n webapp

Run `simulate` in an **interactive terminal** and it prints a URL to the run in
a **kept-alive local n8n**, so you can inspect it node-by-node in the real
execution view:

```txt
open the run in n8n:  http://127.0.0.1:53737/workflow/decantersim0000/executions/1
  local login: simulate@decanter.local / Decanter-Sim-0000  ·  throwaway instance, replaced on the next simulate
```

- The viewer is a **throwaway** local n8n (bound to `127.0.0.1` only, no
  credentials, replaced on the next `simulate`). n8n requires a login, so it
  seeds a fixed local owner and prints it — log in once and the browser session
  sticks. Stop it any time with `docker rm -f decanter-sim-viewer`.
- **No flag, no extra step.** It only appears in an interactive terminal —
  piped runs, `--json`, and `--network-none` stay headless and print no URL, so
  scripts and CI are unaffected (and leave no container behind).
- The diff/exit-code is unchanged; the viewer is purely for eyeballing the run.

## `simulate --pin`

Captures under `executions/` are gitignored temp data. `--pin <id>` copies each
network node's captured output into `workflows/<folder>/fixtures/<node>.json`,
provenance-stamped (source, execution id, workflow version, date) so replays
become **reproducible and committable**. Fixtures take precedence over captures
on the next run.

**Review before committing** — execution data can contain credentials and PII,
which is why `executions/` is gitignored in the first place. `simulate` prints
that warning on every pin.

## Not a replacement for `run`

[node run](/docs/cli/node-run/) is the sub-second inner loop — one node, in-process, zero
install. `simulate` is the slow outer check — the whole graph, a real engine,
needs a capture. Two verbs, two layers. (One inversion worth knowing: `run`
executes node code in the CLI process with full host privileges, while
`simulate` runs it inside n8n's sandbox with the network cut — for
generated/untrusted node code, `simulate` is the safer executor.)

## Filling gaps

A **gap** is a network node reached in the replay with **no captured or pinned
data** — a node added or reparametrized since the capture. `simulate` hard-errors
on a gap rather than run half-real. To fill it, promote the capture to a
committed, editable [execution mock](/docs/cli/mock/) scenario and add the node's
data by hand (or with your IDE agent — the CLI never calls a model):

```sh
n8n-decanter <workflow> mock create "<slug>" --execution <id>   # writes mocks/<slug>.json, flags the gaps
# fill the flagged nodes' runData, then validate offline:
n8n-decanter <workflow> mock check <slug>
n8n-decanter <workflow> simulate --mock <slug>                  # replay the scenario
```

## Scope

- **Single-iteration loops replay and are gated.** A loop that ran a single
  batch — the `splitInBatches` ("Loop Over Items") driver ran twice (one batch
  pass + the final "done" pass) while every other node ran exactly once —
  replays faithfully: the driver **executes for real** and each node's one
  captured run pins exactly. This is a real pass/fail check.
- **Multi-batch loops get a viewer-only preview (not a check).** A loop that ran
  **more than one batch** can't be gated — first-run-only pinning can't feed
  iterations 2..N. In an **interactive terminal**, `simulate` caps the loop to
  its first batch, replays that single iteration, and opens it in the
  [browsable viewer](#open-the-run-in-the-n8n-webapp), clearly labeled
  *"iteration 1 of N — not a pass/fail check"*. Headless / `--json` /
  `--network-none` runs (scripts, CI) still hard-error, so nothing can misread
  the exit code as verified.
- The trigger is always a pinned replay of the captured trigger output — no
  live webhook/schedule semantics.
