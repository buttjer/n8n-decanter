# Plan 18 — pinData seeding & round-trip verification (smoke suite)

| | |
|---|---|
| **Priority** | P1 (small, research done, one smoke step + bookkeeping) |
| **Status** | Done (2026-07-19: smoke step landed and green against n8n 2.30.7 — the live probe confirmed the research, the public API accepts and persists `pinData` on PUT, and it survives an untouched pull→push round-trip; bookkeeping in BACKLOG.md/DONE-15/PLAN.md/plans-README updated. Research 2026-07-19: **the recorded "public API cannot set pinData" claim is wrong for n8n 2.30.7** — verified in n8n source at the pinned tag; scoped 2026-07-19 by user decision to **n8n ≥ 2.30.7 only** — public-API seeding, no fallback route) |
| **Theme** | close the pinData half of the tags/pinned-data round-trip check by seeding pinData through the **public API** in the smoke suite (**n8n ≥ 2.30.7 only** — the smoke pin is the support floor), and correct the stale claim in the backlog/PLAN.md. |

## Why

The tags/pinned round-trip backlog item is half done: tags verified 2026-07-19
by the Plan 15 smoke suite; the pinData half was parked because the session
recorded "the public API cannot set it, needs the UI or internal REST", and
seeding-route candidates were collected for a separate analysis session. That
session (2026-07-19) ran the analysis against n8n's source **at the exact
pinned smoke tag (`n8n@2.30.7`)** — and the premise is false: the public API
accepts and persists `pinData` on both create and update. No exotic seeding
route is needed; the check becomes a normal smoke step.

## Source

- [Plan 0](BACKLOG.md): "Tags/pinned-data round-trip check" (pinData half
  open) and its "pinData seeding routes — collect only, decide later"
  sub-item — this plan is that analysis session's outcome.
- [Plan 15](DONE-15-docker-n8n-smoke-suite.md) task 5's pinData half
  (descoped there by user decision 2026-07-19).
- `PLAN.md` resolved-question note (~lines 624–629): pinned data "preserved
  *by construction*" — upgraded to live-verified by this plan.

## Research findings (2026-07-19, n8n source at tag `n8n@2.30.7`)

Full public-API write chain for `pinData` exists at the pinned version:

- **OpenAPI validation accepts it**: `POST /api/v1/workflows` request schema
  (`workflowCreate.yml`) and `PUT /api/v1/workflows/{id}` request schema
  (`workflow.yml`) both list `pinData` as writable (no `readOnly`) despite
  `additionalProperties: false`
  (`packages/cli/src/public-api/v1/handlers/workflows/spec/`).
- **Create persists it**: public-API `createWorkflow` →
  `createWorkflowEntityFromPayload`, whose write-fields allowlist includes
  `pinData` (`packages/cli/src/workflows/workflow-entity-mapper.ts`).
- **Update persists it**: handler `Object.assign(updateData, req.body)` →
  `WorkflowService.update` → `fieldsToUpdate` pick includes `'pinData'`, with
  a `validatePinDataSize` guard
  (`packages/cli/src/workflows/workflow.service.ts`).
- **GET returns it** by default (`excludePinnedData=true` is the opt-out).
- Master is unchanged from 2.30.7 in all these spots — not a just-landed
  feature.

The stale claim almost certainly carried over from **n8n 1.x**, whose public
API workflow schema had no `pinData` property → `400 "must NOT have
additional properties"` (widely reported in community threads). It was
recorded during the smoke session without a live disproof at 2.30.7.

Also established:

- **Fallback seeding route — dropped (scope decision 2026-07-19)**: a
  `docker exec <container> n8n import:workflow` path was verified in source,
  but the check supports **n8n ≥ 2.30.7 only**, where the public API
  suffices — no fallback gets built or kept for regressions.
- **Execution caveat (for [Plan 7](OPEN-7-engine-true-simulation-suite.md),
  not this plan)**: docs say pinned data is honored only in *manual*
  executions, never production — storage vs. execution behavior are separate
  concerns, so the round-trip check is unaffected. It pre-answers Plan 7's
  spike question "does `n8n execute` honor native pinData?" → expect no;
  node replacement stands.
- **Decanter side (why the check matters)**: `sanitizeForPut`
  (`lib/util.mts`) sends only name/nodes/connections/settings/staticData —
  never `pinData` — so survival relies on the server keeping its stored copy
  when the PUT omits the field (server-side `pick` of an absent key leaves
  the column untouched). The smoke step turns PLAN.md's "by construction"
  reasoning into a live-verified fact.

## Tasks

1. **New smoke step** in `test/smoke-n8n.mts`, right after the existing
   "tags survive…" step, reusing its `api()` helper:
   - **Seed via public API** (doubles as the live probe that settles the
     research): `GET /api/v1/workflows/<wfId>` → add
     `pinData: { "<existing node name>": [{ "json": { "smoke": "pinned" } }] }`
     to the PUT body → `PUT` → `GET`, assert the seeded pinData comes back.
     Assert with the full response text so a failure logs the exact server
     error (that's the research-disproof signal).
   - **Round-trip**: `pull` → `push` (both exit 0) → `GET` → deep-equal
     assert pinData still matches the seed — the decanter PUT omitted it,
     the server kept its copy.
2. **Bookkeeping** (same PR):
   - [Plan 0](BACKLOG.md): update the tags/pinned item's status
     parenthetical (pinData half verified, date, n8n 2.30.7, public-API
     seeding), correct the wrong "public API cannot set it" note, and check
     the item's box once the live run is green. Resolve the "pinData seeding
     routes" sub-item with the decision: **public-API seeding, n8n ≥ 2.30.7
     only — no fallback route**.
   - [Plan 15](DONE-15-docker-n8n-smoke-suite.md): status note — pinData
     half of task 5 landed after all via this plan.
   - `PLAN.md` (~lines 624–629): upgrade "preserved *by construction*" to
     live-verified with date, and record that the public API *can* write
     `pinData` on **n8n ≥ 2.30.7** (raise with user per `CLAUDE.md` —
     approving this plan is that ask).
   - `plans/README.md`: add the entry for Plan 18.
3. **Contingency** — if the live probe fails despite the source reading:
   stop and record the exact HTTP status/body here and in the backlog.
   **No fallback route** — support is n8n ≥ 2.30.7 only.

## Acceptance / verification

- `npm run test:smoke` (Docker daemon running) green including the new step;
  suite still leaves no containers behind.
- `npm test` + `npm run typecheck` stay green.
- Backlog box checked, stale claim corrected, PLAN.md note upgraded to
  live-verified with date.

## Non-goals

- No CLI/user-facing changes — `pinData` stays untouched by the decanter's
  data model (never sent in PUTs, not extracted on pull).
- No fallback seeding route of any kind (internal REST, SQLite, or
  `n8n import:workflow`) — public API only.
- No support for n8n < 2.30.7 — the 1.x public API rejects `pinData`
  outright, earlier 2.x versions are untested, and the smoke pin (2.30.7)
  is the floor.
- Plan 7's execution-mode pinData question — noted above, handled there.

## Notes

- **CHANGELOG:** none (dev-only test infra, per Plan 15 convention).
- **Worktree:** implementation starts in `.worktrees/chore-smoke-pindata`
  (branch `chore/smoke-pindata`), own `npm install`; PR, squash-merge,
  internal-only → no version bump.
- Research receipts: n8n GitHub source at tag `n8n@2.30.7` (files cited
  above); n8n docs "Pin and mock data" (manual-executions-only caveat);
  community threads on the 1.x-era `additional properties` 400.
