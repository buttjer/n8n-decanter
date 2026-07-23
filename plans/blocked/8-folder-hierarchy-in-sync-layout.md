# Plan 8 — Folder hierarchy in sync layout (Local Overview)

| | |
|---|---|
| **Priority** | P2 |
| **Status** | **Blocked** — solely on one upstream fix: `get_workflow_details`' `parentFolderId` is advertised but never loaded (always `null` — see MCP re-check). **Rescoped 2026-07-22 to read-only "Local Overview"**: placement flows n8n → local only; decanter never writes folders or placement to n8n. The earlier push-first design (and its licensing/probe machinery) is retired — kept below as research record. Live verification still needs a licensed instance, but only *after* upstream ships the read fix. Code not started. |
| **Snapshot** | 2026-07-23T06:57Z @ 710d3f1 |
| **Theme** | **Local Overview** — on pull, mirror each workflow's n8n folder placement as directory nesting between `root` and the workflow dir, so the sync dir reflects the n8n UI's organization. Read-only by design: folder placement is workflow *structure*, and since Plan 32 structure is n8n's job, mirrored locally — placement joins that same principle. |
| **Model** | **Sonnet** — after the rescope this is a small, well-specified pull-side feature (resolve an id chain, hand `ensureWorkflowDir` a parent path). The only judgment-heavy part is the null-safety semantics (task 3); the design below pins them. |

## Goal (rescoped 2026-07-22)

Give the user a better **local overview**: the sync dir's directory tree shows
the same organization as the n8n UI's folder tree. Nothing more — decanter is a
code-sync tool; it must not become a folder manager. The write direction
(pushing local nesting into n8n, creating folders remotely) is **explicitly out
of scope** — that was the original plan's theme and it is retired (see Research
record for why it got harder, not easier, under MCP).

## What already works today (no code needed)

Local nesting as *manual* organization is already supported: sync is
id-anchored (`.decanter.json`), `listWorkflowDirs` (`lib/state.mts:18`) walks
the tree recursively (a workflow dir is any dir with a `.decanter.json`), and
pull's `ensureWorkflowDir` (`lib/pull.mts:27`) renames within
`path.dirname(existing)` — so a hand-nested workflow dir is found and preserved
across pulls. The only friction: a **newly pulled** workflow lands flat at
root; the user moves it into place once and it sticks. This plan automates the
placement so it matches n8n, instead of leaving it to hand-sorting.

## Design decision (proposed — PLAN.md sign-off required before implementing)

- **Read-only mirror.** Pull reads each workflow's `parentFolderId` from
  `get_workflow_details`, resolves the id chain to names via `search_folders`
  (+ `search_projects` for the project id), and moves the local workflow dir to
  the matching sanitized path — reusing the existing rename/collision
  machinery. Nothing is ever written to n8n: no folder create, no workflow
  move, no placement field in any write.
- **Null never moves a dir.** `null` is ambiguous — "at project root" and
  "instance doesn't expose placement" read identically (today *every* instance
  returns null; see MCP re-check). So: **only a non-null `parentFolderId`
  triggers a move**; on null the local layout is left exactly as the user
  arranged it. Consequence accepted: a workflow moved *back to root* in n8n
  won't be mirrored locally until upstream also gives an unambiguous signal —
  correctness over completeness.
- **Remote wins on pull (when readable).** Once placement is readable,
  a local dir sitting at a different path than the remote placement is treated
  like a remote rename: pull moves it. Sticky-slug (Plan 27) still governs the
  **basename**; this plan governs only the **parent path**. A config off-switch
  (`"folders": "off"` in `decanter.config.json`, default mirroring on) covers
  users who prefer their own local order.
- **No probe, no license handling.** Unlicensed instances have no folders —
  every read is null and the feature stays dormant by the null rule. No
  `N8N_FOLDERS` env var, no 403-classification, no "register your instance"
  messaging. (`search_folders` returns empty rather than erroring on
  unlicensed instances.)
