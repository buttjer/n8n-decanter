# Plan 8 — Folder hierarchy in sync layout

| | |
|---|---|
| **Priority** | P2 (design settled by upstream research; needs a live spike before code) |
| **Status** | Task 1 spike done (2026-07-20) — **blocked on a licensed instance** for the actual-move proof; new finding reshapes the probe/gating design (see Spike results). Code not started. |
| **Theme** | Let the local directory tree between `root` and a workflow folder act as the workflow's n8n folder path, pushed one-way to n8n via the public folders API — because the API can *write* folder placement but cannot *read* it. Pull-side mirroring is built in behind feature detection, so it activates by itself on any instance whose API exposes placement on read (none do today). |
| **Model** | **Sonnet** for the bulk — the design is unusually settled (upstream source research done, tasks carry file:line anchors and concrete mock modes), so this is broad-but-specified implementation across many files. Reach for **Opus** on the live-instance spike (task 1) and the feature-detection/drift semantics (task 6), where judgment beats a checklist. |

## Why

Workflows in n8n can live in folders; the sync layout is flat. PLAN.md
milestone 4 ("n8n folder hierarchy — only if the API exposes it") was deferred
on the open question whether `GET /workflows/:id` exposes folder placement.

That question is now answered from n8n source (master, checked 2026-07-17):

- **Read path: none.** The workflow schema marks `parentFolderId` as
  `writeOnly`; neither `GET /workflows/:id` nor `GET /workflows` loads the
  `parentFolder` relation (the public-api handlers pass only
  `includeTags`/`includeActiveVersion` to `WorkflowFinderService`), the
  workflow list has no folder filter, and there is no folder-contents
  endpoint (only recursive counts). **The public API cannot tell you which
  folder a workflow is in.**
- **Write path: full.** `POST /workflows` and `PUT /workflows/:id` accept
  `parentFolderId` (`null` → project root, omitted → current folder kept),
  and folders have CRUD under `/api/v1/projects/:projectId/folders`
  (`projectId` may be `personal`): list with `filter`
  (`parentFolderId`, `name`) and `select` (incl. `parentFolder`, `path`,
  `workflowCount`), `PATCH` rename/move, `DELETE` with `transferToFolderId`.
  Gated by API-key scopes `folder:create/list/read/update/delete`.
- The folders public API is young: first commit to `folders.handler.ts` is
  **2026-04-22**, so only n8n releases cut after that have it. Older
  instances also *reject* `parentFolderId` in a PUT body (the public API
  validates with `additionalProperties: false`) — compat matters.

Consequence: the original "mirror n8n's hierarchy on pull" idea is
**blocked upstream**. What is possible — and matches the project's existing
one-way precedent for `.ts` nodes — is the inverse: **local placement is
source of truth, push applies it to n8n; pull leaves placement alone.**
The read gap looks like v1 scoping rather than a design stance (the entity
relation and finder support exist; the public handler just doesn't request
it), so the plan still builds the pull-side mirror — feature-detected, plus
an upstream request to unlock it — rather than writing it off.

The local side is already halfway there: `listWorkflowDirs`
(`lib/state.mts:18`) walks the tree recursively (a workflow dir is any dir
with a `.decanter.json`), and pull's `ensureWorkflowDir` (`lib/pull.mts:27`)
renames within `path.dirname(existing)`, so a manually nested workflow dir is
found and preserved across pulls today. This plan turns that from "tolerated"
into a feature with a remote effect.

## Source

- [Plan 0](BACKLOG.md): "**Folder hierarchy in sync layout** — mirror n8n's
  folder hierarchy, if the API exposes folder placement (PLAN.md milestone 4 —
  needs a live instance to verify)."
- PLAN.md: milestone 4; open question "Does this n8n version's public API
  expose folder placement (`parentFolderId`/project) on `GET /workflows/:id`?"
  (answered above: no — write-only); layout sketch line
  "`<n8n folder path>/` — only if the API exposes it".

## Design decision (proposed — PLAN.md sign-off required before implementing)

