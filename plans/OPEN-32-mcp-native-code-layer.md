# Plan 32 — MCP-native strategy: decanter as the Code-node code layer

**Priority:** P2 (strategy shift)
**Status:** Not started — spike complete (2026-07-22); awaiting go/no-go sign-off
**Theme:** Stop owning canonical workflow sync via the public REST API; narrow decanter's
scope to the **Code-node source layer** (js/ts files, shared code, TS features, diagnostics,
local run) and delegate workflow **structure + lifecycle** to n8n's own **MCP server + skills**,
used as n8n intends.
**Model:** Opus (novel design / product-identity decision).

## Why

Today decanter *owns the canonical workflow*: `GET /api/v1/workflows/:id` → strip each Code
node's `jsCode` to `code/<node>.js|.ts` → `PUT` the exact object back, with structural hashing
+ a drift guard. That machinery exists to keep `workflow.json` a lossless, git-diffable mirror.

n8n now ships a **first-party MCP server** (built-in, ~v2.13+) plus an official **skills** pack
— the intended agent-facing surface for *building and operating* workflows, with a real
capability the public API lacks: **draft-first edits + deliberate `publish_workflow`**. See
[[n8n-agent-grounding-landscape]] (Plan 30 grounding research).

The pivot: decanter stops trying to be the canonical sync tool (arguably table-stakes
"n8n-as-code" many tools do) and becomes **the Code-node craftsmanship layer** — the
distinctive thing (shared TS, type-check, local run/sim). Structure + lifecycle become
n8n/MCP/skills' job.

**Why the scope fits MCP.** MCP's `update_workflow` is *partial batched ops*
(`setNodeParameter`, `updateNodeParameters`, `addNode`…) with **no full-JSON-replace tool** —
which would block decanter owning the whole object, but is *exactly the right shape* when the
scope is a single node's `jsCode` param.

## Design decision — the invariant and what flexes

Decided with the user (this session):

- **Invariant (non-negotiable): Code-node source (`.js`/`.ts`) stays in git.** This is *the*
  key feature. It lives in decanter's **file layer**, not the sync backend — so it survives a
  full API→MCP switch untouched. This is what makes the pivot safe.
- **Workflow structure in git → nice-to-have, read-only.** A read-only structure *snapshot*
  (for review/diff) if it drops out cleanly; **missing some versions is acceptable**. Not a
  blocker, not canonical.
- **Node identity across structure edits → acceptable to handle.** Skills/MCP may
  `renameNode`/re-add nodes; the `code/<file>` ↔ node mapping (`.decanter.json`, keyed on node
  id) must survive that. Manageable, needs design (Task 3).
- **The public API is dropped for the workflow *code path* — not everywhere.** MCP reads and
  writes Code-node `jsCode` byte-exact (spike-confirmed), so pure-MCP is viable for both
  directions of the code sync. But MCP has **no data-table row reads** (add-only) and **no
  published-version content reads** (draft only), so surfaces needing those — Plan 25's
  `data-tables` verb — keep the public API. See Notes → Spike findings.