- **Everything rides MCP** — `search_folders` / `search_projects` join the
  pinned tool set in `lib/mcp.mts`; `lib/api.mts` gains nothing.

## Blocker

Upstream, n8n MCP server: `get_workflow_details` declares `parentFolderId` in
its output schema but fetches the workflow without `includeParentFolder`, so
the relation is never loaded and the field is **always `null`** (verified in
source at `n8n@2.30.7` and master; chain in the MCP re-check below). One-line
fix at the call site. Until an n8n release ships it, mirroring has nothing to
read — the null rule keeps decanter safely inert on every current instance.

## Tasks

1. **Upstream bug report** (was the old task 10, now the gate): file an n8n
   issue — "`get_workflow_details` advertises `parentFolderId` but never loads
   the `parentFolder` relation; pass `includeParentFolder: true` in
   `getWorkflowDetails` and plumb the option through `GetMcpWorkflowOptions`"
   (optionally: flip `includeFolders` in `search_workflows`). Link the issue
   here; record the first n8n release that ships the fix.
2. **MCP client** (`lib/mcp.mts`): add `search_folders` and `search_projects`
   calls; same error surface as the existing pinned tools.
3. **Pull mirroring** (`lib/pull.mts`): non-null `parentFolderId` → resolve the
   id chain to a sanitized parent path and hand `ensureWorkflowDir` a wanted
   *parent path*, not just a basename (reuses rename/collision handling).
   Null → never move. Honor the `"folders": "off"` config switch.
4. **Guard/`check`** (`lib/validate.mts`): nesting stays legal layout (it
   already is); add a warning for a path segment that sanitizes to empty.
5. **Mock + e2e** (`test/e2e.mts`): teach the mock `search_folders` /
   `search_projects` and a non-null `parentFolderId` in `get_workflow_details`
   (exercises mirroring offline before upstream ships); scenarios: non-null
   placement relocates the dir on pull; null everywhere (today's reality) never
   moves anything — a hand-nested dir survives; remote move relocates; off
   switch respected; segment-sanitization warning fires.
6. **Docs**: README + `/docs` — nested layouts are supported *today* as manual
   local organization; auto-mirroring activates by itself once the instance
   exposes placement; CHANGELOG (Added); PLAN.md — milestone 4, layout sketch,
   config (`"folders"` switch) — raised with the user per CLAUDE.md.
7. **Live verification** on a licensed (`feat:folders`) instance once the
   upstream fix ships: place a workflow in a folder in the UI, pull, dir moves;
   move it back to root in the UI, pull, dir stays (null rule) — document that
   caveat.

## Acceptance / verification

- `npm test` / `npm run typecheck` green; all task-5 scenarios pass — in
  particular the null-everywhere mode proves current instances are never
  touched (hand-nesting preserved, byte-identical behavior to today).
- Mirroring works end-to-end against the mock without any live instance.
- No write path to n8n gains any folder/placement field (assert mock-side:
  no folder tool is ever called with mutating intent).

## Non-goals

- **Any write of placement or folders to n8n** — no folder create/rename/
  delete, no workflow moves, no `parentFolderId` in any write. (Rescope
  2026-07-22; the retired push-first design is in the Research record.)
- **Projects as the hierarchy** — team projects are paid-tier and an
  ownership/sharing boundary, not an organizational tree; wrong tool.
- **Heuristic placement reads** on instances that don't expose it (folder
  `workflowCount` deltas, scraping the internal `/rest` API) — mirroring
  activates only on an honest non-null read.
- Multi-project fan-out; folder tags.

## Research record

Retained findings from the plan's earlier (push-first) incarnation — the facts
stand; the design they fed is retired.

### Upstream source research (2026-07-17, API era — condensed)

Public REST API: **read path none** (`parentFolderId` is `writeOnly` in the
workflow schema; no folder filter on the list; no folder-contents endpoint),
**write path full** (`POST`/`PUT` accept `parentFolderId`; folder CRUD under
`/api/v1/projects/:projectId/folders`, scopes `folder:*`; young API — first
commit 2026-04-22, older instances reject the field entirely). This asymmetry
is what shaped the original push-first design.