- **Layout:** directories between `root` and a workflow dir are the intended
  n8n folder path: `workflows/Marketing/Reports/<Workflow Name>/…` ⇒ folder
  `Marketing/Reports`. Flat dirs (today's layout) mean project root — and
  behave byte-identically to today.
- **Push-only placement:** on push, resolve/create the folder chain via the
  folders API and send `parentFolderId` in the PUT. **Only when the workflow
  dir is nested** — flat layouts never touch folder endpoints and never send
  the field, so pushes to pre-2026-04 instances keep working unchanged.
- **Pull mirrors placement when readable, else leaves dirs alone.** Each
  pulled workflow response is feature-detected for `parentFolderId` /
  `parentFolder`. Absent (every instance today): pull never moves dirs, new
  workflows land flat at root, and there is no placement drift detection —
  no remote value to compare against. Present (a future n8n, or our mock):
  pull resolves the folder-id chain to names via the folders API and moves
  the local workflow dir to the matching sanitized path — same model as
  workflow renames — and placement joins the normal pull-first drift story.
- **Folder matching:** resolve each path segment against
  `GET /projects/personal/folders?filter={"parentFolderId":…,"name":…}`;
  create missing ones. Local dir names are what the user typed, so the
  remote folder gets the segment name verbatim; when matching existing
  remote folders, also accept a remote name whose `sanitizeFilename`
  (`lib/util.mts:43`) form equals the segment (remote names may contain
  characters a dir name can't).
- **Capability is probed at init and pinned in `.env`:** `init`'s existing
  credential check (`lib/init.mts:126`) grows a folders probe, and the result
  is written as `N8N_FOLDERS=none|write|read-write` into the `.env` it
  already writes — capability is a property of the instance, so it belongs
  next to the host/key that describe it (gitignored, per-instance, not in
  the committed `decanter.config.json`). Push/pull consult the var instead
  of discovering failure mid-push; for reads, per-response detection stays
  the runtime authority (the var only says whether to look). Being env, it
  doubles as a manual off switch (`N8N_FOLDERS=none`). Unset var (a `.env`
  from before this feature): probe on demand at first nested push, with a
  hint to re-run `init` to persist; after an n8n upgrade, re-running `init`
  re-probes.
- **Projects:** default `personal`; optional `projectId` in
  `decanter.config.json` for enterprise setups. No multi-project fan-out.

## Tasks

1. **Live-instance spike (gate for the rest).** Against the real instance:
   confirm the n8n version has the folders API
   (`GET /api/v1/projects/personal/folders` → 200, not 404), that the API
   key carries the `folder:*` scopes, and that a scratch-workflow PUT with
   `parentFolderId` both succeeds and actually moves it in the UI. Record
   findings here and close the PLAN.md open question (with user sign-off).
   The spike doubles as ground truth for task 3's probe classification.
2. **API client** (`lib/api.mts`): add `listFolders(projectId, filter)` and
   `createFolder(projectId, { name, parentFolderId })`; keep the same
   error surface as `getWorkflow`/`updateWorkflow`.
3. **Capability probe at init** (`lib/init.mts`): extend the existing
   credential check (the try/fetch around `lib/init.mts:126`) to probe
   folders support — `GET /api/v1/projects/personal/folders?limit=1`:
   200 ⇒ `write`; 404 ⇒ `none`; 403 ⇒ `none` with a distinct "API key lacks
   `folder:*` scopes" warning. For `read-write`, check one item of
   `GET /api/v1/workflows?limit=1` for a placement field (no workflows yet ⇒
   stay at `write`). Write `N8N_FOLDERS=<result>` into the `.env` init
   already writes — including on the "using existing .env" path
   (`lib/init.mts:84`), which today skips straight past writing; re-running
   `init` after an n8n upgrade must refresh the var. Plumb it through
   `loadConfig` (`lib/config.mts`) / `DecanterConfig` (`lib/types.mts`).
4. **Push placement** (`lib/push.mts` `pushWorkflow`): compute
   `path.relative(root, dir)`; when it has intermediate segments, resolve
   the chain (task 2), and include `parentFolderId` in the PUT body —
   `sanitizeForPut` (`lib/util.mts:116`) must pass it through. Gate on the
   probed capability: `none` + nested dir ⇒ clear upfront error ("this n8n
   version has no folders API (or the key lacks scopes) — flatten the
   layout, or upgrade and re-run init"), instead of a mid-push 400; var
   unset (pre-feature `.env`) ⇒ probe on demand once, hint to re-run
   `init` to persist.
5. **State:** record the pushed placement in `.decanter.json` (e.g.
   `folderPath` + resolved `parentFolderId`) so an unchanged path skips the
   folder lookups on subsequent pushes. Moving the dir locally invalidates
   the cache and re-places on next push.
6. **Pull mirroring, feature-detected** (`lib/pull.mts`): when a pulled
   workflow response carries `parentFolderId`/`parentFolder` (no instance
   does today — this is the "support it if possible" path), resolve the id
   chain to a folder path via the folders API and hand `ensureWorkflowDir`
   (`lib/pull.mts:27`) a wanted *parent path*, not just a basename, so
   remote moves reuse the existing rename/collision handling. A readable
   placement that differs from the local path also joins `driftProblems`
   (`lib/push.mts:40`), so push warns before overwriting a UI move —
   placement then follows the standard pull-first flow. `N8N_FOLDERS`
   gates whether pull looks; the response field remains the authority.
7. **Guard/`check`** (`lib/validate.mts`): no new hard errors — nesting is
   legal layout. Add a warning for a path segment that sanitizes to empty,
   and make sure the sync-dir upward search and `check`'s recursive scan
   are unaffected by intermediate dirs (they should be — both key off
   `.decanter.json`).
8. **Mock + e2e** (`test/e2e.mts`): teach the mock the folders endpoints and
   `parentFolderId` on PUT (still rejecting unknown fields otherwise), plus
   two extra modes: a strict "old instance" mode that 404s the folders
   route and 400s `parentFolderId`, and a "read-capable" mode whose
   workflow GET includes placement (exists nowhere yet — it exercises
   task 6 offline). The three modes map 1:1 to probe results — assert init
   writes `N8N_FOLDERS=none|write|read-write` accordingly. Scenarios:
   nested dir push creates the folder chain and sends `parentFolderId`;
   re-push with unchanged path makes no folder calls; flat push sends
   nothing (old-mode mock stays green); nested push in old mode fails
   upfront with the task-4 message; local dir move re-places; in
   read-capable mode a remote move relocates the local dir on pull and a
   placement mismatch trips the drift guard.
9. **Docs:** README section on nested layouts + the `N8N_FOLDERS` var;
   CHANGELOG entry (Added); PLAN.md updates — milestone 4, layout sketch,
   `.decanter.json` schema, Config/Init flow (`.env` gains `N8N_FOLDERS`),
   open question — raised with the user per CLAUDE.md, not silently.
10. **Upstream feature request:** file an n8n issue asking for
    `parentFolderId` on workflow GET responses (the entity relation and
    `WorkflowFinderService.includeParentFolder` already exist — only the
    public-api handler omits it), link it here, and record the first n8n
    release that ships it once it lands. That release turns task 6 on for
    real instances via a re-run of `init` (or on-demand re-probe) — no
    decanter change.

## Spike results (task 1 — 2026-07-20, `n8nio/n8n:2.30.7` in Docker)

Method: booted a fresh community-edition container, minted an API key carrying
all five `folder:*` scopes (via the internal `/rest/api-keys`), and probed the
public + internal folders/workflow endpoints. Scratchpad scripts only (not
committed); container torn down.

**Headline: the folders feature is license-gated (`feat:folders`), and a fresh
community instance does not have it.** It is *free* but requires **registering
the instance** (email → license key) to unlock — it is not enterprise-only, but
it is not on out-of-the-box either. Consequences observed on the unregistered
instance:

- `GET /api/v1/projects/personal/folders` → **403** `{"message":"Your license
  does not allow for feat:folders. To enable feat:folders, please upgrade to a
  license that supports this feature."}` — **the route exists, it is not 404.**
- `POST .../folders` (create) → same **403**. Even the **internal** UI path
  `POST /rest/projects/:id/folders` → **403** `"Plan lacks license for this
  feature"` — so this is not a public-API quirk; the UI can't make folders
  either on an unregistered instance.
- `PUT /api/v1/workflows/:id` with `parentFolderId` in the body → **400**
  `{"message":"request/body must NOT have additional properties"}`. When
  folders is unlicensed, `parentFolderId` is **not an accepted PUT property at
  all** — identical to sending any unknown field. (So on these instances the
  plan's push-placement can't even attempt the move.)
- The API key *did* carry `folder:create/list/read/update/delete` (the scopes
  exist on 2.30.7) — yet still got 403. **403 here means "feature unlicensed,"
  not "key lacks scopes."** The two are indistinguishable by scope grant.

**Probe-mechanics findings (affect task 3):**

- `GET .../folders?limit=1` → **400** `{"message":"Unknown query parameter
  'limit'"}`. The folders list endpoint on 2.30.7 does **not** accept `limit`.
  Task 3's probe (`...folders?limit=1`) must drop `limit` (bare GET, or use
  `filter`/`select`), or every probe misfires as a 400.
- `GET /api/v1/projects` → **403** on community (Projects list is itself
  license-gated). Do **not** resolve the personal project id through it; the
  `personal` alias in the folders path works without that permission.

**Read-path — write-only confirmed (matches the source research):**

- Public `GET /api/v1/workflows/:id` and the `GET /api/v1/workflows` list items
  expose **no** `parentFolder*`/folder key. Task 6's feature detection stays
  correct — no instance exposes placement on public read today.

**Not validated (the actual point of task 1):** that a PUT with
`parentFolderId` *moves* the workflow and shows in the UI. That requires a
**registered/licensed** instance with `feat:folders`, which a bare Docker
container can't provide (registration needs a real email + n8n's license
server, out of scope for an automated spike). **This proof is deferred until a
licensed instance is available.**

**Design implications to fold into the tasks (pending sign-off):**

1. **Task 3 (probe) needs a fourth outcome: `403 feat:folders` = "route present
   but unlicensed."** Distinct from 404 (no folders API / old build) and from a
   403 caused by missing scopes. Suggest classifying: 404 ⇒ `none`; 403 whose
   body mentions `feat:folders`/`license` ⇒ `none` **with an "register your
   instance (free) to enable folders" hint**; 403 otherwise ⇒ `none` with the
   "key lacks `folder:*` scopes" hint; 200 ⇒ `write`. Drop `?limit=1`.
2. **Task 4's gating message is wrong for the common case.** "upgrade and re-run
   init" implies a version problem; the actual fix on a modern-but-unregistered
   instance is **register the community edition (free) to unlock folders**.
   Message should name licensing, not just version/scopes.
3. **Task 8 (mock + e2e) can't be exercised by the smoke suite as-is** — the
   Docker smoke instance is unregistered, so it will 403 on every folder call.
   The mock modes stay the offline oracle; smoke coverage of the *real* folders
   path needs a licensed instance (skip/guard it otherwise).

## Acceptance / verification

- `npm test` and `npm run typecheck` green; all task-8 scenarios pass,
  including the read-capable mode proving pull mirroring works end-to-end
  without a live instance that supports it.
- `init` against each mock mode (and the live instance) writes the matching
  `N8N_FOLDERS` value, and re-running `init` refreshes it.
- A flat sync dir produces byte-identical API traffic to today (no folder
  calls, no `parentFolderId`) — verified by the old-mode mock.
- On the live instance: nesting a workflow dir and pushing places the
  workflow in the matching n8n folder (visible in the UI); pulling
  afterwards changes nothing locally.

## Non-goals

- **Heuristic placement reads** on instances that don't expose it (e.g.
  inferring via folder `workflowCount` deltas, or scraping the internal
  session-authenticated `/rest` API) — pull mirroring activates only on an
  honest public-API read path (task 6's feature detection).
- Deleting/GC-ing remote folders emptied by local moves.
- Multi-project sync, folder tags, folder renames driven from local renames
  of intermediate dirs (a rename looks like move-out + move-in; first
  version may re-create rather than rename — note in docs).

## Notes

- One-way placement mirrors the `.ts` one-way precedent; say so in README so
  users expect UI folder moves to be overwritten on next push (same "pull
  first" philosophy — except here pull can't even see the move). This caveat
  self-retires per instance: once an instance exposes placement on read,
  task 6's detection makes pull see the move and the caveat no longer
  applies there.
- The kebab-case backlog item (`code/` subdir) is orthogonal: it nests
  *inside* the workflow dir; this plan nests *above* it. `listWorkflowDirs`
  stops descending at the first `.decanter.json`, so the two compose.
