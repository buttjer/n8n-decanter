# Plan 89 — the REST verbs need a pulled workflow, and never say so until the raw HTTP shows through

**Status:** Done (2026-10-25) — Tasks 1, 3 and 5 landed together (the 404
hints in `lib/api.mts`, `NOT_PULLED_HINT` in `lib/mcp.mts`, the "Which verbs
need a pulled workflow" section in `docs/cli/overview.md`; tests in
`test/unit/api-not-found.test.mts`, `rest-prerequisite.test.mts` and
`push-drift-hint.test.mts`). Task 2 (the 401 mapping) landed earlier with Plan
92 (9c926ca, changelogged in 0.11.1). Task 4 is dropped (see
"Re-evaluation").
**Priority:** P2 — no correctness bug, but the failure lands as an unmapped HTTP
status and the prerequisite behind it is nowhere in the text.
**Source:** user field feedback 2026-09-02, report 1 ("`executions <id>` braucht
den Workflow in der Pull-Liste; für einen frisch angelegten Workflow kommt ein
nacktes REST-404. `backup create` genauso"). Verified the same day — **the
`backup create` half did not reproduce as described**, see "Findings". Same batch
as [Plan 86](../done/86-init-writes-when-asked-for-help.md),
[Plan 87](../done/87-auth-errors-point-the-wrong-way.md),
[Plan 88](../done/88-data-tables-stale-rows-and-refs.md),
[Plan 90](../open/90-backup-source-instance-stamp.md) and
[Plan 91](../draft/91-guard-hint-for-credential-type-refusal.md).
**Snapshot:** 2026-10-25T10:24Z @ 45521e2
**Model:** Sonnet — the work is judgement about wording and where a shared
message belongs; one phase, not worth cutting.

The workflow-scoped REST verbs (`executions`, `backup`) can only address a
workflow that is already pulled into the local mirror. That is a reasonable
design, but a workflow you just created on the instance is not pulled, and
nothing in the failure says so — `executions <id>` surfaces a bare
`GET /api/v1/executions/<id>?includeData=true failed: 404 Not Found` with n8n's
body appended. (`data-tables` is REST too, but tables are project-scoped and
need no pulled workflow — it is out of scope here.)

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

1. **`lib/api.mts` maps 401 and 403, and nothing else.** `lib/api.mts:180-189`
   has both branches (401 since Plan 92); everything else falls through to
   `lib/api.mts:190`:
   ```ts
   throw new Error(`${method} ${pathname} failed: ${res.status} ${res.statusText}\n${text.slice(0, 2000)}`);
   ```
   The 403 branch is the model to copy — it is specific, it names the cause,
   and `scopeHint` tailors it per endpoint.
2. **`fetchExecutionById` has the right message but cannot reach it.**
   `lib/executions.mts:152` does say
   `execution <id> belongs to workflow <wfid>, which is not pulled under <root>
   — pull it first`. But it runs **after** `api.getExecution(executionId)`
   (`lib/executions.mts:148`) has already succeeded. A wrong id, or one n8n
   pruned under its data-retention policy, never gets that far.
3. **`backup create` does not 404.** The `backup:*` case
   (`n8n-decanter.mts:1123-1125`) resolves the directory first and throws
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
   `isUnavailableInMcp` (`lib/mcp.mts:23`, imported at `n8n-decanter.mts:12`)
   already exist for exactly this and are appended to per-workflow MCP
   refusals — the REST verbs never reach that code.
5. **Which message a user sees depends on the shape of the ref** (found
   2026-10-25, not in the original finding). `resolveRef`
   (`n8n-decanter.mts:683-698`) passes a ref through unchanged when it
   `looksLikeWorkflowId` (`lib/state.mts:214` — `^[A-Za-z0-9_-]+$`, so an id
   *and* a kebab name like `my-new-workflow`); those land on the verb's own
   `not found under <root> — pull it first`. Any other ref — a display name
   with spaces, the common case for a freshly created workflow — is thrown at
   `n8n-decanter.mts:697` as `no workflow matches "<ref>" — nothing pulled yet`
   (or `— pulled workflows: …`), which never mentions `pull` at all.
6. **"pull it first" is not three sites, it is a family.** The same ending
   appears at `n8n-decanter.mts:904/992/1033/1102/1125`,
   `lib/executions.mts:132/152`, `lib/push.mts:205`, `lib/watch.mts:45` and
   `lib/backup.mts:100`. Only the ones a not-yet-pulled workflow can reach are
   in scope (see Task 3); push/watch/diff on an unpulled workflow are the same
   wall, so they benefit for free if the message is shared.

## Re-evaluation (2026-10-25 @ 45521e2)

Reproduced against a REST mock, real CLI as a subprocess, MCP endpoint
instrumented (zero hits for every command below):

| Command | Output |
|---|---|
| `executions 999` (mock 404) | `GET /api/v1/executions/999?includeData=true failed: 404 Not Found` + raw body |
| `executions 5` (execution of an unpulled workflow) | `…belongs to workflow X, which is not pulled… — pull it first` |
| `executions <id-shaped ref>` / `backup create <id-shaped ref>` | `workflow X not found under <root> — pull it first` |
| `backup create "My New Workflow"` | `no workflow matches "My New Workflow" — nothing pulled yet` |

Drift since the original snapshot (3c5ee4d): 42 commits, of which only Plans
86, 87, 92 and 88 (#347) touched these files; only Plan 92 overlapped, as Task
2. Nothing else changes the picture.

## Tasks

1. **Map 404 in `lib/api.mts`.** Alongside the 401/403 branches
   (`lib/api.mts:180-189`), give 404 a per-endpoint hint the way `scopeHint`
   does per-scope:
   - `/executions/<id>` → the execution does not exist on this instance — check
     the id, or n8n's data-retention pruning may have removed it;
   - `/workflows/<id>` → the workflow does not exist on this instance (deleted
     since the last pull, or the API key's project cannot see it).
   Keep the raw status and body; add the hint, do not replace the facts.
2. ~~**Map 401 in the same pass.**~~ **Done** with Plan 92 (9c926ca).
3. **Teach the "not pulled" errors the whole chain, from one place.** Add one
   shared helper for the not-pulled message (name, ref, root) that ends in
   *pull it — and `pull` needs the workflow opted into MCP:*
   `ENABLE_MCP_HINT` — reusing that constant rather than writing another
   wording. Wire it into:
   - `resolveRef`'s `no workflow matches` throw (`n8n-decanter.mts:697`) — the
     path a display-name ref actually takes (Finding 5). Keep the
     `pulled workflows: …` list; add the chain after it;
   - the REST verbs' own sites: `lib/executions.mts:132/152`,
     `n8n-decanter.mts:1125` (`backup:*`), `lib/backup.mts:100`;
   - the other `not found under <root> — pull it first` sites in Finding 6
     where it costs nothing to share the helper. Don't widen past messages
     that mean "this workflow is not in the mirror" — `lib/push.mts:95`
     (drift) and the `validate.mts` layout errors mean something else.
4. ~~**Consider resolving the workflow remotely before giving up.**~~
   **Dropped (2026-10-25).** It is the only task that would put an MCP
   round-trip on verbs whose independence from MCP is load-bearing (see
   Notes), and Task 3's wording already tells the user the next step. If a
   future report shows users still stuck, revisit it as best-effort and never
   fatal.
5. **Write the chain down once, in prose.** The errors can only carry a line
   each; [docs/cli/overview.md](../../docs/cli/overview.md) should state plainly
   which verbs need a pulled workflow (`executions`, `backup`, `scenario`,
   `push`/`watch`/`diff`/`preflight`) and which do not (`pull`, `list`,
   `data-tables`), with the create → opt in → pull chain. The `executions` and
   `backup` pages link to it.

## Acceptance / verification

- `executions <id>` against a mock returning 404 prints the id-specific hint,
  not just `404 Not Found`.
- `executions <id>` for an execution belonging to an unpulled workflow still
  reaches the `lib/executions.mts:152` message (Task 1 must not shadow it — the
  mock returns the execution successfully in this case), and that message now
  names the MCP opt-in.
- `backup create <unpulled>` names both `pull` and the MCP opt-in — for an
  id-shaped ref **and** for a display name with spaces (Finding 5).
- With the MCP endpoint unreachable, `executions` and `backup create` still
  fail with their local message and make no MCP call. This is the test that
  keeps the REST path's independence from regressing.
- A unit test for the 404 hint next to `test/unit/api-scopes.test.mts`; the
  CLI-surface cases above as a mock-backed e2e step.
- Real CLI as a subprocess against the mock's `GET /api/v1/...` routes.

## Notes

- **CHANGELOG:** `Fixed` — "a REST 404 (`executions <id>`, `backup create`) now
  explains the cause instead of surfacing the raw HTTP status"; `Changed` —
  "the `pull it first` / `no workflow matches` errors also name the MCP opt-in
  that `pull` requires".
- **Docs:** Task 5; `overview.md` plus the `executions` and `backup` pages
  (root `AGENTS.md`, "Documentation site"). No README change — no verb or flag
  changes.
- **PLAN.md:** the REST-vs-MCP backend split is described there — the
  prerequisite chain belongs next to it.
- **Do not "fix" this by moving the REST verbs onto MCP.** Their independence is
  a load-bearing property: the reporter deployed a whole workflow through
  `backup create` / `backup restore` while MCP was dead, and called it the only
  path still open.