- **[n8n-io/skills](https://github.com/n8n-io/skills): lean on the *knowledge* skills; keep
  the *build/lifecycle* ones subordinate.** The official pack splits in two: knowledge skills
  (`code-nodes`, `expressions`, `data-tables`, `binary-and-data`, `credentials-and-security`,
  `debugging`) complement decanter with zero conflict — lean on them heavily in user space.
  Build/lifecycle skills (`workflow-lifecycle`, `subworkflows`, `agents`, `loops`,
  `error-handling`, `extending-mcp`) mutate the live instance via MCP; under this pivot most
  stop conflicting (structure is n8n/MCP's job now), but **the Code-node write path is the one
  boundary that must stay decanter's** — a skill editing `jsCode` on the instance bypasses the
  git files and drifts the source of truth. So the sharpened line (vs. Plan 30's "knowledge
  good / building bad") is: **decanter owns Code-node source; skills own the rest of
  structure/lifecycle.** Caveats: the plugin installs the *whole* pack (no cherry-pick), the
  skills are not decanter- or instance-version-aware, and heavy reliance without a precedence
  override actively undermines decanter — so the boundary must be declared, not assumed
  (Task 9).

## Source

- [[n8n-agent-grounding-landscape]] — Plan 30 Theme C grounding research (official MCP is
  instance-aware but instance-mutating; off-by-default; token is UI/env-only; skills pack).
- This session's strategy discussion + spike (2026-07-22).
- Related: Plan 20 ([DONE-20](DONE-20-cli-publish-lifecycle.md)) publish lifecycle is
  API-based (`activate`/`deactivate`, `versionId`/`activeVersionId`) — re-bases onto MCP
  `publish_workflow`/`unpublish_workflow`. Plan 25 (data-tables) **stays API-based** — MCP has
  no row reads (see Spike findings).

## Tasks

1. **Spike — DONE 2026-07-22.** Validated the approach against local Docker n8n `2.30.7`
   (boot recipe reused from `test/smoke-n8n.mts`). Outcome: **technically green** on read
   fidelity, draft-first write, auth, and node identity — full results in Notes → Spike
   findings; reusable recipe in `AGENTS.md` "Driving a real n8n in Docker".
2. **Ownership boundary + sync redesign:** decanter writes **only** the `jsCode` param of Code
   nodes, never structure. Redefine pull (read jsCode → files) and push (files →
   `updateNodeParameters` → optional publish). Two spike-verified semantics anchor the design:
   **pull reads the draft** (`get_workflow_details` returns the draft version; published
   content is not readable via MCP), and **`updateNodeParameters` merges** — a `{jsCode}`-only
   write preserves sibling params (`mode`, `language`), so push needs no read-modify-write.
   Drop whole-workflow structural hashing, the PUT-canonical drift guard, `.remote.js` conflict
   flow, and flat-layout rename migration — all tied to owning structure. Keep per-node content
   hashing.
3. **Node-identity mapping** across MCP structure edits (`renameNode`/add/remove) — keep
   `code/<file>` ↔ node stable in `.decanter.json`. MCP addresses nodes by **name** while the
   map is keyed on node **id** (stable across renames), so this is a name↔id reconciliation
   layer.
4. **Lifecycle re-base:** `publish`/`unpublish` map cleanly onto `publish_workflow`/
   `unpublish_workflow` (spike-verified end-to-end, incl. draft divergence on an active
   workflow). `create`/`duplicate`/`delete` need design: MCP creation is
   `create_workflow_from_code` (**n8n Workflow SDK code, not a JSON payload** — `duplicate`
   can't just replay a GET), and MCP has **no hard delete, only `archive_workflow`** — decide
   per verb whether to re-express, keep on the API, or drop.
5. **`init` onboarding + MCP auth — OAuth-first.** **OAuth2 is the primary method; consent
   happens in `init`.** `init` is the interactive/TTY moment (user present, browser available),
   so n8n's authorization-code flow fits there: one-time browser consent → decanter stores the
   **refresh token** → headless runtime (`push`/`watch`/CI) refreshes access tokens silently,
   no browser. No long-lived static secret, revocable. Flow (spike-confirmed): discovery
   `GET /.well-known/oauth-authorization-server` → RFC 7591 `POST /mcp-oauth/register` →
   `GET /mcp-oauth/authorize` (browser consent) → `POST /mcp-oauth/token`
   (`access_token`+`refresh_token`, `expires_in: 3600`), then the `refresh_token` grant renews.
   The **rotatable Bearer token** (`POST /rest/mcp/api-key/rotate`, owner cookie) is a **narrow
   fallback** for non-interactive provisioning (CI, no browser at init).
   - **The app needs only the standard `/mcp-oauth/*` + `/mcp-server/http` endpoints.** Consent
     is a **browser click** in n8n's own UI (decanter opens the authorize URL, catches the code
     at a localhost callback). Enabling MCP and the per-workflow `availableInMCP` opt-in are
     **guided UI steps** for the user; their internal `/rest/*` endpoints are
     undocumented/version-fragile, so automate them only as optional, cookie-gated polish, never
     a hard dependency. Version floor applies (~2.13/2.20).
   - **Read scope:** an OAuth access token hits the *same* per-workflow gate as any token —
     `search_workflows` lists all workflows, but `get_workflow_details`/edit only work on
     `availableInMCP`-flagged ones. Auth method is orthogonal to workflow visibility.
6. **Read-only structure snapshot** (nice-to-have, last): `get_workflow_details` already yields
   clean structure JSON, so optionally write it to git read-only for review; else skip.
7. **Docs/changelog/PLAN.md** overhaul — the sync model changes fundamentally (Breaking).
8. **Picker: third state for MCP-unavailable workflows + pull guidance.** `search_workflows`
   lists **all** workflows, but only `availableInMCP` ones are pullable, so the picker can now
   show workflows it cannot yet pull. Extend the picker
   (Plan 19/[DONE-23](DONE-23-picker-visual-refinements.md)) beyond today's two states —
   pulled (green `●`), unpulled-but-available remote (yellow `○`) — with a **third: MCP-
   unavailable remote workflows in red**, sorted **third** (below green + yellow). Selecting a
   red one surfaces **guidance** — "this workflow isn't available in MCP; enable it from the
   workflow card or workflow settings" — and offers to **toggle `availableInMCP` + pull** (UI
   guidance by default; optional cookie-gated automation via
   `PATCH /rest/mcp/workflows/toggle-access` where creds allow, per Task 5's caveat).
   Non-TTY/piped invocations print the same guidance line-oriented. The signal is the
   `availableInMCP` flag from `search_workflows`, not a failed detail read.
9. **Wire n8n-io/skills into the template's sync-dir `AGENTS.md` (user space) with a precedence
   override.** Recommend/scaffold the **knowledge** skills as the default authoring aids; keep
   the **build/lifecycle** skills subordinate to a decanter override that must *dominate, not
   trail* — per the Design-decision bullet. Core rule to encode: *"n8n skills for knowledge;
   workflow structure may go through MCP/skills, but **Code-node source is authored as files and
   pushed/synced by decanter — never edited on the instance directly**; this AGENTS.md wins."*
   Follow the repo convention (substance in the tool-agnostic sync-dir `AGENTS.md`, per-agent
   files as thin pointers). Note the install pulls the whole pack (can't cherry-pick), so the
   override — not selective install — is what holds the boundary. Relates to
   [[n8n-agent-grounding-landscape]] (Plan 30 "override, don't fork").

## Acceptance / verification

- **Code-node source in git round-trips byte-exact** through the new MCP path (the invariant).
- A Code node edit lands on the **draft** and only goes live on explicit publish.
- Node mapping survives a structure-side rename.
- Smoke suite extended to drive the MCP path on the pinned container.

## Non-goals

- Full canonical workflow-in-git (downgraded to read-only nice-to-have).
- Byte-exact structure round-trip / version-complete history.
- Supporting instances below the MCP floor (~2.13/2.20).

## Notes

- **Breaking + strategy shift** — changes decanter's identity and the sync data model;
  PLAN.md must be rewritten, not patched, and this needs explicit user sign-off before Task 2.
- **Adoption floor** is the main cost: MCP off-by-default, a per-workflow `availableInMCP`
  opt-in, and the version floor (~2.13/2.20) are hard requirements on the MCP path (vs. today's
  "any n8n + API key"). Enable/mint are headless-automatable, which softens but doesn't remove
  it.
- **Young/evolving tool surface** — coupling the whole tool to MCP trades REST v1 stability for
  that churn; a real cost to weigh in the go/no-go.
- **Spike findings (2026-07-22, n8n `2.30.7` in Docker):** the pivot is technically green.
  - **MCP endpoint & enablement:** live at `POST /mcp-server/http` (401 without token, 404 when
    off). Enable via `PATCH /rest/mcp/settings {mcpAccessEnabled:true}` (the
    `N8N_MCP_ACCESS_ENABLED` env did not flip it on 2.30.7).
  - **Auth:** OAuth2 (preferred) issues access + refresh tokens (Task 5); or a rotatable Bearer
    token via `POST /rest/mcp/api-key/rotate`. The **public API key is not a valid MCP bearer**.
  - **Read fidelity:** `get_workflow_details` returns Code-node `jsCode` **byte-exact** (only
    credentials are stripped, not node params), plus full structure + `versionId`/
    `activeVersionId` — enough for a read-only structure snapshot.
  - **Write + draft:** `update_workflow`/`updateNodeParameters` writes `jsCode` **byte-exact to
    the draft only** (`versionId` bumps; `activeVersionId` untouched); `publish_workflow`
    activates. Verified through the full cycle: publish (with a trigger node) → draft edit →
    draft/active version ids diverge while the workflow **stays active on the published
    version**. This is the API-inaccessible draft-first edit.
  - **Merge semantics:** `updateNodeParameters` **merges** into existing params — writing
    `{jsCode}` alone preserves `mode`/`language` and vice versa. Push can send just the code.
  - **Reads are draft-only:** `get_workflow_details` returns the **draft**;
    `get_workflow_version` returns **metadata only** (no node params), so published content is
    not readable via MCP — `restore_workflow_version` is the only path back to it. Pull
    therefore syncs the draft, and a draft-vs-published content diff is not possible over MCP.
  - **Data tables are add-only:** create/rename/add-rows/columns exist, but **no row-read
    tool** — `search_data_tables` returns schema only (verified: inserted rows not readable
    back). Plan 25's rows stay on the public API.
  - **Per-workflow gate:** `search_workflows` lists all workflows; `get_workflow_details`/edit
    require `availableInMCP` (`PATCH /rest/mcp/workflows/toggle-access
    {availableInMCP:true, workflowIds:[…]}`). Independent of auth method.
  - **Node identity:** ops address nodes **by name** (rename is `{renameNode, oldName,
    newName}`; connections are `{addConnection, source, target}`); **node ids survive renames**
    (verified: rename via MCP, id unchanged on the public GET), so decanter's id-keyed
    `.decanter.json` map is the stable anchor (Task 3).
  - **Tool set (33):** incl. `get_workflow_details`, `update_workflow`,
    `create_workflow_from_code`, `publish_workflow`/`unpublish_workflow`,
    `get_workflow_version`/`restore_workflow_version`, `validate_workflow`, `test_workflow`,
    `execute_workflow`, `get_sdk_reference`, data-table + node-search tools.
  - **Residual costs:** version floor (~2.13/2.20), young/evolving tool surface, and the
    per-instance + per-workflow opt-ins above.
