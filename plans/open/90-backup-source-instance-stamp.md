# Plan 90 — stamp the source instance on a backup, so restore can stop warning about a move that did not happen

**Status:** Not started
**Priority:** P3 — pure noise reduction, and the fix cannot be retrofitted to
backups already on disk. Worth doing, not worth doing first.
**Source:** user field feedback 2026-09-02, report 1 ("Der Restore-Hinweis
'credential refs point at the SOURCE instance' kommt auch, wenn Quelle und Ziel
dieselbe Instanz sind. Ein Vergleich der Instanz-Id würde die Warnung dort
sparen"). Verified the same day — correct diagnosis, larger fix than it looks.
Same batch as [Plan 86](../done/86-init-writes-when-asked-for-help.md),
[Plan 87](87-auth-errors-point-the-wrong-way.md),
[Plan 88](88-data-tables-stale-rows-and-refs.md),
[Plan 89](89-rest-verbs-prerequisite-chain.md) and
[Plan 91](../draft/91-guard-hint-for-credential-type-refusal.md).
**Snapshot:** 2026-09-02T04:57Z @ 3c5ee4d
**Model:** Sonnet — the code is small; the call about the backup file format is
the work.

`backup restore` tells the user that credential refs point at the *source*
instance and must be rebound. When source and target are the same instance —
the ordinary case, restoring a workflow you backed up an hour ago — that is
false, and it is printed on the one screen where a user is deciding whether
their restored workflow is safe to publish. Suppressing it needs a source-host
field the backup file does not currently have.

## Why

A warning that fires when it does not apply trains people to skip it, and this
particular warning is one you want read on the day it *is* true (a real
cross-instance move, where credentials genuinely will not resolve). Noise here
costs more than noise elsewhere.

The reason this is P3 rather than a quick fix is the retrofit gap: backups
already on disk carry no instance identity, so they must keep warning forever.
The improvement only reaches backups created after the change — which is fine,
but means the payoff arrives slowly and does not justify jumping the queue.

## Findings, as verified

1. **The warning is unconditional on credentials being present.**
   `lib/backup.mts:202-205`: if `credentialHints(nodes)` is non-empty, print
   `credential refs point at the SOURCE instance — recreate/rebind them on the
   target:` plus one line per hint. Nothing compares instances, anywhere.
2. **The backup file cannot support the comparison today.** `backupCreate`
   (`lib/backup.mts:93-144`) writes `structuredClone(wf)` with only
   `STRIP_FIELDS = ["pinData", "staticData"]` removed (`lib/backup.mts:30`,
   `:115`). It is n8n's workflow export and nothing else — no host, no instance
   id, no decanter metadata of any kind.
3. **The obvious cheap proxy is not reliable.** `config.host` at restore time is
   known (`n8n-decanter.mts:1005` passes it), but comparing it to a host
   recorded at create time compares *URLs*, not instances — `localhost:5678`,
   `127.0.0.1:5678` and a tailnet name can all be the same n8n. A URL match is a
   safe **suppress**; a URL mismatch is not a safe **warn-louder**.
4. Everything else on the restore path is good and should not be disturbed:
   the workflow lands unpublished, the editor URL is printed, and the closing
   line already says "review, rebind credentials, then publish to go live"
   (`lib/backup.mts:206-211`).

## Tasks

1. **Decide where the stamp lives.** The backup file is currently a clean n8n
   workflow export, which is a property worth keeping — it means a backup can be
   fed to any n8n tooling. Two options:
   - a **sidecar** (`<timestamp>.<versionId>.meta.json`) next to the backup, so
     the export stays pristine;
   - a **namespaced key** inside the JSON (e.g. `_decanter: { … }`), simpler to
     keep paired but changes what the file is.
   Preference: **sidecar**, on the "keep the export pristine" argument. Whoever
   executes this should confirm `listBackups`/`matchesBackupRef`
   (`lib/backup.mts:46`, `:229`) tolerate the extra file — they glob the backups
   directory, so this needs checking, not assuming.
2. **Record enough to identify the instance.** At minimum the host URL. Better
   if an instance identifier is available cheaply from a call the code already
   makes — worth a look at what `/rest/settings` or the public API exposes, but
   **do not add an internal `/rest/*` dependency for this** (root `AGENTS.md`:
   those endpoints are undocumented and version-fragile). Host URL alone is
   enough for task 3.
3. **Suppress on a confident match only.** In `backupRestore`
   (`lib/backup.mts:202`), skip the SOURCE-instance warning when the stamp
   exists and normalises to the same host as `config.host`. Normalise before
   comparing (trailing slash, scheme, default port). On **no stamp** — every
   backup created before this change — keep the current behaviour exactly.
   Never invert this into a louder warning on mismatch; per finding 3 the signal
   is not strong enough to carry that.
4. **Keep the rebind hints themselves.** Even same-instance, the list of which
   nodes carry credential refs is useful review material. What goes away is the
   *claim that they point somewhere else* — consider re-framing the same list as
   "nodes with credentials:" in the same-instance case rather than dropping it.

## Acceptance / verification

- Backup created and restored against the same mock host: no SOURCE-instance
  warning; the node list (task 4) still appears.
- Same backup restored against a different host: the warning appears unchanged.
- A backup file **without** a stamp (hand-crafted in the test, standing in for
  everything already on disk): the warning appears, as today.
- `backup list` and `backup restore <ref>` still find and match backups with the
  sidecar present — this is the regression task 1 flagged.
- Real CLI as a subprocess against the mock.

## Notes

- **CHANGELOG:** `Changed` — "`backup restore` no longer claims credential refs
  point at another instance when restoring to the instance the backup came
  from"; note explicitly that this applies to backups **created after** the
  change.
- **Docs:** the `backup` page describes what a backup file is; a sidecar changes
  that description.
- **PLAN.md:** the `backups/` layout is part of the data model.
- **Secrets:** the stamp records a host URL, never a credential. Backups already
  carry credential refs and any secrets embedded in node params — that is why
  `backupCreate` warns they are not auto-committed (`lib/backup.mts:141`). Do
  not let a sidecar quietly become a second place secrets can land.
