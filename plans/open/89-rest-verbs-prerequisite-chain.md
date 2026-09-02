# Plan 89 — the REST verbs need a pulled workflow, and never say so until the raw HTTP shows through

**Status:** Not started
**Priority:** P2 — no correctness bug, but the failure lands as an unmapped HTTP
status and the prerequisite behind it is nowhere in the text.
**Source:** user field feedback 2026-09-02, report 1 ("`executions <id>` braucht
den Workflow in der Pull-Liste; für einen frisch angelegten Workflow kommt ein
nacktes REST-404. `backup create` genauso"). Verified the same day — **the
`backup create` half did not reproduce as described**, see "Findings". Same batch
as [Plan 86](86-init-writes-when-asked-for-help.md),
[Plan 87](87-auth-errors-point-the-wrong-way.md),
[Plan 88](88-data-tables-stale-rows-and-refs.md),
[Plan 90](90-backup-source-instance-stamp.md) and
[Plan 91](../draft/91-guard-hint-for-credential-type-refusal.md).
**Snapshot:** 2026-09-02T04:57Z @ 3c5ee4d
**Model:** Sonnet — the work is judgement about wording and where a check
belongs, across three files.

The REST-backed verbs (`executions`, `data-tables`, `backup`) can only address a
workflow that is already pulled into the local mirror. That is a reasonable
design, but a workflow you just created on the instance is not pulled, and
nothing in the failure says so — `executions <id>` surfaces a bare
`GET /api/v1/executions/<id> failed: 404 Not Found` with n8n's body appended.

## Why

The verbs each have a decent message for *their* precondition. What is missing is
the chain: **create on the instance → opt in via `availableInMCP` → `pull` →
now the REST verbs work.** A user who just built a workflow in the n8n UI is
exactly the user most likely to reach for `executions` first, and is the one
person the current errors help least.

Worth separating two things the report merged, because they need different
fixes: an *unmapped HTTP status* (a 404 nobody translated) and a *missing
prerequisite* (the mirror requirement). The first is a gap in `lib/api.mts`; the
second is a gap in the verbs' guidance.

## Findings, as verified

1. **`lib/api.mts` maps 403 and nothing else.** `lib/api.mts:158-161`:
   ```ts
   if (res.status === 403) { … scopeHint(method, pathname) … }
   throw new Error(`${method} ${pathname} failed: ${res.status} ${res.statusText}\n${text.slice(0, 2000)}`);
   ```
   So 401 and 404 fall through to the raw form. The 403 branch is the model to
   copy — it is specific, it names the cause, and it tells the user what to do.
2. **`fetchExecutionById` has the right message but cannot reach it.**
   `lib/executions.mts:151-152` does say
   `execution <id> belongs to workflow <wfid>, which is not pulled under <root>
   — pull it first`. But it runs **after** `api.getExecution(executionId)`
   (`lib/executions.mts:148`) has already succeeded. A wrong id, or one n8n
   pruned under its data-retention policy, never gets that far.
3. **`backup create` does not 404.** `n8n-decanter.mts:993-994` resolves the
   directory first and throws
   `workflow <ref> not found under <root> — pull it first`. `backupCreate` then
   guards again with
   `missing .decanter.json in <dir> — pull first` (`lib/backup.mts:100`). Both
   are clear. The reporter's "genauso" is a fair description of the *experience*
   — same wall, same cause — but not of the output, and the fix for `backup` is
   therefore only the prerequisite half, not the 404 half.
4. **The prerequisite is longer than "pull it first".** `pull` needs the
   workflow to be `availableInMCP` (the per-workflow n8n-side switch); a
   workflow that is not opted in cannot be pulled, so "pull it first" is advice
   the user may be unable to follow. `ENABLE_MCP_HINT` /
   `isUnavailableInMcp` (`lib/mcp.mts`, wired at `n8n-decanter.mts:12`) already
   exist for exactly this and are appended to per-workflow MCP refusals — the
   REST verbs never reach that code.

## Tasks

1. **Map 404 in `lib/api.mts`.** Alongside the 403 branch
   (`lib/api.mts:158`), give 404 a per-endpoint hint the way `scopeHint` does
   per-scope:
   - `/executions/<id>` → the execution does not exist on this instance — check
     the id, or n8n's data-retention pruning may have removed it;
   - `/workflows/<id>` → the workflow does not exist on this instance (or the
     API key's project cannot see it).
   Keep the raw status and body; add the hint, do not replace the facts.
2. **Map 401 in the same pass.** It currently falls through identically, and
   "your `N8N_API_KEY` is not valid for this host" is a one-line fix while the
   file is open.
3. **Teach the "not pulled" errors the whole chain.** `lib/executions.mts:152`,
   `n8n-decanter.mts:994` and `lib/backup.mts:100` all end at `pull it first`.
   Extend them with the step before it, reusing `ENABLE_MCP_HINT` rather than
   writing a fourth wording: pull needs the workflow opted into MCP.
4. **Consider resolving the workflow remotely before giving up.** `resolveRef`
   (`n8n-decanter.mts:555-570`) already falls back to `search_workflows` — but
   only for `pull` (`n8n-decanter.mts:558`). `search_workflows` lists **every**
   workflow instance-wide regardless of the `availableInMCP` gate, so for the
   REST verbs it could turn "no workflow matches X" into "X exists on the
   instance but is not pulled — `n8n-decanter pull X`". Weigh against the cost:
   it puts an MCP round-trip on the failure path of verbs that are otherwise
   REST-only, and `executions`/`backup` are deliberately the verbs that keep
   working when MCP is down (the report's own point — `backup` over REST was the
   only path left when MCP died). **Make it best-effort and never fatal**, or
   skip it.
5. **Write the chain down once, in prose.** The errors can only carry a line
   each; [docs/cli/overview.md](../../docs/cli/overview.md) or the concepts
   pages should state plainly which verbs need a pulled workflow and which do
   not.

## Acceptance / verification

- `executions <id>` against a mock returning 404 prints the id-specific hint,
  not just `404 Not Found`.
- `executions <id>` for an execution belonging to an unpulled workflow still
  reaches the existing `lib/executions.mts:152` message (task 1 must not shadow
  it — the mock returns the execution successfully in this case).
- `backup create <unpulled>` names both `pull` and the MCP opt-in.
- Task 4, if taken: with the MCP endpoint unreachable, every one of these verbs
  still fails with its *local* message and no added timeout. This is the test
  that keeps the REST path's independence from regressing.
- Real CLI as a subprocess against the mock's `GET /api/v1/...` routes.

## Notes

- **CHANGELOG:** `Fixed` — "REST errors (401/404) now explain the cause instead
  of surfacing the raw HTTP status"; `Changed` — "the `pull it first` errors also
  name the MCP opt-in that `pull` requires".
- **Docs:** task 5 is a docs task; the `executions` and `backup` pages plus
  `overview.md` are the surfaces (root `AGENTS.md`, "Documentation site").
- **PLAN.md:** the REST-vs-MCP backend split is described there — the
  prerequisite chain belongs next to it.
- **Do not "fix" this by moving the REST verbs onto MCP.** Their independence is
  a load-bearing property: the reporter deployed a whole workflow through
  `backup create` / `backup restore` while MCP was dead, and called it the only
  path still open.