### Spike results (task 1 — 2026-07-20, `n8nio/n8n:2.30.7` in Docker)

Fresh community container, API key with all five `folder:*` scopes:

- **The folders feature is license-gated (`feat:folders`)** — free, but the
  instance must be registered (email → license key). Unregistered:
  `GET .../folders` → **403** "license does not allow feat:folders" (route
  exists — not 404); create → same 403 even via the internal UI path; `PUT`
  with `parentFolderId` → **400** "must NOT have additional properties" (the
  field isn't accepted at all when unlicensed). 403 means "unlicensed," not
  "missing scopes" — indistinguishable by scope grant.
- Probe mechanics: `?limit=1` on the folders list → 400 (unknown param);
  `GET /api/v1/projects` → 403 on community (use the `personal` alias).
- Public workflow GET/list expose **no** folder key (matches source research).
- **Not validated:** that a licensed `PUT` actually moves a workflow —
  needs a registered instance. *(After the rescope this proof is no longer
  needed; the read-side verification in task 7 replaces it.)*

### MCP re-check (2026-07-22 — post-Plan-32, n8n source: master + `n8n@2.30.7` tag)

Answers PLAN.md's open question ("re-check Plan 8 against the MCP surface").

**Read path — in the MCP contract, but a dud today (always `null`):**

- `get_workflow_details` declares `parentFolderId` and maps
  `workflow.parentFolder?.id ?? null` — but fetches with only
  `{ includeActiveVersion, includeTags }`; `GetMcpWorkflowOptions` can't even
  express `includeParentFolder`; the repository defaults it to `false`; the
  entity's `parentFolder` relation is lazy (no `eager`), with no scalar
  `parentFolderId` column and no `@RelationId` — so the relation is never
  loaded and the field is **always null**, foldered or not. Identical wiring
  on 2.30.7 and master. The Plan 32 spike's "null in tests" was this unwired
  read (that instance was also unlicensed, so null was correct either way —
  the live observation corroborates but the source chain is the proof).
- `search_workflows` hardcodes `includeFolders: false` into
  `workflowService.getMany` (the service supports it — it's the UI list path).
- The folder **tree** IS readable: `search_folders` (n8n PR #27248, merged
  2026-03-19; in 2.30.7) returns `{id, name, parentFolderId}` per folder;
  needs a `projectId` from `search_projects`; `project:read` OAuth scope;
  builder-gated like `update_workflow`. No license signal: unlicensed
  instances return empty, never 403.
- **Feature detection must be value-based**: over MCP the field is always
  present and always null — presence-detection would read "everything at
  root". Only a **non-null** value proves the read path (→ the null rule in
  the design above).

**Write path — got *worse* under MCP** (why the rescope is also the pragmatic
call, not just the philosophical one):

- `update_workflow`'s op set (17 ops verified) has **no folder/move op**; no
  folder CRUD tools exist; only `create_workflow_from_code` accepts a
  `folderId` (requires `projectId`; folder must pre-exist) — placement at
  creation only.
- The REST write path still exists but is **draft-hostile** post-Plan-32:
  n8n 2.x's public `PUT` hardcodes `publishIfActive: true` + `forceSave: true`
  and takes a full body — moving a workflow with it would publish the draft
  and clobber MCP-managed structure.

**License gate — unchanged by MCP**, but irrelevant to the rescoped plan:
unlicensed instances have no folders, so reads are null/empty and mirroring
stays dormant on its own.

## Notes

- Read-only placement completes the Plan 32 symmetry: `workflow.json` mirrors
  structure read-only; the directory tree mirrors placement read-only. Same
  "pull-first, structure is n8n's job" philosophy — say so in README.
- The kebab-case `code/` subdir item is orthogonal: it nests *inside* the
  workflow dir; this plan nests *above* it. `listWorkflowDirs` stops descending
  at the first `.decanter.json`, so the two compose.
