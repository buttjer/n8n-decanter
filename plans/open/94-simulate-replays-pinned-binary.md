# Plan 94 — replay pinned binary in `preflight --simulate`

**Status:** Not started
**Priority:** P1 — offline, small, and measured: the stand-in fix is one
expression, and without it no workflow that reads a file can be replayed past
its trigger.
**Source:** GitHub issue [#328](https://github.com/buttjer/n8n-decanter/issues/328)
(n8n-decanter 0.11.1, n8n 2.42.5, `binaryMode: separate`, binary data in the
database). Related: #327 (`test --scenario` cannot read the result back).
Extends the stand-in design of [Plan 66](../done/66-multi-output-pins.md).
**Snapshot:** 2026-10-21T14:20Z @ c788309
**Model:** Sonnet — the construction is settled by the spike below; what is
left is a helper, a warning and tests.

The Code stand-in that replaces a pinned node returns only `json` and
`pairedItem`, so every file a trigger or network node delivered is gone before
the first real node runs, and `scenario check` passes a scenario whose binaries
no other instance can read. Keep `binary` in the stand-in as-is (measured to
work in every binary mode), and warn when a pinned binary is only a reference.

## Why

A mail-with-attachment workflow fails `--simulate` at its "no attachment" check
on every run, so the replay proves nothing about the code after it. Inlining
the bytes by hand (the reporter's workaround) does not help either, because the
stand-in drops `binary` whatever it holds. The check that should have flagged
the reference says "valid".

## Findings, as verified

1. **Cause, confirmed.** `emitCode` (`lib/simulate.mts:403`) maps each item to
   `{ json, pairedItem? }`. It is called for the main stand-in (`:580`) and for
   every Plan 66 extra-output stand-in (`:591`), so both lose `binary`.
2. **`test` is unaffected.** `buildTestPins` (`lib/testrun.mts:96`) hands whole
   items to `pinData`, so on the source instance a `database:` reference
   resolves.
3. **Spike, 2026-10-21, at the CLI surface.** Throwaway sync dir, hand-built
   (`workflow.json`, `.decanter.json`, `code/*.js`, `scenarios/attach.json`), run
   with `n8n-decanter preflight bin-wf --offline --simulate --scenario attach`
   from this worktree. `emitCode` was patched temporarily behind an env switch
   and reverted afterwards. The workflow: a pinned `emailReadImap` trigger
   carrying `binary.attachment_0` (17 bytes of text, inline base64, no `id`),
   then a Code node `Check` that reports what its input holds and passes it on,
   then a Code node `Read` that calls `this.helpers.getBinaryDataBuffer(0, key)`,
   the same helper Extract from File uses. The scenario holds the expected
   `Check`/`Read` output, so the per-node diff is the probe. Engines tested:
   `n8nio/n8n:2.30.7` (the default) and `2.42.5` (the reporter's), with the same
   result on both.

   | Stand-in emits | `binaryMode` | Result |
   |---|---|---|
   | `{json}` (today) | separate | **reproduces #328**: `Check` sees no binary, `Read` cannot get it |
   | `{json, binary}` as captured | separate, and unset | **pass**: both nodes match, bytes read back exactly |
   | rebuilt via `this.helpers.prepareBinaryData` | separate | bytes read back too, but the item now carries a new `filesystem-v2:` id |
   | `{json, binary}` as captured | combined | bytes read back; the engine moves the binary into `json._files` itself |
   | binary already in `json._files`, inline | combined | bytes read back (`emitCode` already keeps this, since it is `json`) |
   | `{json, binary}` with a `database:` id | separate | `Check` sees the binary; `Read` fails: `Could not find any entity of type "BinaryDataFile"` |
   | `{json, binary}` with a `filesystem-v2:` id | separate | `Read` fails with no message at all (`e.message` undefined) |

   **So no rebuild is needed.** n8n accepts inline items straight from a Code
   node's return in both modes, and `prepareBinaryData` only adds work and a
   changed id.
4. **Why the reference loses.** `BinaryDataService.getAsBuffer` (n8n-core,
   read in 2.42.5) reads by `id` whenever there is one and only falls back to
   `data` without one. So "inline the bytes" means both: put base64 in `data`,
   **and delete `id`**. A capture almost always carries references:
   `BinaryDataConfig` (2.42.5) defaults to `filesystem`, or `database` in queue
   mode, and `s3`/`azure` store by id too. Only the legacy in-memory `default`
   mode, which `N8N_DEFAULT_BINARY_DATA_MODE` still accepts, keeps the bytes
   inline with no `id`. Such a capture already replays, which is why the
   warning keys on `id` and not on the mode.
5. **A reference still helps a presence check.** With a `database:` id, `Check`
   saw `binary.attachment_0` and its metadata. Only reading the bytes failed. A
   pure node that only tests whether a file is there replays fine. Extract from
   File is not on `PURE_NODE_TYPES`, so it is pinned and replays its captured
   output either way.

## Tasks

1. **(a) `emitCode` keeps `binary`.** Carry `it.binary` through unchanged
   whenever an item has one, inline or reference. Do not strip references:
   finding 5 says presence checks need them. Both call sites pick it up for
   free. No `prepareBinaryData` (finding 3).
2. **(b) Warn about reference-only binaries.** Add one helper that walks the
   items of every node the replay **pins** (non-pure, non-loop-driver: the
   nodes `emitCode` serves). Pure nodes run for real, so their captured
   binaries never reach the engine. For each entry under `binary.<key>`, and
   under `json._files.<key>` for `binaryMode: combined` (finding 3), flag it
   when it has an `id`. The warning names the node and key and says the bytes
   are readable only on the source instance. It also gives the fix: base64 in
   `data`, then remove `id`. Call it from `checkScenarios`
   (`lib/simulate.mts:1032`, beside `reportReplayTruncation`) and from
   `writeScenario` (`:761`) after the scenario is written. Make it a **warning,
   not an error**: per finding 5 a scenario with references is still useful.
3. **(b2, optional) A readable engine failure.** When a `--simulate` run fails
   and the scenario holds references flagged by task 2, append the same hint to
   the `simulate` check's remediation. On its own, the `filesystem-v2:` failure
   has no message at all.
4. **(c) Tests.**
   - Unit (`test/unit/simulate.test.mts`): a pinned item with `binary` keeps it
     in the stand-in's `jsCode`, both on output 0 and on a Plan 66 extra-output
     stand-in. An item without `binary` emits no `binary` key. A reference is
     flagged and inline bytes are not. `json._files` is flagged in a combined
     workflow.
   - CLI e2e: `scenario check` on a scenario with a `database:` reference
     prints the warning and still exits 0.
   - Engine (`test/sim.mts`, opt-in): one step that pins an inline attachment
     and has a Code node read it back with `getBinaryDataBuffer`. This is the
     spike above, made permanent.
5. **(d) Docs and changelog.**
   - `docs/cli/scenario.md`: a short section on binaries (captures hold
     references, how to inline, the `id` trap).
   - `docs/cli/preflight.md`: one line saying `--simulate` replays pinned
     binaries.
   - `CHANGELOG.md`, **Fixed**: "`preflight --simulate` replays pinned items'
     binary data", plus an **Added** entry for the warning.
   - `PLAN.md`: one bullet in the stand-in section (beside Plan 66's
     multi-output bullet), covering that stand-ins keep `binary` and why
     references are kept.

## Acceptance / verification

- The spike's case passes at the CLI surface: inline attachment, a Code node
  reads the exact bytes, the diff matches, exit 0, on the default engine.
- `scenario check` and `scenario create` warn on a `database:` or
  `filesystem-v2:` reference, naming node and key, and exit codes are
  unchanged.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run check:docs` green;
  `npm run test:sim` green with Docker.

## Notes

- **Size.** Inline base64 is serialized into the stand-in's `jsCode`, so a
  10 MB attachment becomes a ~13 MB Code node in the sim workflow file. Nothing
  measured breaks at the sizes tested. If a real report hits a limit, fix it
  then (for example with a side file read by the stand-in), not speculatively.
- **The diff stays json-only.** `diffItems` ignores `binary`, so a replayed
  binary's new id or metadata never counts as divergence. That is intended.
- Not `Class: Distinctive feature`: this is a fidelity fix to an existing one.
