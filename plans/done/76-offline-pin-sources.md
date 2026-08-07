# Plan 76 — the air-gapped promise is mostly true; make it say when, and close the one real gap

**Status:** Done — shipped 2026-08-07 (see "What shipped")
**Priority:** P2
**Source:** [Plan 61](../done/61-field-test-scenario-wave-2.md)'s S9 round
(`ftrun-46601`, 2026-08-06). The blind agent concluded it could not manufacture a
pin offline; maintainer pushed back — *"gleichzeitig kann der Pin ja schon
offline existieren. Ggf auch erstellt werden."* Correct on both counts.
**Snapshot:** 2026-08-06T15:10Z @ 761cf4e
**Model:** Sonnet for the messaging + docs; the offline-scaffold change is small
but touches `writeScenario`'s contract, so read that function first.

`preflight --offline --simulate` is documented as **"air-gapped runtime
evidence"**. S9's round read like the promise was hollow. It isn't — the promise
is **conditional**, and one of its three preconditions is refused for no good
reason.

## What is actually true (verified in the code, 2026-08-06)

| You have | Offline `--simulate`? |
| --- | --- |
| A committed `scenarios/<slug>.json` | **Yes, fully.** It is in git; that is the point of committing it. |
| A cached capture in `workflows/<slug>/executions/<id>.json` | **Yes.** `scenario create` **without** `--scaffold` is an explicitly offline verb ([`n8n-decanter.mts:494`](../../n8n-decanter.mts)); it seeds from `latestCaptureId(dir)`, which reads that folder. |
| Neither | **No today** — and this is the part worth changing. |

So the honest statement is *"air-gapped runtime evidence, if you brought a pin
with you"* — and a repo that has been used online at all normally has.

## The one real gap: `--scaffold` needs the instance for something optional

`writeScenario`'s pure-scaffold branch builds every gap from
**`pinnableNodes(wf)`** — the local `workflow.json`. The instance contributes
only the per-node **JSON Schemas** (`prepare_test_pin_data`), and those are
applied optionally: `...(schema !== undefined ? { expectedSchema: schema } : {})`.

The machinery for a fully-offline fillable scenario is therefore **already
there**. What stops it is one hard refusal:

```
scenario create with no --execution needs --scaffold — or fetch a capture first
```

plus the dispatcher treating `--scaffold` as instance-requiring. A scaffold
without schemas is a *less annotated* scenario, not an invalid one — the author
fills the values either way.

## Direction (not yet a task list)

1. **Let a scaffold work offline, unannotated.** Either `--scaffold` degrades
   when no host is configured (log that schemas were skipped and why), or an
   explicit `--offline` on `scenario create` selects that path. Prefer whichever
   keeps one obvious command; do **not** silently produce a schema-less file that
   looks the same — the file records provenance already (`scaffolded` vs
   `authored` in `Provenance`), so make the difference visible there and in
   `scenario check`.
2. **Sort the error message by what the reader can actually do.** Today's three
   routes (`--execution <id>`, `--scaffold`, `executions <ref>`) mix offline and
   online with no marking. Offline-viable first, instance-only marked as such.
3. **Condition the docs promise.** `docs/cli/preflight.md`'s table row *"air-
   gapped runtime evidence"* should name the precondition in the row itself, and
   the `--simulate` prose should say plainly that a pin source is either
   committed, cached, or scaffolded — and which of those need a live instance.
4. **Say it where it bites.** The `--simulate` skip reason ("no pin source") is
   what an agent on a train reads; that message deserves the same treatment
   as [Plan 75](../done/75-init-cold-start-discoverability.md)'s cold-start error.

## What shipped

All four directions, in the order they matter to someone with no connectivity:

1. **`--scaffold` works offline, unannotated.** `scenario create` is now offline
   in *all* its forms (the dispatcher no longer excludes `--scaffold`). With no
   `N8N_HOST` it warns that the `expectedSchema` annotations are missing and
   scaffolds from `workflow.json` alone; with a host it fetches schemas exactly
   as before. `writeScenario` gained `scaffoldRequested` so the old guard still
   refuses a bare call that asked for neither a capture nor a scaffold.
2. **The difference stays visible, not hidden.** `_decanterScenario.source` is
   `scaffold` either way, but with no schemas every node's provenance is
   `authored` rather than `scaffolded`, and the write line says
   `written from this workflow's own nodes (no schemas — offline)` instead of
   claiming schemas it never had.
3. **Messages lead with what works here.** The "no execution to seed the
   scenario" error is split into *Without an instance* / *With an instance*, and
   the `--simulate` skip's unlock is now
   `scenario create <wf> --scaffold  (no instance needed)` — the line an agent on
   a train actually reads.
4. **Docs state the condition instead of dropping the promise.**
   `docs/cli/preflight.md` gains a four-row table of pin sources marking which
   need the instance (only *fetching a fresh capture* does), and the mode table's
   "air-gapped runtime evidence" row points at it.

Unit-pinned in `test/unit/simulate.test.mts`: a schema-less scaffold still turns
every pinnable node into a fill entry, carries no `expectedSchema`, and the bare
no-flags call is still refused.

## Verified (round `ftrun-55234`, 2026-08-07)

**The full chain ran, twice — with no instance at all.** For both seeded
workflows the agent went `preflight --offline --simulate` (skips: no pin) →
`scenario create --scaffold` (succeeds, unannotated) → `scenario check` (valid,
complete) → and then a **real local-engine replay**:

```
✓ simulate  local engine ran clean — synthetic pins: proves executability,
            not output correctness (no per-node diff) (5.9s)
score 100/100 · verdict: ready · 3/11 checks ran
```

Baseline for the same scenario before this plan: *"that door is genuinely shut,
not just skipped by choice."*

**A second finding fell out the moment the door opened.** The slug-less default
was `"scenario"` — a **verb name** — and the value-flag lookahead refuses to
consume a token that is a known verb. So `preflight --simulate --scenario
scenario` died with `--scenario needs a value`, i.e. the default file could not
be referenced in the space-separated form. The agent recovered with `=`; the
default is now `scaffold`, which is not a verb and reads better anyway. Pinned in
the e2e step.

## The first cut was wrong, and only the round showed it

**The verification round caught the first cut handling the wrong case.** It keyed
on `N8N_HOST === ""` — but an air-gapped user has a perfectly good `.env` and no
network, which is the *common* shape and the one S9 stages. So
`scenario create --scaffold` still died on `✗ fetch failed`, and the round's
agent never got a scaffold. Now a failed schema fetch degrades with the reason
named, and an e2e step drives it against a dead port. This is exactly why the
plan's verification is a round and not a test: the unit tests all passed over
the hole.

## Non-goals

- Not changing what `--simulate` *is* — the engine replay, the pinning, the diff
  against the capture all stay as they are.
- Not inventing pin **values** offline. A scaffold produces gaps to fill; guessing
  plausible data would defeat the purpose of pinning.
- Not caching schemas for later offline use. Tempting, but a stale schema is
  worse than an absent one, and provenance would get murky.

## Verification

Re-run S9 (`FIELD_SEED_PACK=wave2 node test/field-test/run.mts --isolate S9`) —
its stage now genuinely severs the instance (`go-offline`). The measurement is
whether the agent reaches a scaffolded scenario and gets a real `--simulate` run,
instead of reporting the door shut. Its previous words are the baseline:

> "that door is genuinely shut, not just skipped by choice"
