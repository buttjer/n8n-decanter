# Plan 76 — the air-gapped promise is mostly true; make it say when, and close the one real gap

**Status:** Draft
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
